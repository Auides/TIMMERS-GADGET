-- Phase 6 Migration 3: transactional procurement workflows and revision-aware
-- inventory operations.  This migration deliberately contains the complete
-- cut-over: the revision triggers are attached only at its end.

create or replace function public.procurement_lagos_today()
returns date
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select (current_timestamp at time zone 'Africa/Lagos')::date
$$;

create or replace function public.procurement_optional_text(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(btrim(p_value), '')
$$;

create or replace function public.procurement_fingerprint(p_payload jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.encode(extensions.digest(p_payload::text, 'sha256'), 'hex')
$$;

create or replace function public.canonical_procurement_identifiers(p_identifiers jsonb)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'type', (upper(btrim(i.value ->> 'type'))::public.identifier_type)::text,
      'value', public.normalize_identifier_value(i.value ->> 'value')
    )
    order by (upper(btrim(i.value ->> 'type'))::public.identifier_type)::text,
             public.normalize_identifier_value(i.value ->> 'value')
  ), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_identifiers) = 'array'
    then p_identifiers else '[]'::jsonb end) i(value)
$$;

create or replace function public.canonical_purchase_receive_payload(
  p_supplier_id uuid, p_received_on date, p_supplier_reference text, p_notes text,
  p_lines jsonb, p_initial_payments jsonb
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  with lines as (
    select ordinality, value
    from jsonb_array_elements(p_lines) with ordinality
  ), canonical_lines as (
    select ordinality, jsonb_build_object(
      'product_id', (nullif(btrim(value ->> 'product_id'), '')::uuid)::text,
      'variant_id', (nullif(btrim(value ->> 'variant_id'), '')::uuid)::text,
      'condition', (upper(btrim(value ->> 'condition'))::public.product_condition)::text,
      'quantity', nullif(btrim(value ->> 'quantity'), '')::integer,
      'unit_cost', nullif(btrim(value ->> 'unit_cost'), '')::numeric(14,2),
      'notes', public.procurement_optional_text(value ->> 'notes'),
      'serialized_units', coalesce((
        select jsonb_agg(jsonb_build_object(
          'acquisition_cost', nullif(btrim(u.value ->> 'acquisition_cost'), '')::numeric(14,2),
          'condition', (upper(btrim(u.value ->> 'condition'))::public.product_condition)::text,
          'warranty_start', nullif(btrim(u.value ->> 'warranty_start'), '')::date,
          'warranty_expiry', nullif(btrim(u.value ->> 'warranty_expiry'), '')::date,
          'identifiers', public.canonical_procurement_identifiers(u.value -> 'identifiers')
        ) order by jsonb_build_object(
          'acquisition_cost', nullif(btrim(u.value ->> 'acquisition_cost'), '')::numeric(14,2),
          'condition', (upper(btrim(u.value ->> 'condition'))::public.product_condition)::text,
          'warranty_start', nullif(btrim(u.value ->> 'warranty_start'), '')::date,
          'warranty_expiry', nullif(btrim(u.value ->> 'warranty_expiry'), '')::date,
          'identifiers', public.canonical_procurement_identifiers(u.value -> 'identifiers')
        ))
        from jsonb_array_elements(coalesce(value -> 'serialized_units', '[]'::jsonb)) u(value)
      ), '[]'::jsonb)
    ) as payload
    from lines
  ), payments as (
    select jsonb_build_object(
      'amount', nullif(btrim(value ->> 'amount'), '')::numeric(14,2),
      'method', (upper(btrim(value ->> 'method'))::public.supplier_payment_method)::text,
      'paid_on', nullif(btrim(value ->> 'paid_on'), '')::date,
      'reference', public.procurement_optional_text(value ->> 'reference'),
      'notes', public.procurement_optional_text(value ->> 'notes')
    ) as payload
    from jsonb_array_elements(coalesce(p_initial_payments, '[]'::jsonb))
  )
  select jsonb_build_object(
    'supplier_id', p_supplier_id, 'received_on', p_received_on,
    'supplier_reference', public.procurement_optional_text(p_supplier_reference),
    'notes', public.procurement_optional_text(p_notes),
    'lines', coalesce((select jsonb_agg(payload order by ordinality) from canonical_lines), '[]'::jsonb),
    'initial_payments', coalesce((select jsonb_agg(payload order by payload) from payments), '[]'::jsonb)
  )
$$;

create or replace function public.canonical_supplier_return_payload(
  p_purchase_id uuid, p_returned_on date, p_supplier_reference text, p_reason text,
  p_lines jsonb, p_initial_refund_receipts jsonb
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  with lines as (
    select jsonb_build_object(
      'purchase_item_id', (nullif(btrim(value ->> 'purchase_item_id'), '')::uuid)::text,
      'serialized_unit_id', (nullif(btrim(value ->> 'serialized_unit_id'), '')::uuid)::text,
      'quantity', nullif(btrim(value ->> 'quantity'), '')::integer
    ) as payload
    from jsonb_array_elements(p_lines)
  ), receipts as (
    select jsonb_build_object(
      'amount', nullif(btrim(value ->> 'amount'), '')::numeric(14,2),
      'method', (upper(btrim(value ->> 'method'))::public.supplier_payment_method)::text,
      'received_on', nullif(btrim(value ->> 'received_on'), '')::date,
      'reference', public.procurement_optional_text(value ->> 'reference'),
      'notes', public.procurement_optional_text(value ->> 'notes')
    ) as payload
    from jsonb_array_elements(coalesce(p_initial_refund_receipts, '[]'::jsonb))
  )
  select jsonb_build_object(
    'purchase_id', p_purchase_id, 'returned_on', p_returned_on,
    'supplier_reference', public.procurement_optional_text(p_supplier_reference),
    'reason', public.procurement_optional_text(p_reason),
    'lines', coalesce((select jsonb_agg(payload order by payload) from lines), '[]'::jsonb),
    'initial_refund_receipts', coalesce((select jsonb_agg(payload order by payload) from receipts), '[]'::jsonb)
  )
$$;

create or replace function public.canonical_opening_stock_payload(p_notes text, p_lines jsonb)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  with lines as (
    select jsonb_build_object(
      'product_id', (nullif(btrim(value ->> 'product_id'), '')::uuid)::text,
      'variant_id', (nullif(btrim(value ->> 'variant_id'), '')::uuid)::text,
      'condition', (upper(btrim(value ->> 'condition'))::public.product_condition)::text,
      'quantity', nullif(btrim(value ->> 'quantity'), '')::integer,
      'acquisition_cost', nullif(btrim(value ->> 'acquisition_cost'), '')::numeric(14,2),
      'warranty_start', nullif(btrim(value ->> 'warranty_start'), '')::date,
      'warranty_expiry', nullif(btrim(value ->> 'warranty_expiry'), '')::date,
      'identifiers', public.canonical_procurement_identifiers(value -> 'identifiers')
    ) as payload
    from jsonb_array_elements(p_lines)
  )
  select jsonb_build_object('notes', public.procurement_optional_text(p_notes),
    'lines', coalesce((select jsonb_agg(payload order by payload) from lines), '[]'::jsonb))
$$;

create or replace function public.require_procurement_authority(p_admin_only boolean default false)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role public.app_role;
begin
  if v_actor is null then
    raise insufficient_privilege using message = 'An active TIMMERS GADGET profile is required';
  end if;

  select p.role into v_role
  from public.profiles p
  where p.id = v_actor and p.is_active
  for key share;

  if not found then
    raise insufficient_privilege using message = 'An active TIMMERS GADGET profile is required';
  end if;
  if (p_admin_only and v_role <> 'ADMIN')
     or (not p_admin_only and v_role not in ('ADMIN', 'MANAGER')) then
    raise insufficient_privilege using message = case when p_admin_only
      then 'Admin procurement authority is required'
      else 'Admin or Manager procurement authority is required'
    end;
  end if;
  return v_actor;
end
$$;

create or replace function public.procurement_reserve(
  p_request_id uuid,
  p_operation public.procurement_operation_kind,
  p_fingerprint text,
  p_actor uuid
)
returns public.procurement_operation_reservations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_reservation public.procurement_operation_reservations;
begin
  if p_request_id is null then
    raise exception 'A procurement request id is required';
  end if;

  insert into public.procurement_operation_reservations
    (request_id, operation, request_fingerprint, actor_id)
  values (p_request_id, p_operation, p_fingerprint, p_actor)
  on conflict (request_id) do nothing
  returning * into v_reservation;

  if found then
    return v_reservation;
  end if;

  select * into v_reservation
  from public.procurement_operation_reservations r
  where r.request_id = p_request_id
  for update;

  if v_reservation.operation is distinct from p_operation
     or v_reservation.request_fingerprint is distinct from p_fingerprint
     or v_reservation.actor_id is distinct from p_actor then
    raise exception 'Procurement request id was already used for a different submission';
  end if;
  if v_reservation.completed_at is null then
    -- This is unreachable for normal RPC use: failed transactions roll back
    -- their reservation.  It prevents a manually-created partial row from
    -- becoming an implicit, separately committed in-progress operation.
    raise exception 'Procurement request is incomplete and cannot be replayed';
  end if;
  return v_reservation;
end
$$;

create or replace function public.procurement_complete(
  p_request_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.procurement_operation_reservations
  set completed_entity_type = p_entity_type,
      completed_entity_id = p_entity_id,
      result = p_result,
      completed_at = now()
  where request_id = p_request_id
    and completed_at is null;
  if not found then
    raise exception 'Procurement reservation could not be completed';
  end if;
end
$$;

create or replace function public.procurement_audit(
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  insert into public.audit_logs
    (actor_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (p_actor, p_action, p_entity_type, p_entity_id, p_before, p_after,
          coalesce(p_metadata, '{}'::jsonb))
$$;

-- Every operational audit is constructed from immutable rows written by the
-- transaction, never from caller-provided JSON.
create or replace function public.procurement_purchase_audit_evidence(p_purchase_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'purchase', to_jsonb(p),
    'purchase_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purchase_item_id', pi.id, 'line_number', pi.line_number,
        'product_id', pi.product_id, 'variant_id', pi.variant_id,
        'condition', pi.condition, 'quantity', pi.quantity,
        'unit_cost', pi.unit_cost, 'notes', pi.notes,
        'serialized_units', coalesce((
          select jsonb_agg(jsonb_build_object(
            'unit_id', u.id, 'purchase_item_id', u.purchase_item_id,
            'acquisition_cost', u.acquisition_cost, 'condition', u.condition,
            'warranty_start', u.warranty_start, 'warranty_expiry', u.warranty_expiry,
            'identifiers', coalesce((
              select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.normalized_value)
                order by i.identifier_type, i.normalized_value)
              from public.unit_identifiers i where i.unit_id = u.id
            ), '[]'::jsonb)
          ) order by u.id)
          from public.serialized_units u where u.purchase_item_id = pi.id
        ), '[]'::jsonb)
      ) order by pi.line_number)
      from public.purchase_items pi where pi.purchase_id = p.id
    ), '[]'::jsonb),
    'inventory_bucket_effects', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.product_id, e.variant_id nulls first, e.condition)
      from public.inventory_bucket_effects e where e.purchase_id = p.id and e.movement = 'PURCHASE'
    ), '[]'::jsonb),
    'serialized_lifecycle_effects', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.unit_id, e.unit_revision_after)
      from public.serialized_unit_lifecycle_effects e where e.purchase_id = p.id and e.movement = 'PURCHASE'
    ), '[]'::jsonb),
    'supplier_payments', coalesce((
      select jsonb_agg(jsonb_build_object('supplier_payment_id', sp.id, 'amount', sp.amount,
        'method', sp.method, 'paid_on', sp.paid_on, 'reference', sp.reference) order by sp.created_at, sp.id)
      from public.supplier_payments sp where sp.purchase_id = p.id
    ), '[]'::jsonb)
  )
  from public.purchases p where p.id = p_purchase_id
$$;

create or replace function public.procurement_purchase_financial_evidence(p_purchase_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'purchase_id', p.id, 'original_total', p.total,
    'active_return_value', coalesce((select sum(sr.total) from public.supplier_returns sr
      left join public.supplier_return_reversals srr on srr.supplier_return_id = sr.id
      where sr.purchase_id = p.id and srr.id is null), 0),
    'net_supplier_payments', coalesce((select sum(sp.amount) from public.supplier_payments sp
      left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
      where sp.purchase_id = p.id and spr.id is null), 0),
    'purchase_reversed', exists (select 1 from public.purchase_reversals pr where pr.purchase_id = p.id)
  ) from public.purchases p where p.id = p_purchase_id
$$;

create or replace function public.procurement_purchase_reversal_audit_evidence(p_purchase_reversal_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'purchase_reversal', to_jsonb(pr),
    'purchase', to_jsonb(p),
    'restored_inventory_bucket_effects', coalesce((select jsonb_agg(to_jsonb(e)
      order by e.product_id, e.variant_id nulls first, e.condition)
      from public.inventory_bucket_effects e where e.purchase_reversal_id = pr.id), '[]'::jsonb),
    'serialized_lifecycle_effects', coalesce((select jsonb_agg(to_jsonb(e)
      order by e.unit_id, e.unit_revision_after)
      from public.serialized_unit_lifecycle_effects e where e.purchase_reversal_id = pr.id), '[]'::jsonb),
    'automatic_supplier_payment_reversals', coalesce((select jsonb_agg(jsonb_build_object(
      'supplier_payment_reversal_id', spr.id, 'supplier_payment_id', spr.supplier_payment_id,
      'amount', sp.amount) order by spr.created_at, spr.id)
      from public.supplier_payment_reversals spr join public.supplier_payments sp on sp.id = spr.supplier_payment_id
      where spr.purchase_reversal_id = pr.id), '[]'::jsonb)
  ) from public.purchase_reversals pr join public.purchases p on p.id = pr.purchase_id
  where pr.id = p_purchase_reversal_id
$$;

-- D60 is deliberately computed from immutable history.  The ordered window is
-- return_order, never created_at or a UUID.
create or replace function public.supplier_return_refund_entitlements(p_purchase_id uuid)
returns table (
  supplier_return_id uuid,
  return_order bigint,
  original_total numeric(14,2),
  net_supplier_payments numeric(14,2),
  cumulative_before numeric(14,2),
  cumulative_after numeric(14,2),
  refund_entitlement numeric(14,2),
  active_refund_receipts numeric(14,2),
  remaining_refund_due numeric(14,2),
  refund_status text
)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  with active_purchase as (
    select p.id, p.total
    from public.purchases p
    left join public.purchase_reversals pr on pr.purchase_id = p.id
    where p.id = p_purchase_id and pr.id is null
  ), net_payments as (
    select coalesce(sum(sp.amount), 0)::numeric(14,2) as amount
    from public.supplier_payments sp
    left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
    where sp.purchase_id = p_purchase_id and spr.id is null
  ), active_returns as (
    select sr.id, sr.return_order, sr.total,
           coalesce(sum(sr.total) over (
             order by sr.return_order
             rows between unbounded preceding and 1 preceding
           ), 0)::numeric(14,2) as cumulative_before
    from public.supplier_returns sr
    left join public.supplier_return_reversals srr on srr.supplier_return_id = sr.id
    where sr.purchase_id = p_purchase_id and srr.id is null
  ), receipts as (
    select rr.supplier_return_id, coalesce(sum(rr.amount), 0)::numeric(14,2) as amount
    from public.supplier_refund_receipts rr
    left join public.supplier_refund_receipt_reversals rrr
      on rrr.supplier_refund_receipt_id = rr.id
    where rrr.id is null
    group by rr.supplier_return_id
  ), calculated as (
    select ar.id, ar.return_order, ap.total, np.amount as payments,
      ar.cumulative_before,
      (ar.cumulative_before + ar.total)::numeric(14,2) as cumulative_after,
      greatest(np.amount - greatest(ap.total - (ar.cumulative_before + ar.total), 0), 0)
        - greatest(np.amount - greatest(ap.total - ar.cumulative_before, 0), 0) as entitlement,
      coalesce(rc.amount, 0)::numeric(14,2) as receipts
    from active_returns ar
    cross join active_purchase ap
    cross join net_payments np
    left join receipts rc on rc.supplier_return_id = ar.id
  )
  select c.id, c.return_order, c.total, c.payments, c.cumulative_before,
         c.cumulative_after, c.entitlement::numeric(14,2), c.receipts,
         (c.entitlement - c.receipts)::numeric(14,2),
         case when c.entitlement = 0 then 'NO_REFUND_DUE'
              when c.receipts = 0 then 'REFUND_DUE'
              when c.receipts < c.entitlement then 'PARTIALLY_REFUNDED'
              when c.receipts = c.entitlement then 'REFUNDED'
              else null end
  from calculated c
$$;

create or replace function public.assert_purchase_refund_receipts_safe(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (
    select 1
    from public.supplier_return_refund_entitlements(p_purchase_id) e
    where e.active_refund_receipts > e.refund_entitlement
  ) then
    raise exception 'Refund receipts would exceed recalculated entitlement; reverse applicable refund receipts first';
  end if;
end
$$;

-- The final definition can include the derived entitlement function declared
-- immediately above; keeping it here also avoids a forward-reference during
-- migration creation.
create or replace function public.procurement_supplier_return_audit_evidence(p_supplier_return_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'supplier_return', to_jsonb(sr),
    'supplier_return_lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id)
      from public.supplier_return_lines l where l.supplier_return_id = sr.id), '[]'::jsonb),
    'inventory_bucket_effects', coalesce((select jsonb_agg(to_jsonb(e) order by e.product_id, e.variant_id nulls first, e.condition)
      from public.inventory_bucket_effects e where e.supplier_return_id = sr.id), '[]'::jsonb),
    'serialized_lifecycle_effects', coalesce((select jsonb_agg(to_jsonb(e) order by e.unit_id, e.unit_revision_after)
      from public.serialized_unit_lifecycle_effects e where e.supplier_return_id = sr.id), '[]'::jsonb),
    'supplier_refund_receipts', coalesce((select jsonb_agg(jsonb_build_object('supplier_refund_receipt_id', rr.id,
      'amount', rr.amount, 'method', rr.method, 'received_on', rr.received_on, 'reference', rr.reference)
      order by rr.created_at, rr.id) from public.supplier_refund_receipts rr where rr.supplier_return_id = sr.id), '[]'::jsonb),
    'refund_financial_state', coalesce((select to_jsonb(e) from public.supplier_return_refund_entitlements(sr.purchase_id) e
      where e.supplier_return_id = sr.id), '{}'::jsonb)
  ) from public.supplier_returns sr where sr.id = p_supplier_return_id
$$;

create view public.supplier_return_financial_summary
with (security_invoker = true)
as
with active_payments as (
  select sp.purchase_id, coalesce(sum(sp.amount), 0)::numeric(14,2) as net_supplier_payments
  from public.supplier_payments sp
  left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
  where spr.id is null group by sp.purchase_id
), active_returns as (
  select sr.id, sr.purchase_id, sr.return_number, sr.return_order, sr.total,
    coalesce(sum(sr.total) over (partition by sr.purchase_id order by sr.return_order rows between unbounded preceding and 1 preceding), 0)::numeric(14,2) as cumulative_before
  from public.supplier_returns sr
  left join public.supplier_return_reversals srr on srr.supplier_return_id = sr.id
  where srr.id is null
), receipts as (
  select rr.supplier_return_id, coalesce(sum(rr.amount), 0)::numeric(14,2) as active_refund_receipts
  from public.supplier_refund_receipts rr
  left join public.supplier_refund_receipt_reversals rrr on rrr.supplier_refund_receipt_id = rr.id
  where rrr.id is null group by rr.supplier_return_id
), calculated as (
  select ar.*, p.total as original_purchase_total, coalesce(ap.net_supplier_payments, 0)::numeric(14,2) as net_supplier_payments,
    greatest(coalesce(ap.net_supplier_payments, 0) - greatest(p.total - (ar.cumulative_before + ar.total), 0), 0)
      - greatest(coalesce(ap.net_supplier_payments, 0) - greatest(p.total - ar.cumulative_before, 0), 0) as refund_entitlement,
    coalesce(rc.active_refund_receipts, 0)::numeric(14,2) as active_refund_receipts
  from active_returns ar join public.purchases p on p.id = ar.purchase_id
  left join public.purchase_reversals pr on pr.purchase_id = p.id
  left join active_payments ap on ap.purchase_id = p.id
  left join receipts rc on rc.supplier_return_id = ar.id
  where pr.id is null
)
select id as supplier_return_id, purchase_id, return_number, return_order, total as return_value,
  original_purchase_total, net_supplier_payments, refund_entitlement::numeric(14,2),
  active_refund_receipts, (refund_entitlement - active_refund_receipts)::numeric(14,2) as remaining_refund_due,
  case when refund_entitlement = 0 then 'NO_REFUND_DUE'
       when active_refund_receipts = 0 then 'REFUND_DUE'
       when active_refund_receipts < refund_entitlement then 'PARTIALLY_REFUNDED'
       when active_refund_receipts = refund_entitlement then 'REFUNDED'
       else null end as refund_status
from calculated;

create or replace function public.supplier_create(
  p_business_name text,
  p_contact_name text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null,
  p_notes text default null
)
returns public.suppliers
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_supplier public.suppliers;
begin
  if public.procurement_optional_text(p_business_name) is null then
    raise exception 'Supplier business name is required';
  end if;
  insert into public.suppliers(business_name, contact_name, phone, email, address, notes)
  values (btrim(p_business_name), public.procurement_optional_text(p_contact_name),
          public.procurement_optional_text(p_phone), public.procurement_optional_text(p_email),
          public.procurement_optional_text(p_address), public.procurement_optional_text(p_notes))
  returning * into v_supplier;
  perform public.procurement_audit(v_actor, 'SUPPLIER_CREATED', 'SUPPLIER', v_supplier.id,
    null, to_jsonb(v_supplier));
  return v_supplier;
end
$$;

create or replace function public.supplier_update(
  p_supplier_id uuid, p_business_name text, p_contact_name text default null,
  p_phone text default null, p_email text default null, p_address text default null,
  p_notes text default null
)
returns public.suppliers
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_before jsonb; v_supplier public.suppliers;
begin
  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'Supplier does not exist'; end if;
  v_before := to_jsonb(v_supplier);
  if not v_supplier.active and btrim(p_business_name) is distinct from v_supplier.business_name then
    raise exception 'Archived supplier business name cannot be changed';
  end if;
  if v_supplier.active and public.procurement_optional_text(p_business_name) is null then
    raise exception 'Supplier business name is required';
  end if;
  update public.suppliers set
    business_name = case when active then btrim(p_business_name) else business_name end,
    contact_name = public.procurement_optional_text(p_contact_name),
    phone = public.procurement_optional_text(p_phone), email = public.procurement_optional_text(p_email),
    address = public.procurement_optional_text(p_address), notes = public.procurement_optional_text(p_notes)
  where id = p_supplier_id returning * into v_supplier;
  perform public.procurement_audit(v_actor, 'SUPPLIER_UPDATED', 'SUPPLIER', v_supplier.id,
    v_before, to_jsonb(v_supplier));
  return v_supplier;
end
$$;

create or replace function public.supplier_update_archived_contact(
  p_supplier_id uuid, p_contact_name text default null, p_phone text default null,
  p_email text default null, p_address text default null, p_notes text default null
)
returns public.suppliers
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_before jsonb; v_supplier public.suppliers;
begin
  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found or v_supplier.active then raise exception 'Archived supplier contact update requires an archived supplier'; end if;
  v_before := to_jsonb(v_supplier);
  update public.suppliers set contact_name=public.procurement_optional_text(p_contact_name),
    phone=public.procurement_optional_text(p_phone), email=public.procurement_optional_text(p_email),
    address=public.procurement_optional_text(p_address), notes=public.procurement_optional_text(p_notes)
  where id=v_supplier.id returning * into v_supplier;
  perform public.procurement_audit(v_actor,'SUPPLIER_ARCHIVED_CONTACT_UPDATED','SUPPLIER',v_supplier.id,v_before,to_jsonb(v_supplier));
  return v_supplier;
end
$$;

create or replace function public.supplier_archive(p_supplier_id uuid)
returns public.suppliers
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_before jsonb; v_supplier public.suppliers;
begin
  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'Supplier does not exist'; end if;
  if not v_supplier.active then raise exception 'Supplier is already archived'; end if;
  v_before := to_jsonb(v_supplier);
  update public.suppliers set active = false, archived_at = now(), archived_by = v_actor
  where id = p_supplier_id returning * into v_supplier;
  perform public.procurement_audit(v_actor, 'SUPPLIER_ARCHIVED', 'SUPPLIER', v_supplier.id,
    v_before, to_jsonb(v_supplier));
  return v_supplier;
end
$$;

create or replace function public.purchase_receive(
  p_request_id uuid, p_supplier_id uuid, p_received_on date, p_supplier_reference text,
  p_notes text, p_lines jsonb, p_initial_payments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := public.require_procurement_authority();
  v_fingerprint text := public.procurement_fingerprint(
    public.canonical_purchase_receive_payload(
      p_supplier_id, p_received_on, p_supplier_reference, p_notes, p_lines, p_initial_payments));
  v_reservation public.procurement_operation_reservations;
  v_supplier public.suppliers; v_purchase public.purchases; v_item public.purchase_items;
  v_product public.products; v_variant public.product_variants; v_bucket public.stock_buckets;
  v_unit public.serialized_units; v_effect_id uuid; v_movement_id uuid;
  v_line record; v_input jsonb; v_serial_input jsonb; v_identifier jsonb; v_payment jsonb;
  v_product_id uuid; v_variant_id uuid; v_condition public.product_condition;
  v_quantity integer; v_cost numeric(14,2); v_total numeric(14,2) := 0;
  v_payment_total numeric(14,2) := 0; v_identifier_count integer;
  v_before_quantity integer; v_before_wac numeric(14,2); v_before_revision bigint;
  v_new_quantity integer; v_new_wac numeric(14,2); v_result jsonb;
begin
  if p_received_on is null or p_received_on > public.procurement_lagos_today() then
    raise exception 'Purchase received date is required and cannot be in the future';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase receipt requires at least one line';
  end if;
  if jsonb_typeof(coalesce(p_initial_payments, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Initial payments must be an array';
  end if;
  v_reservation := public.procurement_reserve(p_request_id, 'PURCHASE_RECEIPT', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then return v_reservation.result; end if;

  select * into v_supplier from public.suppliers where id = p_supplier_id for update;
  if not found or not v_supplier.active then raise exception 'Purchase receipt requires an active supplier'; end if;

  -- Catalogue locks precede caller-order validation.  This prevents two
  -- receipts with the same products/variants in different line orders from
  -- acquiring their catalogue locks in opposite orders.
  perform 1
  from public.products p
  where p.id = any (array(
    select distinct nullif(btrim(value ->> 'product_id'), '')::uuid
    from jsonb_array_elements(p_lines)
  ))
  order by p.id
  for update;
  perform 1
  from public.product_variants v
  where v.id = any (array(
    select distinct nullif(btrim(value ->> 'variant_id'), '')::uuid
    from jsonb_array_elements(p_lines)
    where nullif(btrim(value ->> 'variant_id'), '') is not null
  ))
  order by v.product_id, v.id
  for update;

  -- Validate and calculate the immutable total before inserting the immutable purchase.
  for v_line in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    v_input := v_line.value;
    if jsonb_typeof(v_input) <> 'object' then raise exception 'Every purchase line must be an object'; end if;
    v_product_id := nullif(btrim(v_input ->> 'product_id'), '')::uuid;
    v_variant_id := nullif(btrim(v_input ->> 'variant_id'), '')::uuid;
    v_condition := upper(btrim(v_input ->> 'condition'))::public.product_condition;
    v_quantity := nullif(btrim(v_input ->> 'quantity'), '')::integer;
    if v_product_id is null or v_quantity is null or v_quantity <= 0 then raise exception 'Purchase line product and positive quantity are required'; end if;
    select * into v_product from public.products where id = v_product_id;
    if not found or not v_product.active then raise exception 'Purchase receipt requires an active product'; end if;
    if v_variant_id is not null then
      select * into v_variant from public.product_variants where id = v_variant_id and product_id = v_product_id;
      if not found or not v_variant.active then raise exception 'Purchase receipt requires an active matching variant'; end if;
    end if;
    if not v_product.serialized then
      v_cost := nullif(btrim(v_input ->> 'unit_cost'), '')::numeric(14,2);
      if v_cost is null or v_cost < 0 or jsonb_array_length(coalesce(v_input -> 'serialized_units', '[]'::jsonb)) <> 0 then
        raise exception 'Non-serialized purchase lines require a non-negative unit cost and no serialized units';
      end if;
      v_total := v_total + v_quantity * v_cost;
    else
      if v_input ? 'unit_cost' and nullif(btrim(v_input ->> 'unit_cost'), '') is not null then
        raise exception 'Serialized purchase item unit cost must be null';
      end if;
      if jsonb_typeof(v_input -> 'serialized_units') is distinct from 'array'
         or jsonb_array_length(v_input -> 'serialized_units') <> v_quantity then
        raise exception 'Serialized purchase quantity must equal the supplied serialized-unit count';
      end if;
      for v_serial_input in select value from jsonb_array_elements(v_input -> 'serialized_units') loop
        v_cost := nullif(btrim(v_serial_input ->> 'acquisition_cost'), '')::numeric(14,2);
        if jsonb_typeof(v_serial_input) <> 'object' or v_cost is null or v_cost < 0
           or upper(btrim(v_serial_input ->> 'condition'))::public.product_condition is distinct from v_condition
           or jsonb_typeof(v_serial_input -> 'identifiers') is distinct from 'array'
           or jsonb_array_length(v_serial_input -> 'identifiers') = 0 then
          raise exception 'Serialized purchase units require cost, matching condition, and identifiers';
        end if;
        if nullif(btrim(v_serial_input ->> 'warranty_expiry'), '')::date < nullif(btrim(v_serial_input ->> 'warranty_start'), '')::date then
          raise exception 'Warranty expiry cannot be earlier than warranty start';
        end if;
        v_total := v_total + v_cost;
      end loop;
    end if;
  end loop;
  for v_payment in select value from jsonb_array_elements(coalesce(p_initial_payments, '[]'::jsonb)) loop
    v_cost := nullif(btrim(v_payment ->> 'amount'), '')::numeric(14,2);
    if jsonb_typeof(v_payment) <> 'object' or v_cost is null or v_cost <= 0
       or nullif(btrim(v_payment ->> 'paid_on'), '')::date is null
       or nullif(btrim(v_payment ->> 'paid_on'), '')::date > public.procurement_lagos_today() then
      raise exception 'Initial supplier payment amount and non-future paid date are required';
    end if;
    perform upper(btrim(v_payment ->> 'method'))::public.supplier_payment_method;
    v_payment_total := v_payment_total + v_cost;
  end loop;
  if v_payment_total > v_total or (v_total = 0 and v_payment_total <> 0) then
    raise exception 'Initial payments cannot exceed the purchase total';
  end if;

  insert into public.purchases(supplier_id, supplier_name_snapshot, received_on, supplier_reference, notes, total, created_by)
  values(p_supplier_id, v_supplier.business_name, p_received_on, public.procurement_optional_text(p_supplier_reference),
         public.procurement_optional_text(p_notes), v_total, v_actor)
  returning * into v_purchase;

  for v_line in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    v_input := v_line.value; v_product_id := (v_input ->> 'product_id')::uuid;
    v_variant_id := nullif(btrim(v_input ->> 'variant_id'), '')::uuid;
    v_condition := upper(btrim(v_input ->> 'condition'))::public.product_condition;
    v_quantity := (v_input ->> 'quantity')::integer;
    select * into v_product from public.products where id = v_product_id;
    insert into public.purchase_items(purchase_id, product_id, variant_id, quantity, unit_cost, line_number, condition, notes)
    values(v_purchase.id, v_product_id, v_variant_id, v_quantity,
      case when v_product.serialized then null else (v_input ->> 'unit_cost')::numeric(14,2) end,
      v_line.ordinality, v_condition, public.procurement_optional_text(v_input ->> 'notes')) returning * into v_item;
  end loop;

  for v_line in
    select pi.product_id, pi.variant_id, pi.condition, sum(pi.quantity)::integer as quantity,
      sum(pi.quantity * pi.unit_cost)::numeric(14,2) as value
    from public.purchase_items pi join public.products p on p.id = pi.product_id
    where pi.purchase_id = v_purchase.id and not p.serialized
    group by pi.product_id, pi.variant_id, pi.condition order by pi.product_id, pi.variant_id nulls first, pi.condition
  loop
    perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s', v_line.product_id, coalesce(v_line.variant_id::text, 'BASE'), v_line.condition::text), 0));
    select * into v_bucket from public.stock_buckets where product_id = v_line.product_id
      and variant_id is not distinct from v_line.variant_id and condition = v_line.condition for update;
    if found then
      v_before_quantity := v_bucket.quantity; v_before_wac := v_bucket.weighted_average_cost; v_before_revision := v_bucket.inventory_revision;
      v_new_quantity := v_before_quantity + v_line.quantity;
      v_new_wac := case when v_before_quantity = 0 then round(v_line.value / v_line.quantity, 2)
        else round(((v_before_quantity * v_before_wac) + v_line.value) / v_new_quantity, 2) end;
      update public.stock_buckets set quantity=v_new_quantity, weighted_average_cost=v_new_wac,
        inventory_revision=v_before_revision+1 where id=v_bucket.id returning * into v_bucket;
    else
      v_before_quantity:=0; v_before_wac:=0; v_before_revision:=0; v_new_quantity:=v_line.quantity;
      v_new_wac:=round(v_line.value / v_line.quantity, 2);
      insert into public.stock_buckets(product_id,variant_id,serialized,condition,quantity,selling_price,weighted_average_cost,inventory_revision)
      values(v_line.product_id,v_line.variant_id,false,v_line.condition,v_new_quantity,null,v_new_wac,1) returning * into v_bucket;
    end if;
    insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,
      quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,purchase_id)
    values('PURCHASE',v_bucket.id,v_line.product_id,v_line.variant_id,v_line.condition,v_before_quantity,v_new_quantity,
      v_before_wac,v_new_wac,v_before_revision,v_before_revision+1,v_purchase.id) returning id into v_effect_id;
    for v_item in select pi.* from public.purchase_items pi join public.products p on p.id=pi.product_id
      where pi.purchase_id=v_purchase.id and not p.serialized and pi.product_id=v_line.product_id
        and pi.variant_id is not distinct from v_line.variant_id and pi.condition=v_line.condition order by pi.line_number loop
      insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,
        condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)
      values(v_item.product_id,v_item.variant_id,v_bucket.id,v_effect_id,'PURCHASE',v_item.quantity,null,v_item.condition,
        v_item.unit_cost,'PURCHASE_ITEM',v_item.id,'Purchase receipt',v_actor);
    end loop;
  end loop;
  -- Nonserialized bucket state is now fully settled.  Resolve each already
  -- created serialized purchase item by its caller-order line number, while
  -- unit/identifier arrays use the canonical deterministic representation.
  for v_line in select value, ordinality from jsonb_array_elements(p_lines) with ordinality loop
    v_input := v_line.value;
    v_product_id := (v_input ->> 'product_id')::uuid;
    select * into v_product from public.products where id = v_product_id;
    if not v_product.serialized then continue; end if;
    select * into v_item from public.purchase_items
    where purchase_id = v_purchase.id and line_number = v_line.ordinality;
    if not found then raise exception 'Purchase item was not created for its receipt line'; end if;
    v_variant_id := v_item.variant_id;
    v_condition := v_item.condition;
    for v_serial_input in
      select value
      from jsonb_array_elements(v_input -> 'serialized_units')
      order by jsonb_build_object(
        'acquisition_cost', nullif(btrim(value ->> 'acquisition_cost'), '')::numeric(14,2),
        'condition', (upper(btrim(value ->> 'condition'))::public.product_condition)::text,
        'warranty_start', nullif(btrim(value ->> 'warranty_start'), '')::date,
        'warranty_expiry', nullif(btrim(value ->> 'warranty_expiry'), '')::date,
        'identifiers', public.canonical_procurement_identifiers(value -> 'identifiers')
      )
    loop
      v_cost := (v_serial_input ->> 'acquisition_cost')::numeric(14,2);
      insert into public.serialized_units(product_id, variant_id, purchase_item_id, condition, status,
        current_selling_price, acquisition_cost, warranty_start, warranty_expiry, lifecycle_revision)
      values(v_product_id, v_variant_id, v_item.id, v_condition, 'AVAILABLE', null, v_cost,
        nullif(btrim(v_serial_input ->> 'warranty_start'), '')::date,
        nullif(btrim(v_serial_input ->> 'warranty_expiry'), '')::date, 1) returning * into v_unit;
      v_identifier_count := 0;
      for v_identifier in
        select value from jsonb_array_elements(v_serial_input -> 'identifiers')
        order by (upper(btrim(value ->> 'type'))::public.identifier_type)::text,
                 public.normalize_identifier_value(value ->> 'value')
      loop
        insert into public.unit_identifiers(unit_id, identifier_type, normalized_value)
        values(v_unit.id, upper(btrim(v_identifier ->> 'type'))::public.identifier_type,
               public.normalize_identifier_value(v_identifier ->> 'value'));
        v_identifier_count := v_identifier_count + 1;
      end loop;
      if v_identifier_count = 0 then raise exception 'Every serialized unit requires an identifier'; end if;
      insert into public.inventory_movements(product_id, variant_id, unit_id, movement, quantity,
        condition_before, condition_after, unit_cost, reference_type, reference_id, reason, performed_by)
      values(v_product_id, v_variant_id, v_unit.id, 'PURCHASE', 1, null, v_condition, v_cost,
        'PURCHASE_ITEM', v_item.id, 'Purchase receipt', v_actor) returning id into v_movement_id;
      insert into public.serialized_unit_lifecycle_effects(movement, unit_id, movement_id, status_before,
        status_after, condition_before, condition_after, unit_revision_before, unit_revision_after,
        purchase_id, purchase_item_id)
      values('PURCHASE', v_unit.id, v_movement_id, null, 'AVAILABLE', null, v_condition, 0, 1,
        v_purchase.id, v_item.id);
    end loop;
  end loop;
  for v_payment in select value from jsonb_array_elements(coalesce(p_initial_payments, '[]'::jsonb)) loop
    insert into public.supplier_payments(purchase_id,amount,method,paid_on,reference,notes,recorded_by)
    values(v_purchase.id,(v_payment ->> 'amount')::numeric(14,2),upper(btrim(v_payment ->> 'method'))::public.supplier_payment_method,
      (v_payment ->> 'paid_on')::date,public.procurement_optional_text(v_payment ->> 'reference'),
      public.procurement_optional_text(v_payment ->> 'notes'),v_actor);
  end loop;
  v_result := jsonb_build_object('purchase_id',v_purchase.id,'purchase_number',v_purchase.purchase_number,'idempotent_replay',false);
  perform public.procurement_complete(p_request_id,'PURCHASE',v_purchase.id,v_result);
  perform public.procurement_audit(v_actor,'PURCHASE_RECEIVED','PURCHASE',v_purchase.id,null,
    public.procurement_purchase_audit_evidence(v_purchase.id),jsonb_build_object('request_id',p_request_id));
  return v_result;
end
$$;

create or replace function public.supplier_record_payment(
  p_request_id uuid, p_purchase_id uuid, p_amount numeric,
  p_method public.supplier_payment_method, p_paid_on date, p_reference text, p_notes text
)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_purchase public.purchases; v_supplier public.suppliers; v_supplier_id uuid;
  v_payment public.supplier_payments; v_res public.procurement_operation_reservations;
  v_fingerprint text := public.procurement_fingerprint(jsonb_build_object('purchase_id',p_purchase_id,'amount',p_amount::numeric(14,2),'method',p_method,'paid_on',p_paid_on,'reference',public.procurement_optional_text(p_reference),'notes',public.procurement_optional_text(p_notes)));
  v_remaining numeric(14,2); v_result jsonb;
begin
  if p_amount is null or p_amount <= 0 or p_paid_on is null or p_paid_on > public.procurement_lagos_today() then raise exception 'Supplier payment amount and non-future paid date are required'; end if;
  v_res := public.procurement_reserve(p_request_id,'SUPPLIER_PAYMENT',v_fingerprint,v_actor);
  if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id into v_supplier_id from public.purchases p where p.id=p_purchase_id;
  if not found then raise exception 'Supplier payment requires an active purchase'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Supplier payment requires an active purchase'; end if;
  select p.* into v_purchase from public.purchases p where p.id=p_purchase_id for update;
  if not found or v_purchase.supplier_id is distinct from v_supplier.id
     or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase.id) then raise exception 'Supplier payment requires an active purchase'; end if;
  select greatest(v_purchase.total - coalesce((select sum(sr.total) from public.supplier_returns sr left join public.supplier_return_reversals srr on srr.supplier_return_id=sr.id where sr.purchase_id=v_purchase.id and srr.id is null),0) - coalesce((select sum(sp.amount) from public.supplier_payments sp left join public.supplier_payment_reversals spr on spr.supplier_payment_id=sp.id where sp.purchase_id=v_purchase.id and spr.id is null),0),0)::numeric(14,2) into v_remaining;
  if v_remaining = 0 or p_amount > v_remaining then raise exception 'Supplier payment exceeds current remaining payable'; end if;
  insert into public.supplier_payments(purchase_id,amount,method,paid_on,reference,notes,recorded_by)
  values(v_purchase.id,p_amount,p_method,p_paid_on,public.procurement_optional_text(p_reference),public.procurement_optional_text(p_notes),v_actor) returning * into v_payment;
  perform public.assert_purchase_refund_receipts_safe(v_purchase.id);
  v_result:=jsonb_build_object('supplier_payment_id',v_payment.id,'purchase_id',v_purchase.id,'idempotent_replay',false);
  perform public.procurement_complete(p_request_id,'SUPPLIER_PAYMENT',v_payment.id,v_result);
  perform public.procurement_audit(v_actor,'SUPPLIER_PAYMENT_RECORDED','SUPPLIER_PAYMENT',v_payment.id,null,
    to_jsonb(v_payment) || jsonb_build_object('financial_state',public.procurement_purchase_financial_evidence(v_purchase.id)),
    jsonb_build_object('request_id',p_request_id,'purchase_id',v_purchase.id,'amount',v_payment.amount,'method',v_payment.method,'paid_on',v_payment.paid_on,'reference',v_payment.reference));
  return v_result;
end $$;

create or replace function public.supplier_record_refund_receipt(
  p_request_id uuid, p_supplier_return_id uuid, p_amount numeric,
  p_method public.supplier_payment_method, p_received_on date, p_reference text, p_notes text
)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := public.require_procurement_authority(); v_return public.supplier_returns; v_supplier public.suppliers; v_supplier_id uuid; v_purchase_id uuid;
  v_receipt public.supplier_refund_receipts; v_res public.procurement_operation_reservations;
  v_fingerprint text := public.procurement_fingerprint(jsonb_build_object('supplier_return_id',p_supplier_return_id,'amount',p_amount::numeric(14,2),'method',p_method,'received_on',p_received_on,'reference',public.procurement_optional_text(p_reference),'notes',public.procurement_optional_text(p_notes)));
  v_entitlement numeric(14,2); v_receipts numeric(14,2); v_result jsonb;
begin
  if p_amount is null or p_amount<=0 or p_received_on is null or p_received_on>public.procurement_lagos_today() then raise exception 'Refund receipt amount and non-future received date are required'; end if;
  v_res:=public.procurement_reserve(p_request_id,'SUPPLIER_REFUND_RECEIPT',v_fingerprint,v_actor); if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id, p.id into v_supplier_id, v_purchase_id
  from public.supplier_returns sr join public.purchases p on p.id=sr.purchase_id
  where sr.id=p_supplier_return_id;
  if not found then raise exception 'Supplier return does not exist'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Refund receipt requires an active supplier return and purchase'; end if;
  perform 1 from public.purchases p where p.id=v_purchase_id and p.supplier_id=v_supplier.id for update;
  if not found or exists (select 1 from public.supplier_return_reversals srr where srr.supplier_return_id=p_supplier_return_id)
     or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase_id) then
    raise exception 'Refund receipt requires an active supplier return and purchase';
  end if;
  select sr.* into v_return from public.supplier_returns sr where sr.id=p_supplier_return_id for update;
  if not found or v_return.purchase_id is distinct from v_purchase_id then raise exception 'Refund receipt requires an active supplier return and purchase'; end if;
  select refund_entitlement,active_refund_receipts into v_entitlement,v_receipts from public.supplier_return_refund_entitlements(v_return.purchase_id) where supplier_return_id=v_return.id;
  if v_entitlement is null or v_entitlement=0 or v_receipts+p_amount>v_entitlement then raise exception 'Refund receipt exceeds current refund entitlement'; end if;
  insert into public.supplier_refund_receipts(supplier_return_id,amount,method,received_on,reference,notes,received_by) values(v_return.id,p_amount,p_method,p_received_on,public.procurement_optional_text(p_reference),public.procurement_optional_text(p_notes),v_actor) returning * into v_receipt;
  v_result:=jsonb_build_object('supplier_refund_receipt_id',v_receipt.id,'supplier_return_id',v_return.id,'idempotent_replay',false);
  perform public.procurement_complete(p_request_id,'SUPPLIER_REFUND_RECEIPT',v_receipt.id,v_result);
  perform public.procurement_audit(v_actor,'SUPPLIER_REFUND_RECEIPT_RECORDED','SUPPLIER_REFUND_RECEIPT',v_receipt.id,null,
    to_jsonb(v_receipt) || jsonb_build_object('supplier_return_state',public.procurement_supplier_return_audit_evidence(v_return.id)),
    jsonb_build_object('request_id',p_request_id,'supplier_return_id',v_return.id,'amount',v_receipt.amount,'method',v_receipt.method,'received_on',v_receipt.received_on,'reference',v_receipt.reference));
  return v_result;
end $$;

create or replace function public.supplier_finalize_return(
  p_request_id uuid, p_purchase_id uuid, p_returned_on date, p_supplier_reference text,
  p_reason text, p_lines jsonb, p_initial_refund_receipts jsonb
)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid:=public.require_procurement_authority(); v_purchase public.purchases; v_supplier public.suppliers; v_supplier_id uuid; v_return public.supplier_returns;
  v_item public.purchase_items; v_product public.products; v_unit public.serialized_units; v_bucket public.stock_buckets;
  v_line record; v_input jsonb; v_receipt jsonb; v_return_line public.supplier_return_lines;
  v_res public.procurement_operation_reservations; v_fingerprint text:=public.procurement_fingerprint(public.canonical_supplier_return_payload(p_purchase_id,p_returned_on,p_supplier_reference,p_reason,p_lines,p_initial_refund_receipts));
  v_total numeric(14,2):=0; v_cost numeric(14,2); v_quantity integer; v_effect uuid; v_movement uuid;
  v_before_q integer; v_before_wac numeric(14,2); v_before_revision bigint; v_result jsonb; v_entitlement numeric(14,2); v_receipts numeric(14,2);
begin
  if p_returned_on is null or p_returned_on>public.procurement_lagos_today() or public.procurement_optional_text(p_reason) is null then raise exception 'Supplier return requires a non-future date and reason'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Supplier return requires at least one line'; end if;
  if jsonb_typeof(coalesce(p_initial_refund_receipts,'[]'::jsonb)) is distinct from 'array' then raise exception 'Initial refund receipts must be an array'; end if;
  v_res:=public.procurement_reserve(p_request_id,'SUPPLIER_RETURN',v_fingerprint,v_actor); if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id into v_supplier_id from public.purchases p where p.id=p_purchase_id;
  if not found then raise exception 'Supplier return requires an active purchase'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Supplier return requires an active purchase'; end if;
  select p.* into v_purchase from public.purchases p where p.id=p_purchase_id for update;
  if not found or v_purchase.supplier_id is distinct from v_supplier.id
     or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase.id) then raise exception 'Supplier return requires an active purchase'; end if;
  -- Resolve structural sources and immutable serialized valuation without
  -- acquiring serialized-unit locks in caller line order.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_input:=v_line.value; v_quantity:=nullif(btrim(v_input->>'quantity'),'')::integer;
    if jsonb_typeof(v_input)<>'object' or v_quantity is null or v_quantity<=0 or nullif(btrim(v_input->>'purchase_item_id'),'') is null then raise exception 'Return line purchase item and positive quantity are required'; end if;
    select pi.* into v_item from public.purchase_items pi where pi.id=(v_input->>'purchase_item_id')::uuid and pi.purchase_id=v_purchase.id for key share;
    select p.* into v_product from public.products p where p.id=v_item.product_id for key share;
    if not found then raise exception 'Supplier return item must belong to the purchase'; end if;
    if v_product.serialized then
      if v_quantity<>1 or nullif(btrim(v_input->>'serialized_unit_id'),'') is null then raise exception 'Serialized return requires one selected unit'; end if;
      select * into v_unit from public.serialized_units where id=(v_input->>'serialized_unit_id')::uuid;
      if not found or v_unit.purchase_item_id is distinct from v_item.id then raise exception 'Serialized return requires an available exact purchase unit'; end if;
      v_cost:=v_unit.acquisition_cost;
    else
      if v_input ? 'serialized_unit_id' and public.procurement_optional_text(v_input->>'serialized_unit_id') is not null or v_item.unit_cost is null then raise exception 'Non-serialized return cannot select a unit'; end if;
      v_cost:=v_item.unit_cost;
    end if;
    v_total:=v_total+v_quantity*v_cost;
  end loop;
  insert into public.supplier_returns(purchase_id,return_order,supplier_reference,returned_on,reason,total,completed_by)
  values(v_purchase.id,(select coalesce(max(return_order),0)+1 from public.supplier_returns where purchase_id=v_purchase.id),public.procurement_optional_text(p_supplier_reference),p_returned_on,btrim(p_reason),v_total,v_actor) returning * into v_return;
  -- Insert nonserialized source lines before obtaining their exact bucket
  -- locks.  The bucket loop below acquires every bucket in one business-key
  -- order before any serialized-unit lock is taken.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_input:=v_line.value; v_quantity:=(v_input->>'quantity')::integer;
    select pi.* into v_item from public.purchase_items pi where pi.id=(v_input->>'purchase_item_id')::uuid for key share;
    select p.* into v_product from public.products p where p.id=v_item.product_id for key share;
    if v_product.serialized then continue; end if;
    v_cost:=v_item.unit_cost;
    insert into public.supplier_return_lines(supplier_return_id,purchase_item_id,serialized_unit_id,quantity,source_unit_cost,return_value)
    values(v_return.id,v_item.id,null,v_quantity,v_cost,v_quantity*v_cost) returning * into v_return_line;
    if (select coalesce(sum(srl.quantity),0) from public.supplier_return_lines srl join public.supplier_returns sr on sr.id=srl.supplier_return_id left join public.supplier_return_reversals srr on srr.supplier_return_id=sr.id where srl.purchase_item_id=v_item.id and srr.id is null)>v_item.quantity then raise exception 'Return quantity exceeds original purchase quantity'; end if;
  end loop;
  for v_line in select pi.product_id,pi.variant_id,pi.condition,sum(srl.quantity)::integer quantity from public.supplier_return_lines srl join public.purchase_items pi on pi.id=srl.purchase_item_id join public.products p on p.id=pi.product_id where srl.supplier_return_id=v_return.id and not p.serialized group by pi.product_id,pi.variant_id,pi.condition order by pi.product_id,pi.variant_id nulls first,pi.condition loop
    perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s',v_line.product_id,coalesce(v_line.variant_id::text,'BASE'),v_line.condition::text),0));
    select * into v_bucket from public.stock_buckets where product_id=v_line.product_id and variant_id is not distinct from v_line.variant_id and condition=v_line.condition for update;
    if not found or v_bucket.quantity<v_line.quantity then raise exception 'Supplier return exceeds current exact stock bucket quantity'; end if;
    v_before_q:=v_bucket.quantity;v_before_wac:=v_bucket.weighted_average_cost;v_before_revision:=v_bucket.inventory_revision;
    update public.stock_buckets set quantity=v_before_q-v_line.quantity,inventory_revision=v_before_revision+1 where id=v_bucket.id returning * into v_bucket;
    insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,purchase_id,supplier_return_id) values('SUPPLIER_RETURN',v_bucket.id,v_line.product_id,v_line.variant_id,v_line.condition,v_before_q,v_bucket.quantity,v_before_wac,v_before_wac,v_before_revision,v_before_revision+1,v_purchase.id,v_return.id) returning id into v_effect;
    for v_return_line in select srl.* from public.supplier_return_lines srl join public.purchase_items pi on pi.id=srl.purchase_item_id where srl.supplier_return_id=v_return.id and pi.product_id=v_line.product_id and pi.variant_id is not distinct from v_line.variant_id and pi.condition=v_line.condition and srl.serialized_unit_id is null loop
      select * into v_item from public.purchase_items where id=v_return_line.purchase_item_id;
      insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_item.product_id,v_item.variant_id,v_bucket.id,v_effect,'SUPPLIER_RETURN',-v_return_line.quantity,v_item.condition,v_item.condition,v_before_wac,'SUPPLIER_RETURN_LINE',v_return_line.id,'Supplier return',v_actor);
    end loop;
  end loop;
  -- Lock every selected serialized unit once, in UUID order, before the
  -- return-line trigger can touch any unit.
  for v_unit in
    select u.* from public.serialized_units u
    where u.id = any (array(
      select distinct nullif(btrim(value->>'serialized_unit_id'),'')::uuid
      from jsonb_array_elements(p_lines)
      where nullif(btrim(value->>'serialized_unit_id'),'') is not null
    ))
    order by u.id
    for update
  loop
    null;
  end loop;
  -- Revalidate each selected unit only after all unit locks are held.  UUID
  -- ordering here preserves that lock order through source-line insertion.
  for v_line in
    select value from jsonb_array_elements(p_lines)
    where nullif(btrim(value->>'serialized_unit_id'),'') is not null
    order by nullif(btrim(value->>'serialized_unit_id'),'')::uuid
  loop
    v_input:=v_line.value; v_quantity:=(v_input->>'quantity')::integer;
    select pi.* into v_item from public.purchase_items pi where pi.id=(v_input->>'purchase_item_id')::uuid for key share;
    select p.* into v_product from public.products p where p.id=v_item.product_id for key share;
    if not v_product.serialized or v_quantity <> 1 then raise exception 'Serialized return requires one selected unit'; end if;
    select * into v_unit from public.serialized_units where id=(v_input->>'serialized_unit_id')::uuid;
    if not found or v_unit.purchase_item_id is distinct from v_item.id or v_unit.status <> 'AVAILABLE' then raise exception 'Serialized return requires an available exact purchase unit'; end if;
    v_cost:=v_unit.acquisition_cost;
    insert into public.supplier_return_lines(supplier_return_id,purchase_item_id,serialized_unit_id,quantity,source_unit_cost,return_value)
    values(v_return.id,v_item.id,v_unit.id,1,v_cost,v_cost) returning * into v_return_line;
    update public.serialized_units set status='RETURNED_TO_SUPPLIER',lifecycle_revision=v_unit.lifecycle_revision+1 where id=v_unit.id returning * into v_unit;
    insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_unit.product_id,v_unit.variant_id,v_unit.id,'SUPPLIER_RETURN',-1,v_unit.condition,v_unit.condition,v_unit.acquisition_cost,'SUPPLIER_RETURN_LINE',v_return_line.id,'Supplier return',v_actor) returning id into v_movement;
    insert into public.serialized_unit_lifecycle_effects(movement,unit_id,movement_id,status_before,status_after,condition_before,condition_after,unit_revision_before,unit_revision_after,purchase_id,purchase_item_id,supplier_return_id,supplier_return_line_id) values('SUPPLIER_RETURN',v_unit.id,v_movement,'AVAILABLE','RETURNED_TO_SUPPLIER',v_unit.condition,v_unit.condition,v_unit.lifecycle_revision-1,v_unit.lifecycle_revision,v_purchase.id,v_item.id,v_return.id,v_return_line.id);
  end loop;
  for v_receipt in select value from jsonb_array_elements(coalesce(p_initial_refund_receipts,'[]'::jsonb)) loop
    v_cost:=nullif(btrim(v_receipt->>'amount'),'')::numeric(14,2); if v_cost is null or v_cost<=0 or nullif(btrim(v_receipt->>'received_on'),'')::date is null or nullif(btrim(v_receipt->>'received_on'),'')::date>public.procurement_lagos_today() then raise exception 'Initial refund receipt amount and date are required'; end if;
    select refund_entitlement,active_refund_receipts into v_entitlement,v_receipts from public.supplier_return_refund_entitlements(v_purchase.id) where supplier_return_id=v_return.id;
    if v_entitlement=0 or v_receipts+v_cost>v_entitlement then raise exception 'Initial refund receipt exceeds entitlement'; end if;
    insert into public.supplier_refund_receipts(supplier_return_id,amount,method,received_on,reference,notes,received_by) values(v_return.id,v_cost,upper(btrim(v_receipt->>'method'))::public.supplier_payment_method,(v_receipt->>'received_on')::date,public.procurement_optional_text(v_receipt->>'reference'),public.procurement_optional_text(v_receipt->>'notes'),v_actor);
  end loop;
  v_result:=jsonb_build_object('supplier_return_id',v_return.id,'return_number',v_return.return_number,'idempotent_replay',false); perform public.procurement_complete(p_request_id,'SUPPLIER_RETURN',v_return.id,v_result); perform public.procurement_audit(v_actor,'SUPPLIER_RETURN_FINALIZED','SUPPLIER_RETURN',v_return.id,null,public.procurement_supplier_return_audit_evidence(v_return.id),jsonb_build_object('request_id',p_request_id)); return v_result;
end $$;

create or replace function public.supplier_reverse_payment(p_request_id uuid, p_supplier_payment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid:=public.require_procurement_authority(true); v_payment public.supplier_payments; v_supplier public.suppliers; v_supplier_id uuid; v_purchase_id uuid; v_reversal public.supplier_payment_reversals; v_res public.procurement_operation_reservations; v_fp text:=public.procurement_fingerprint(jsonb_build_object('supplier_payment_id',p_supplier_payment_id,'reason',public.procurement_optional_text(p_reason))); v_result jsonb;
begin
  if public.procurement_optional_text(p_reason) is null then raise exception 'Supplier payment reversal reason is required'; end if;
  v_res:=public.procurement_reserve(p_request_id,'SUPPLIER_PAYMENT_REVERSAL',v_fp,v_actor); if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id, p.id into v_supplier_id, v_purchase_id
  from public.supplier_payments sp join public.purchases p on p.id=sp.purchase_id
  where sp.id=p_supplier_payment_id;
  if not found then raise exception 'Supplier payment does not exist'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Supplier payment must be active and its purchase unreversed'; end if;
  perform 1 from public.purchases where id=v_purchase_id and supplier_id=v_supplier.id for update;
  if not found or exists (select 1 from public.supplier_payment_reversals spr where spr.supplier_payment_id=p_supplier_payment_id)
     or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase_id) then
    raise exception 'Supplier payment must be active and its purchase unreversed';
  end if;
  select sp.* into v_payment from public.supplier_payments sp where sp.id=p_supplier_payment_id for update;
  if not found or v_payment.purchase_id is distinct from v_purchase_id then raise exception 'Supplier payment must be active and its purchase unreversed'; end if;
  insert into public.supplier_payment_reversals(supplier_payment_id,purchase_reversal_id,reason,reversed_by) values(v_payment.id,null,btrim(p_reason),v_actor) returning * into v_reversal;
  perform public.assert_purchase_refund_receipts_safe(v_payment.purchase_id);
  v_result:=jsonb_build_object('supplier_payment_reversal_id',v_reversal.id,'idempotent_replay',false); perform public.procurement_complete(p_request_id,'SUPPLIER_PAYMENT_REVERSAL',v_reversal.id,v_result); perform public.procurement_audit(v_actor,'SUPPLIER_PAYMENT_REVERSED','SUPPLIER_PAYMENT_REVERSAL',v_reversal.id,to_jsonb(v_payment),to_jsonb(v_reversal) || jsonb_build_object('financial_state',public.procurement_purchase_financial_evidence(v_payment.purchase_id)),jsonb_build_object('request_id',p_request_id,'purchase_id',v_payment.purchase_id,'supplier_payment_id',v_payment.id,'amount',v_payment.amount,'reason',v_reversal.reason,'refund_safety_verified',true)); return v_result;
end $$;

create or replace function public.supplier_reverse_refund_receipt(p_request_id uuid, p_supplier_refund_receipt_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid:=public.require_procurement_authority(true); v_receipt public.supplier_refund_receipts; v_supplier public.suppliers; v_supplier_id uuid; v_purchase_id uuid; v_return_id uuid; v_reversal public.supplier_refund_receipt_reversals; v_res public.procurement_operation_reservations; v_fp text:=public.procurement_fingerprint(jsonb_build_object('supplier_refund_receipt_id',p_supplier_refund_receipt_id,'reason',public.procurement_optional_text(p_reason))); v_result jsonb;
begin
  if public.procurement_optional_text(p_reason) is null then raise exception 'Refund receipt reversal reason is required'; end if;
  v_res:=public.procurement_reserve(p_request_id,'SUPPLIER_REFUND_RECEIPT_REVERSAL',v_fp,v_actor); if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id, p.id, sr.id into v_supplier_id, v_purchase_id, v_return_id
  from public.supplier_refund_receipts rr
  join public.supplier_returns sr on sr.id=rr.supplier_return_id
  join public.purchases p on p.id=sr.purchase_id
  where rr.id=p_supplier_refund_receipt_id;
  if not found then raise exception 'Refund receipt does not exist'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Refund receipt is already reversed or does not exist'; end if;
  perform 1 from public.purchases p where p.id=v_purchase_id and p.supplier_id=v_supplier.id for update;
  if not found or exists (select 1 from public.supplier_refund_receipt_reversals rrr where rrr.supplier_refund_receipt_id=p_supplier_refund_receipt_id) then raise exception 'Refund receipt is already reversed or does not exist'; end if;
  select rr.* into v_receipt from public.supplier_refund_receipts rr where rr.id=p_supplier_refund_receipt_id for update;
  if not found or v_receipt.supplier_return_id is distinct from v_return_id then raise exception 'Refund receipt is already reversed or does not exist'; end if;
  insert into public.supplier_refund_receipt_reversals(supplier_refund_receipt_id,reason,reversed_by) values(v_receipt.id,btrim(p_reason),v_actor) returning * into v_reversal;
  v_result:=jsonb_build_object('supplier_refund_receipt_reversal_id',v_reversal.id,'idempotent_replay',false); perform public.procurement_complete(p_request_id,'SUPPLIER_REFUND_RECEIPT_REVERSAL',v_reversal.id,v_result); perform public.procurement_audit(v_actor,'SUPPLIER_REFUND_RECEIPT_REVERSED','SUPPLIER_REFUND_RECEIPT_REVERSAL',v_reversal.id,to_jsonb(v_receipt),to_jsonb(v_reversal) || jsonb_build_object('supplier_return_state',public.procurement_supplier_return_audit_evidence(v_receipt.supplier_return_id)),jsonb_build_object('request_id',p_request_id,'supplier_return_id',v_receipt.supplier_return_id,'supplier_refund_receipt_id',v_receipt.id,'amount',v_receipt.amount,'reason',v_reversal.reason)); return v_result;
end $$;

create or replace function public.supplier_reverse_return(p_request_id uuid, p_supplier_return_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid:=public.require_procurement_authority(true); v_return public.supplier_returns; v_supplier public.suppliers; v_supplier_id uuid; v_purchase_id uuid; v_reversal public.supplier_return_reversals; v_res public.procurement_operation_reservations; v_fp text:=public.procurement_fingerprint(jsonb_build_object('supplier_return_id',p_supplier_return_id,'reason',public.procurement_optional_text(p_reason))); v_result jsonb; v_effect public.inventory_bucket_effects; v_bucket public.stock_buckets; v_line public.supplier_return_lines; v_unit public.serialized_units; v_move uuid; v_effect_id uuid; v_item public.purchase_items;
begin
  if public.procurement_optional_text(p_reason) is null then raise exception 'Supplier return reversal reason is required'; end if;
  v_res:=public.procurement_reserve(p_request_id,'SUPPLIER_RETURN_REVERSAL',v_fp,v_actor); if v_res.completed_at is not null then return v_res.result; end if;
  select p.supplier_id, p.id into v_supplier_id, v_purchase_id
  from public.supplier_returns sr join public.purchases p on p.id=sr.purchase_id
  where sr.id=p_supplier_return_id;
  if not found then raise exception 'Supplier return does not exist'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Supplier return must be active and its purchase unreversed'; end if;
  perform 1 from public.purchases where id=v_purchase_id and supplier_id=v_supplier.id for update;
  if not found or exists (select 1 from public.supplier_return_reversals srr where srr.supplier_return_id=p_supplier_return_id)
     or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase_id) then raise exception 'Supplier return must be active and its purchase unreversed'; end if;
  select sr.* into v_return from public.supplier_returns sr where sr.id=p_supplier_return_id for update;
  if not found or v_return.purchase_id is distinct from v_purchase_id then raise exception 'Supplier return must be active and its purchase unreversed'; end if;
  if exists(select 1 from public.supplier_refund_receipts rr left join public.supplier_refund_receipt_reversals rrr on rrr.supplier_refund_receipt_id=rr.id where rr.supplier_return_id=v_return.id and rrr.id is null) then raise exception 'Reverse active refund receipts before reversing a supplier return'; end if;
  insert into public.supplier_return_reversals(supplier_return_id,reason,reversed_by) values(v_return.id,btrim(p_reason),v_actor) returning * into v_reversal;
  for v_effect in select * from public.inventory_bucket_effects where supplier_return_id=v_return.id and movement='SUPPLIER_RETURN' order by product_id,variant_id nulls first,condition for update loop
    select * into v_bucket from public.stock_buckets where id=v_effect.stock_bucket_id for update;
    if v_bucket.inventory_revision<>v_effect.revision_after or v_bucket.quantity<>v_effect.quantity_after or v_bucket.weighted_average_cost<>v_effect.wac_after then raise exception 'Later bucket movement blocks supplier return reversal'; end if;
    update public.stock_buckets set quantity=v_effect.quantity_before,weighted_average_cost=v_effect.wac_before,inventory_revision=v_effect.revision_after+1 where id=v_bucket.id returning * into v_bucket;
    insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,purchase_id,supplier_return_id,supplier_return_reversal_id) values('SUPPLIER_RETURN_REVERSAL',v_bucket.id,v_effect.product_id,v_effect.variant_id,v_effect.condition,v_effect.quantity_after,v_effect.quantity_before,v_effect.wac_after,v_effect.wac_before,v_effect.revision_after,v_effect.revision_after+1,v_return.purchase_id,v_return.id,v_reversal.id) returning id into v_effect_id;
    for v_line in select srl.* from public.supplier_return_lines srl join public.purchase_items pi on pi.id=srl.purchase_item_id where srl.supplier_return_id=v_return.id and srl.serialized_unit_id is null and pi.product_id=v_effect.product_id and pi.variant_id is not distinct from v_effect.variant_id and pi.condition=v_effect.condition loop
      select * into v_item from public.purchase_items where id=v_line.purchase_item_id;
      insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_item.product_id,v_item.variant_id,v_bucket.id,v_effect_id,'SUPPLIER_RETURN_REVERSAL',v_line.quantity,v_item.condition,v_item.condition,v_effect.wac_before,'SUPPLIER_RETURN_REVERSAL',v_reversal.id,'Supplier return reversal',v_actor);
    end loop;
  end loop;
  for v_line in select * from public.supplier_return_lines where supplier_return_id=v_return.id and serialized_unit_id is not null order by serialized_unit_id loop
    select * into v_unit from public.serialized_units where id=v_line.serialized_unit_id for update;
    if v_unit.status<>'RETURNED_TO_SUPPLIER' or not exists(select 1 from public.serialized_unit_lifecycle_effects e where e.unit_id=v_unit.id and e.movement='SUPPLIER_RETURN' and e.unit_revision_after=v_unit.lifecycle_revision and e.supplier_return_line_id=v_line.id) then raise exception 'Later lifecycle transition blocks supplier return reversal'; end if;
    update public.serialized_units set status='AVAILABLE',lifecycle_revision=v_unit.lifecycle_revision+1 where id=v_unit.id returning * into v_unit;
    insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_unit.product_id,v_unit.variant_id,v_unit.id,'SUPPLIER_RETURN_REVERSAL',1,v_unit.condition,v_unit.condition,v_unit.acquisition_cost,'SUPPLIER_RETURN_REVERSAL',v_reversal.id,'Supplier return reversal',v_actor) returning id into v_move;
    insert into public.serialized_unit_lifecycle_effects(movement,unit_id,movement_id,status_before,status_after,condition_before,condition_after,unit_revision_before,unit_revision_after,purchase_id,purchase_item_id,supplier_return_id,supplier_return_line_id,supplier_return_reversal_id) values('SUPPLIER_RETURN_REVERSAL',v_unit.id,v_move,'RETURNED_TO_SUPPLIER','AVAILABLE',v_unit.condition,v_unit.condition,v_unit.lifecycle_revision-1,v_unit.lifecycle_revision,v_return.purchase_id,v_line.purchase_item_id,v_return.id,v_line.id,v_reversal.id);
  end loop;
  perform public.assert_purchase_refund_receipts_safe(v_return.purchase_id);
  v_result:=jsonb_build_object('supplier_return_reversal_id',v_reversal.id,'idempotent_replay',false);perform public.procurement_complete(p_request_id,'SUPPLIER_RETURN_REVERSAL',v_reversal.id,v_result);perform public.procurement_audit(v_actor,'SUPPLIER_RETURN_REVERSED','SUPPLIER_RETURN_REVERSAL',v_reversal.id,public.procurement_supplier_return_audit_evidence(v_return.id),to_jsonb(v_reversal) || jsonb_build_object('restored_supplier_return_state',public.procurement_supplier_return_audit_evidence(v_return.id)),jsonb_build_object('request_id',p_request_id,'purchase_id',v_return.purchase_id,'supplier_return_id',v_return.id,'reason',v_reversal.reason));return v_result;
end $$;

create or replace function public.purchase_reverse(p_request_id uuid, p_purchase_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid:=public.require_procurement_authority(true); v_purchase public.purchases; v_supplier public.suppliers; v_supplier_id uuid; v_reversal public.purchase_reversals; v_res public.procurement_operation_reservations; v_fp text:=public.procurement_fingerprint(jsonb_build_object('purchase_id',p_purchase_id,'reason',public.procurement_optional_text(p_reason))); v_result jsonb; v_effect public.inventory_bucket_effects; v_bucket public.stock_buckets; v_item public.purchase_items; v_unit public.serialized_units; v_move uuid; v_effect_id uuid;
begin
  if public.procurement_optional_text(p_reason) is null then raise exception 'Purchase reversal reason is required'; end if;
  v_res:=public.procurement_reserve(p_request_id,'PURCHASE_REVERSAL',v_fp,v_actor);if v_res.completed_at is not null then return v_res.result;end if;
  select p.supplier_id into v_supplier_id from public.purchases p where p.id=p_purchase_id;
  if not found then raise exception 'Purchase must be active to reverse'; end if;
  select * into v_supplier from public.suppliers where id=v_supplier_id for key share;
  if not found then raise exception 'Purchase must be active to reverse'; end if;
  select p.* into v_purchase from public.purchases p where p.id=p_purchase_id for update;
  if not found or v_purchase.supplier_id is distinct from v_supplier.id or exists (select 1 from public.purchase_reversals pr where pr.purchase_id=v_purchase.id) then raise exception 'Purchase must be active to reverse';end if;
  if exists(select 1 from public.supplier_returns where purchase_id=v_purchase.id) then raise exception 'Purchase reversal is permanently blocked by supplier-return history';end if;
  if exists(select 1 from public.supplier_payments sp join public.supplier_payment_reversals spr on spr.supplier_payment_id=sp.id where sp.purchase_id=v_purchase.id) then raise exception 'Purchase reversal is blocked by a pre-existing supplier payment reversal';end if;
  for v_effect in select * from public.inventory_bucket_effects where purchase_id=v_purchase.id and movement='PURCHASE' order by product_id,variant_id nulls first,condition for update loop
    select * into v_bucket from public.stock_buckets where id=v_effect.stock_bucket_id for update;if v_bucket.inventory_revision<>v_effect.revision_after or v_bucket.quantity<>v_effect.quantity_after or v_bucket.weighted_average_cost<>v_effect.wac_after then raise exception 'Later bucket movement blocks purchase reversal';end if;
  end loop;
  -- Bucket snapshot preflight is complete.  Lock every purchased serialized
  -- unit in UUID order and make the lifecycle check authoritative while the
  -- lock is held, before any reversal row or state mutation is written.
  for v_unit in
    select u.*
    from public.serialized_units u
    join public.purchase_items pi on pi.id = u.purchase_item_id
    where pi.purchase_id = v_purchase.id
    order by u.id
    for update
  loop
    select * into v_item from public.purchase_items where id = v_unit.purchase_item_id;
    if v_unit.status <> 'AVAILABLE'
       or v_unit.purchase_item_id is null
       or not found
       or v_item.purchase_id is distinct from v_purchase.id
       or v_unit.product_id is distinct from v_item.product_id
       or v_unit.variant_id is distinct from v_item.variant_id
       or not exists (
         select 1
         from public.serialized_unit_lifecycle_effects e
         where e.unit_id = v_unit.id
           and e.movement = 'PURCHASE'
           and e.purchase_id = v_purchase.id
           and e.purchase_item_id = v_unit.purchase_item_id
           and e.unit_revision_after = v_unit.lifecycle_revision
           and e.status_after = 'AVAILABLE'
       ) then
      raise exception 'Purchase reversal requires every acquired serialized unit to remain at its receipt lifecycle state';
    end if;
  end loop;
  insert into public.purchase_reversals(purchase_id,reason,reversed_by) values(v_purchase.id,btrim(p_reason),v_actor) returning * into v_reversal;
  insert into public.supplier_payment_reversals(supplier_payment_id,purchase_reversal_id,reason,reversed_by) select sp.id,v_reversal.id,'Automatically reversed with purchase reversal',v_actor from public.supplier_payments sp left join public.supplier_payment_reversals spr on spr.supplier_payment_id=sp.id where sp.purchase_id=v_purchase.id and spr.id is null;
  for v_effect in select * from public.inventory_bucket_effects where purchase_id=v_purchase.id and movement='PURCHASE' order by product_id,variant_id nulls first,condition for update loop
    select * into v_bucket from public.stock_buckets where id=v_effect.stock_bucket_id for update;
    update public.stock_buckets set quantity=v_effect.quantity_before,weighted_average_cost=v_effect.wac_before,inventory_revision=v_effect.revision_after+1 where id=v_bucket.id returning * into v_bucket;
    insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,purchase_id,purchase_reversal_id) values('PURCHASE_REVERSAL',v_bucket.id,v_effect.product_id,v_effect.variant_id,v_effect.condition,v_effect.quantity_after,v_effect.quantity_before,v_effect.wac_after,v_effect.wac_before,v_effect.revision_after,v_effect.revision_after+1,v_purchase.id,v_reversal.id) returning id into v_effect_id;
    for v_item in select pi.* from public.purchase_items pi join public.products p on p.id=pi.product_id where pi.purchase_id=v_purchase.id and not p.serialized and pi.product_id=v_effect.product_id and pi.variant_id is not distinct from v_effect.variant_id and pi.condition=v_effect.condition loop
      insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_item.product_id,v_item.variant_id,v_bucket.id,v_effect_id,'PURCHASE_REVERSAL',-v_item.quantity,v_item.condition,v_item.condition,v_effect.wac_after,'PURCHASE_REVERSAL',v_reversal.id,'Purchase reversal',v_actor);
    end loop;
  end loop;
  -- These are the same UUID-ordered rows locked and validated above.
  for v_unit in select u.* from public.serialized_units u join public.purchase_items pi on pi.id=u.purchase_item_id where pi.purchase_id=v_purchase.id order by u.id loop
    select * into v_item from public.purchase_items where id=v_unit.purchase_item_id;
    update public.serialized_units set status='PURCHASE_REVERSED',lifecycle_revision=v_unit.lifecycle_revision+1 where id=v_unit.id returning * into v_unit;
    insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by) values(v_unit.product_id,v_unit.variant_id,v_unit.id,'PURCHASE_REVERSAL',-1,v_unit.condition,v_unit.condition,v_unit.acquisition_cost,'PURCHASE_REVERSAL',v_reversal.id,'Purchase reversal',v_actor)returning id into v_move;
    insert into public.serialized_unit_lifecycle_effects(movement,unit_id,movement_id,status_before,status_after,condition_before,condition_after,unit_revision_before,unit_revision_after,purchase_id,purchase_item_id,purchase_reversal_id) values('PURCHASE_REVERSAL',v_unit.id,v_move,'AVAILABLE','PURCHASE_REVERSED',v_unit.condition,v_unit.condition,v_unit.lifecycle_revision-1,v_unit.lifecycle_revision,v_purchase.id,v_item.id,v_reversal.id);
  end loop;
  v_result:=jsonb_build_object('purchase_reversal_id',v_reversal.id,'idempotent_replay',false);perform public.procurement_complete(p_request_id,'PURCHASE_REVERSAL',v_reversal.id,v_result);perform public.procurement_audit(v_actor,'PURCHASE_REVERSED','PURCHASE_REVERSAL',v_reversal.id,null,public.procurement_purchase_reversal_audit_evidence(v_reversal.id),jsonb_build_object('request_id',p_request_id,'purchase_id',v_purchase.id,'reason',v_reversal.reason));return v_result;
end $$;

-- Phase 5 contract preserved; this replacement only adds immutable effects and
-- revision advancement.  Its separate Phase 5 idempotency table remains the
-- contract for opening-stock submissions.
create or replace function public.inventory_record_opening_stock(p_request_id uuid, p_notes text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid:=public.require_procurement_authority(); v_batch public.opening_stock_batches; v_line public.opening_stock_lines; v_product public.products; v_variant public.product_variants; v_bucket public.stock_buckets; v_unit public.serialized_units; v_input jsonb; v_identifier jsonb; v_group record; v_effect uuid; v_move uuid; v_fp text:=public.procurement_fingerprint(public.canonical_opening_stock_payload(p_notes,p_lines)); v_q integer; v_cost numeric(14,2); v_before_q integer;v_before_wac numeric(14,2);v_before_rev bigint;v_new_wac numeric(14,2);v_result jsonb;
begin
 if p_request_id is null or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Opening stock requires a request id and at least one line';end if;
 insert into public.opening_stock_batches(request_id,request_fingerprint,notes,created_by)values(p_request_id,v_fp,public.procurement_optional_text(p_notes),v_actor)on conflict(request_id)do nothing returning * into v_batch;
 if not found then
   select * into v_batch from public.opening_stock_batches where request_id=p_request_id for update;
   if v_batch.created_by is distinct from v_actor or v_batch.request_fingerprint<>v_fp then raise exception 'Opening stock request id was already used for a different submission';end if;
   select jsonb_build_object('opening_stock_batch_id',v_batch.id,'idempotent_replay',true,'lines',coalesce(jsonb_agg(jsonb_build_object('opening_stock_line_id',l.id,'product_id',l.product_id,'variant_id',l.variant_id,'condition',l.condition,'quantity',l.quantity,'unit_cost',l.unit_cost,'stock_bucket_id',m.stock_bucket_id,'serialized_unit_id',u.id,'identifiers',coalesce((select jsonb_agg(jsonb_build_object('type',i.identifier_type,'value',i.normalized_value) order by i.identifier_type,i.normalized_value) from public.unit_identifiers i where i.unit_id=u.id),'[]'::jsonb)) order by l.created_at,l.id),'[]'::jsonb)) into v_result from public.opening_stock_lines l left join public.serialized_units u on u.opening_stock_line_id=l.id left join public.inventory_movements m on m.reference_type='OPENING_STOCK_LINE' and m.reference_id=l.id where l.batch_id=v_batch.id;
   return v_result;
 end if;
 for v_input in
   select value from jsonb_array_elements(p_lines)
   order by (nullif(btrim(value->>'product_id'),'')::uuid),
            (nullif(btrim(value->>'variant_id'),'')::uuid) nulls first,
            (upper(btrim(value->>'condition'))::public.product_condition)
 loop
   v_q:=nullif(btrim(v_input->>'quantity'),'')::integer;v_cost:=nullif(btrim(v_input->>'acquisition_cost'),'')::numeric(14,2);
   select * into v_product from public.products where id=(v_input->>'product_id')::uuid for update;
   if not found or not v_product.active or v_q is null or v_q<=0 or v_cost is null or v_cost<0 then raise exception 'Opening stock requires active product, quantity, and non-negative cost';end if;
   if nullif(btrim(v_input->>'variant_id'),'') is not null then select * into v_variant from public.product_variants where id=(v_input->>'variant_id')::uuid and product_id=v_product.id for key share;if not found or not v_variant.active then raise exception 'Opening stock requires an active variant belonging to the product';end if;end if;
   if not v_product.serialized and (nullif(btrim(v_input->>'warranty_start'),'') is not null or nullif(btrim(v_input->>'warranty_expiry'),'') is not null) then raise exception 'Warranty data is supported only for serialized opening stock';end if;
   if v_product.serialized and v_q<>1 then raise exception 'Serialized opening stock requires one unit per line';end if;
   if nullif(btrim(v_input->>'warranty_expiry'),'')::date < nullif(btrim(v_input->>'warranty_start'),'')::date then raise exception 'Warranty expiry cannot be earlier than warranty start';end if;
   insert into public.opening_stock_lines(batch_id,product_id,variant_id,serialized,condition,quantity,unit_cost,warranty_start,warranty_expiry) values(v_batch.id,v_product.id,nullif(btrim(v_input->>'variant_id'),'')::uuid,v_product.serialized,upper(btrim(v_input->>'condition'))::public.product_condition,v_q,v_cost,nullif(btrim(v_input->>'warranty_start'),'')::date,nullif(btrim(v_input->>'warranty_expiry'),'')::date)returning * into v_line;
   if v_product.serialized then
     if jsonb_typeof(v_input->'identifiers') is distinct from 'array' or jsonb_array_length(v_input->'identifiers')=0 then raise exception 'Serialized opening stock requires identifiers';end if;
     insert into public.serialized_units(product_id,variant_id,opening_stock_line_id,condition,status,current_selling_price,acquisition_cost,warranty_start,warranty_expiry,lifecycle_revision) values(v_line.product_id,v_line.variant_id,v_line.id,v_line.condition,'AVAILABLE',null,v_line.unit_cost,v_line.warranty_start,v_line.warranty_expiry,1)returning * into v_unit;
     for v_identifier in select value from jsonb_array_elements(v_input->'identifiers') loop insert into public.unit_identifiers(unit_id,identifier_type,normalized_value)values(v_unit.id,upper(btrim(v_identifier->>'type'))::public.identifier_type,public.normalize_identifier_value(v_identifier->>'value'));end loop;
     insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)values(v_unit.product_id,v_unit.variant_id,v_unit.id,'OPENING_STOCK',1,null,v_unit.condition,v_unit.acquisition_cost,'OPENING_STOCK_LINE',v_line.id,'Opening stock',v_actor)returning id into v_move;
     insert into public.serialized_unit_lifecycle_effects(movement,unit_id,movement_id,status_before,status_after,condition_before,condition_after,unit_revision_before,unit_revision_after,opening_stock_line_id)values('OPENING_STOCK',v_unit.id,v_move,null,'AVAILABLE',null,v_unit.condition,0,1,v_line.id);
   end if;
 end loop;
 for v_group in select product_id,variant_id,condition,sum(quantity)::integer q,sum(quantity*unit_cost)::numeric value from public.opening_stock_lines where batch_id=v_batch.id and not serialized group by product_id,variant_id,condition order by product_id,variant_id nulls first,condition loop
   perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s',v_group.product_id,coalesce(v_group.variant_id::text,'BASE'),v_group.condition::text),0));select * into v_bucket from public.stock_buckets where product_id=v_group.product_id and variant_id is not distinct from v_group.variant_id and condition=v_group.condition for update;
   if found then v_before_q:=v_bucket.quantity;v_before_wac:=v_bucket.weighted_average_cost;v_before_rev:=v_bucket.inventory_revision;v_new_wac:=case when v_before_q=0 then round(v_group.value/v_group.q,2) else round(((v_before_q*v_before_wac)+v_group.value)/(v_before_q+v_group.q),2)end;update public.stock_buckets set quantity=v_before_q+v_group.q,weighted_average_cost=v_new_wac,inventory_revision=v_before_rev+1 where id=v_bucket.id returning * into v_bucket;else v_before_q:=0;v_before_wac:=0;v_before_rev:=0;v_new_wac:=round(v_group.value/v_group.q,2);insert into public.stock_buckets(product_id,variant_id,serialized,condition,quantity,selling_price,weighted_average_cost,inventory_revision)values(v_group.product_id,v_group.variant_id,false,v_group.condition,v_group.q,null,v_new_wac,1)returning * into v_bucket;end if;
   insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,opening_stock_batch_id)values('OPENING_STOCK',v_bucket.id,v_group.product_id,v_group.variant_id,v_group.condition,v_before_q,v_bucket.quantity,v_before_wac,v_bucket.weighted_average_cost,v_before_rev,v_before_rev+1,v_batch.id)returning id into v_effect;
   for v_line in select * from public.opening_stock_lines where batch_id=v_batch.id and not serialized and product_id=v_group.product_id and variant_id is not distinct from v_group.variant_id and condition=v_group.condition loop insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)values(v_line.product_id,v_line.variant_id,v_bucket.id,v_effect,'OPENING_STOCK',v_line.quantity,null,v_line.condition,v_line.unit_cost,'OPENING_STOCK_LINE',v_line.id,'Opening stock',v_actor);end loop;
 end loop;
 select jsonb_build_object('opening_stock_batch_id',v_batch.id,'idempotent_replay',false,'lines',coalesce(jsonb_agg(jsonb_build_object('opening_stock_line_id',l.id,'product_id',l.product_id,'variant_id',l.variant_id,'condition',l.condition,'quantity',l.quantity,'unit_cost',l.unit_cost,'stock_bucket_id',m.stock_bucket_id,'serialized_unit_id',u.id,'identifiers',coalesce((select jsonb_agg(jsonb_build_object('type',i.identifier_type,'value',i.normalized_value) order by i.identifier_type,i.normalized_value) from public.unit_identifiers i where i.unit_id=u.id),'[]'::jsonb)) order by l.created_at,l.id),'[]'::jsonb)) into v_result from public.opening_stock_lines l left join public.serialized_units u on u.opening_stock_line_id=l.id left join public.inventory_movements m on m.reference_type='OPENING_STOCK_LINE' and m.reference_id=l.id where l.batch_id=v_batch.id;perform public.procurement_audit(v_actor,'OPENING_STOCK_RECORDED','OPENING_STOCK_BATCH',v_batch.id,null,v_result,jsonb_build_object('request_id',p_request_id));return v_result;
end $$;

create or replace function public.inventory_execute_adjustment(
  p_request_id uuid, p_adjustment_request_id uuid, p_product_id uuid, p_variant_id uuid,
  p_unit_id uuid, p_condition public.product_condition, p_quantity integer,
  p_unit_cost numeric, p_reason text
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.require_procurement_authority(true);
  v_request public.inventory_adjustment_requests;
  v_res public.inventory_adjustment_reservations;
  v_execution public.inventory_adjustment_executions;
  v_product public.products;
  v_variant public.product_variants;
  v_unit public.serialized_units;
  v_bucket public.stock_buckets;
  v_product_id uuid := p_product_id;
  v_variant_id uuid := p_variant_id;
  v_unit_id uuid := p_unit_id;
  v_condition public.product_condition := p_condition;
  v_q integer := p_quantity;
  v_cost numeric(14,2) := p_unit_cost;
  v_reason text := public.procurement_optional_text(p_reason);
  v_fp text;
  v_before_q integer;
  v_before_wac numeric(14,2);
  v_before_rev bigint;
  v_new_q integer;
  v_new_wac numeric(14,2);
  v_bucket_preexisted boolean := false;
  v_effect uuid;
  v_move uuid;
  v_lifecycle_effect uuid;
  v_request_before jsonb;
  v_request_after jsonb;
  v_bucket_before jsonb;
  v_bucket_after jsonb;
  v_unit_before jsonb;
  v_unit_after jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'An adjustment request idempotency key is required'; end if;
  if p_adjustment_request_id is not null then
    select * into v_request from public.inventory_adjustment_requests where id = p_adjustment_request_id for update;
    if not found then raise exception 'Adjustment request does not exist'; end if;
    v_request_before := to_jsonb(v_request);
    v_product_id := v_request.product_id; v_variant_id := v_request.variant_id; v_unit_id := v_request.unit_id;
    v_condition := v_request.condition; v_q := v_request.requested_quantity; v_reason := v_request.reason;
  end if;
  if v_q is null or v_q = 0 or v_reason is null then raise exception 'An adjustment requires a non-zero quantity and reason'; end if;
  v_fp := public.procurement_fingerprint(jsonb_build_object('request', p_adjustment_request_id,
    'product', v_product_id, 'variant', v_variant_id, 'unit', v_unit_id, 'condition', v_condition,
    'quantity', v_q, 'cost', case when v_unit_id is null and v_q > 0 then v_cost::numeric(14,2) else null end, 'reason', v_reason));
  insert into public.inventory_adjustment_reservations(request_id, request_fingerprint, reserved_by)
  values (p_request_id, v_fp, v_actor) on conflict(request_id) do nothing returning * into v_res;
  if not found then
    select * into v_res from public.inventory_adjustment_reservations where request_id = p_request_id for key share;
    if not found or v_res.reserved_by is distinct from v_actor or v_res.request_fingerprint <> v_fp or v_res.execution_id is null then
      raise exception 'Adjustment request id was already used for a different submission';
    end if;
    return jsonb_build_object('adjustment_execution_id', v_res.execution_id, 'idempotent_replay', true);
  end if;
  if p_adjustment_request_id is not null and v_request.status <> 'OPEN' then raise exception 'Adjustment request is not open'; end if;
  select * into v_product from public.products where id = v_product_id for update;
  if not found or not v_product.active then raise exception 'Adjustment requires an active product'; end if;
  if v_variant_id is not null then
    select * into v_variant from public.product_variants where id = v_variant_id and product_id = v_product_id for key share;
    if not found or not v_variant.active then raise exception 'Adjustment requires an active matching variant'; end if;
  end if;
  if v_unit_id is not null then
    if v_q <> -1 or not v_product.serialized then raise exception 'Serialized adjustments can only adjust one available unit out'; end if;
    if v_condition is not null then raise exception 'Serialized adjustments identify the unit and must not supply a stock condition'; end if;
    select * into v_unit from public.serialized_units where id = v_unit_id for update;
    if not found or v_unit.status <> 'AVAILABLE' or v_unit.product_id <> v_product_id or v_unit.variant_id is distinct from v_variant_id then
      raise exception 'Serialized adjustment requires an available matching unit';
    end if;
    v_unit_before := jsonb_build_object('unit_id', v_unit.id, 'product_id', v_unit.product_id,
      'variant_id', v_unit.variant_id, 'status', v_unit.status, 'condition', v_unit.condition,
      'lifecycle_revision', v_unit.lifecycle_revision, 'acquisition_cost', v_unit.acquisition_cost,
      'purchase_item_id', v_unit.purchase_item_id, 'opening_stock_line_id', v_unit.opening_stock_line_id,
      'identifiers', coalesce((select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.normalized_value)
        order by i.identifier_type, i.normalized_value) from public.unit_identifiers i where i.unit_id = v_unit.id), '[]'::jsonb));
    insert into public.inventory_adjustment_executions(request_id,request_fingerprint,adjustment_request_id,product_id,variant_id,unit_id,condition,quantity,unit_cost,reason,executed_by)
    values(p_request_id,v_fp,p_adjustment_request_id,v_product_id,v_variant_id,v_unit.id,v_unit.condition,-1,v_unit.acquisition_cost,v_reason,v_actor) returning * into v_execution;
    update public.serialized_units set status = 'ADJUSTED_OUT', lifecycle_revision = v_unit.lifecycle_revision + 1 where id = v_unit.id returning * into v_unit;
    insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)
    values(v_unit.product_id,v_unit.variant_id,v_unit.id,'ADJUSTMENT',-1,v_unit.condition,v_unit.condition,v_unit.acquisition_cost,'INVENTORY_ADJUSTMENT_EXECUTION',v_execution.id,v_reason,v_actor) returning id into v_move;
    insert into public.serialized_unit_lifecycle_effects(movement,unit_id,movement_id,status_before,status_after,condition_before,condition_after,unit_revision_before,unit_revision_after,inventory_adjustment_execution_id)
    values('ADJUSTMENT',v_unit.id,v_move,'AVAILABLE','ADJUSTED_OUT',v_unit.condition,v_unit.condition,v_unit.lifecycle_revision - 1,v_unit.lifecycle_revision,v_execution.id) returning id into v_lifecycle_effect;
    v_unit_after := v_unit_before || jsonb_build_object('status', v_unit.status, 'lifecycle_revision', v_unit.lifecycle_revision,
      'serialized_lifecycle_effect_id', v_lifecycle_effect);
  else
    if v_product.serialized or v_condition is null then raise exception 'Non-serialized adjustment requires exact stock condition'; end if;
    perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s',v_product_id,coalesce(v_variant_id::text,'BASE'),v_condition::text),0));
    select * into v_bucket from public.stock_buckets where product_id=v_product_id and variant_id is not distinct from v_variant_id and condition=v_condition for update;
    v_bucket_preexisted := found;
    if v_bucket_preexisted then
      v_before_q := v_bucket.quantity; v_before_wac := v_bucket.weighted_average_cost; v_before_rev := v_bucket.inventory_revision;
      v_bucket_before := to_jsonb(v_bucket);
    else
      v_before_q := 0; v_before_wac := 0; v_before_rev := 0;
      v_bucket_before := jsonb_build_object('stock_bucket_id', null, 'quantity', 0, 'weighted_average_cost', null, 'inventory_revision', 0);
    end if;
    if v_q > 0 then
      if v_cost is null or v_cost < 0 then raise exception 'Positive adjustment requires a non-negative acquisition unit cost'; end if;
      v_new_q := v_before_q + v_q;
      v_new_wac := case when v_before_q = 0 then v_cost else round(((v_before_q * v_before_wac) + (v_q * v_cost)) / v_new_q, 2) end;
    else
      if not v_bucket_preexisted or v_before_q + v_q < 0 then raise exception 'Adjustment would create negative inventory'; end if;
      v_new_q := v_before_q + v_q; v_new_wac := v_before_wac; v_cost := v_before_wac;
    end if;
    if not v_bucket_preexisted then
      insert into public.stock_buckets(product_id,variant_id,serialized,condition,quantity,selling_price,weighted_average_cost,inventory_revision)
      values(v_product_id,v_variant_id,false,v_condition,v_new_q,null,v_new_wac,1) returning * into v_bucket;
    else
      update public.stock_buckets set quantity=v_new_q, weighted_average_cost=v_new_wac, inventory_revision=v_before_rev+1
      where id=v_bucket.id returning * into v_bucket;
    end if;
    insert into public.inventory_adjustment_executions(request_id,request_fingerprint,adjustment_request_id,product_id,variant_id,stock_bucket_id,condition,quantity,unit_cost,reason,executed_by)
    values(p_request_id,v_fp,p_adjustment_request_id,v_product_id,v_variant_id,v_bucket.id,v_condition,v_q,v_cost,v_reason,v_actor) returning * into v_execution;
    insert into public.inventory_bucket_effects(movement,stock_bucket_id,product_id,variant_id,condition,quantity_before,quantity_after,wac_before,wac_after,revision_before,revision_after,inventory_adjustment_execution_id)
    values('ADJUSTMENT',v_bucket.id,v_product_id,v_variant_id,v_condition,v_before_q,v_bucket.quantity,v_before_wac,v_bucket.weighted_average_cost,v_before_rev,v_before_rev+1,v_execution.id) returning id into v_effect;
    insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,bucket_effect_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)
    values(v_product_id,v_variant_id,v_bucket.id,v_effect,'ADJUSTMENT',v_q,v_condition,v_condition,v_cost,'INVENTORY_ADJUSTMENT_EXECUTION',v_execution.id,v_reason,v_actor) returning id into v_move;
    v_bucket_after := to_jsonb(v_bucket) || jsonb_build_object('inventory_bucket_effect_id', v_effect, 'inventory_movement_id', v_move);
  end if;
  update public.inventory_adjustment_reservations set execution_id=v_execution.id where request_id=p_request_id;
  if p_adjustment_request_id is not null then
    update public.inventory_adjustment_requests set status='RESOLVED',reviewed_by=v_actor,reviewed_at=now()
    where id=p_adjustment_request_id returning * into v_request;
    v_request_after := to_jsonb(v_request);
  end if;
  v_result := jsonb_build_object('adjustment_execution_id',v_execution.id,'idempotent_replay',false);
  perform public.procurement_audit(v_actor,'INVENTORY_ADJUSTMENT_EXECUTED','INVENTORY_ADJUSTMENT_EXECUTION',v_execution.id,
    jsonb_build_object('request',v_request_before,'stock_bucket',v_bucket_before,'serialized_unit',v_unit_before),
    jsonb_build_object('request',v_request_after,'stock_bucket',v_bucket_after,'serialized_unit',v_unit_after),
    jsonb_build_object('request_id',p_request_id,'adjustment_request_id',p_adjustment_request_id,
      'adjustment_quantity',v_execution.quantity,'movement_cost_snapshot',v_execution.unit_cost,
      'stock_bucket_id',v_execution.stock_bucket_id,'unit_id',v_execution.unit_id,
      'inventory_bucket_effect_id',v_effect,'serialized_lifecycle_effect_id',v_lifecycle_effect));
  return v_result;
end $$;

-- Revision enforcement becomes live only after every above writer is aware of it.
create trigger enforce_stock_bucket_revision
before update of quantity, weighted_average_cost, inventory_revision on public.stock_buckets
for each row execute function public.enforce_stock_bucket_revision();
create trigger enforce_serialized_lifecycle_revision
before update of status, condition, lifecycle_revision on public.serialized_units
for each row execute function public.enforce_serialized_lifecycle_revision();

revoke all on function public.procurement_lagos_today(), public.procurement_optional_text(text), public.procurement_fingerprint(jsonb), public.canonical_procurement_identifiers(jsonb), public.canonical_purchase_receive_payload(uuid,date,text,text,jsonb,jsonb), public.canonical_supplier_return_payload(uuid,date,text,text,jsonb,jsonb), public.canonical_opening_stock_payload(text,jsonb), public.require_procurement_authority(boolean), public.procurement_reserve(uuid,public.procurement_operation_kind,text,uuid), public.procurement_complete(uuid,text,uuid,jsonb), public.procurement_audit(uuid,text,text,uuid,jsonb,jsonb,jsonb), public.procurement_purchase_audit_evidence(uuid), public.procurement_supplier_return_audit_evidence(uuid), public.procurement_purchase_financial_evidence(uuid), public.procurement_purchase_reversal_audit_evidence(uuid), public.supplier_return_refund_entitlements(uuid), public.assert_purchase_refund_receipts_safe(uuid) from public, anon, authenticated;
revoke all on function public.supplier_create(text,text,text,text,text,text), public.supplier_update(uuid,text,text,text,text,text,text), public.supplier_update_archived_contact(uuid,text,text,text,text,text), public.supplier_archive(uuid), public.purchase_receive(uuid,uuid,date,text,text,jsonb,jsonb), public.supplier_record_payment(uuid,uuid,numeric,public.supplier_payment_method,date,text,text), public.supplier_finalize_return(uuid,uuid,date,text,text,jsonb,jsonb), public.supplier_record_refund_receipt(uuid,uuid,numeric,public.supplier_payment_method,date,text,text), public.purchase_reverse(uuid,uuid,text), public.supplier_reverse_payment(uuid,uuid,text), public.supplier_reverse_return(uuid,uuid,text), public.supplier_reverse_refund_receipt(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.supplier_create(text,text,text,text,text,text), public.supplier_update(uuid,text,text,text,text,text,text), public.supplier_update_archived_contact(uuid,text,text,text,text,text), public.supplier_archive(uuid), public.purchase_receive(uuid,uuid,date,text,text,jsonb,jsonb), public.supplier_record_payment(uuid,uuid,numeric,public.supplier_payment_method,date,text,text), public.supplier_finalize_return(uuid,uuid,date,text,text,jsonb,jsonb), public.supplier_record_refund_receipt(uuid,uuid,numeric,public.supplier_payment_method,date,text,text), public.purchase_reverse(uuid,uuid,text), public.supplier_reverse_payment(uuid,uuid,text), public.supplier_reverse_return(uuid,uuid,text), public.supplier_reverse_refund_receipt(uuid,uuid,text) to authenticated;
revoke all on table public.supplier_return_financial_summary from public, anon, authenticated;
grant select on table public.supplier_return_financial_summary to authenticated;
revoke all on function public.inventory_record_opening_stock(uuid,text,jsonb), public.inventory_execute_adjustment(uuid,uuid,uuid,uuid,uuid,public.product_condition,integer,numeric,text) from public, anon, authenticated;
grant execute on function public.inventory_record_opening_stock(uuid,text,jsonb), public.inventory_execute_adjustment(uuid,uuid,uuid,uuid,uuid,public.product_condition,integer,numeric,text), public.inventory_submit_adjustment_request(uuid,uuid,uuid,public.product_condition,integer,text), public.inventory_reject_adjustment_request(uuid,text), public.staff_serialized_lookup(text) to authenticated;
