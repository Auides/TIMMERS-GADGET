-- PHASE 7 / MIGRATION 3A: sales internal transaction infrastructure.
--
-- This migration intentionally exposes no business command.  The helpers below
-- are only callable by later SECURITY DEFINER transaction commands; browser
-- roles receive no EXECUTE privilege on them.

-- Keep the actor lookup independent of the older public.current_role() helper,
-- whose search_path predates the hardened helper convention.
create or replace function public.sales_require_active_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role public.app_role;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;

  select p.role
    into v_role
  from public.profiles p
  where p.id = v_actor
    and p.is_active = true;

  if not found or v_role not in ('ADMIN', 'MANAGER', 'STAFF') then
    raise exception 'ACTOR_NOT_ACTIVE' using errcode = '42501';
  end if;

  return v_actor;
end
$$;

-- JSONB has a canonical key order.  Callers provide a server-built canonical
-- payload, never a client-supplied hash; digest() is the existing project
-- extension boundary used by the procurement helpers.
create or replace function public.sales_fingerprint(p_canonical_payload jsonb)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_canonical_payload is null then
    raise exception 'INVALID_FINGERPRINT_PAYLOAD' using errcode = '22023';
  end if;

  return pg_catalog.encode(extensions.digest(p_canonical_payload::text, 'sha256'), 'hex');
end
$$;

-- The checkout command added later will use this exact normalized snapshot for
-- its idempotency and approval contexts.  Arrays are sorted by canonical value
-- so insignificant client ordering cannot alter the request identity.
create or replace function public.sales_canonical_checkout_payload(
  p_sale_kind public.sale_kind,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_requested_discount_amount numeric
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with raw_lines as (
    select
      nullif(btrim(l.value ->> 'product_id'), '')::uuid as product_id,
      nullif(btrim(l.value ->> 'variant_id'), '')::uuid as variant_id,
      upper(btrim(l.value ->> 'condition'))::public.product_condition as condition,
      nullif(btrim(l.value ->> 'quantity'), '')::integer as quantity,
      coalesce((
        select jsonb_agg(
          (nullif(btrim(u.value #>> '{}'), '')::uuid)::text
          order by (nullif(btrim(u.value #>> '{}'), '')::uuid)::text
        )
        from jsonb_array_elements(coalesce(l.value -> 'serialized_unit_ids', '[]'::jsonb)) u(value)
      ), '[]'::jsonb) as serialized_unit_ids
    from jsonb_array_elements(
      case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end
    ) l(value)
  ), canonical_lines as (
    select product_id, variant_id, condition, quantity, serialized_unit_ids,
           jsonb_build_object(
             'product_id', product_id::text,
             'variant_id', variant_id::text,
             'condition', condition::text,
             'quantity', quantity,
             'serialized_unit_ids', serialized_unit_ids
           ) as payload
    from raw_lines
  ), raw_payments as (
    select
      nullif(btrim(p.value ->> 'amount'), '')::numeric(14,2) as amount,
      (upper(btrim(p.value ->> 'method'))::public.supplier_payment_method)::text as method,
      nullif(btrim(p.value ->> 'paid_on'), '')::date as paid_on,
      nullif(btrim(p.value ->> 'reference'), '') as reference,
      nullif(btrim(p.value ->> 'notes'), '') as notes
    from jsonb_array_elements(
      case when jsonb_typeof(p_payments) = 'array' then p_payments else '[]'::jsonb end
    ) p(value)
  ), canonical_payments as (
    select method, reference, paid_on, amount, notes,
           jsonb_build_object(
             'amount', amount,
             'method', method,
             'paid_on', paid_on,
             'reference', reference,
             'notes', notes
           ) as payload
    from raw_payments
  )
  select jsonb_build_object(
    'sale_kind', p_sale_kind::text,
    'customer_id', p_customer_id::text,
    'transaction_on', p_transaction_on,
    'notes', nullif(btrim(p_notes), ''),
    -- A requested discount is caller intent.  Gross/final totals, unit prices,
    -- and COGS are deliberately absent: a later command derives them from
    -- authoritative catalogue and inventory state before it fingerprints.
    'requested_discount_amount', p_requested_discount_amount::numeric(14,2),
    'lines', coalesce((
      select jsonb_agg(payload order by product_id, variant_id nulls first,
        condition, serialized_unit_ids, quantity, payload)
      from canonical_lines
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(payload order by method, reference nulls first, paid_on,
        amount, notes nulls first, payload)
      from canonical_payments
    ), '[]'::jsonb)
  )
$$;

-- Idempotency reservations deliberately retain incomplete matching rows.  A
-- later command running in the same ownership context may continue them; a
-- different operation, actor, or canonical payload always fails deterministically.
create or replace function public.sales_reserve(
  p_request_id uuid,
  p_operation public.sales_operation_kind,
  p_fingerprint text,
  p_actor uuid
)
returns public.sales_operation_reservations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_reservation public.sales_operation_reservations;
begin
  if p_request_id is null or p_operation is null or p_actor is null
     or p_fingerprint is null or p_fingerprint <> lower(btrim(p_fingerprint))
     or p_fingerprint = '' then
    raise exception 'INVALID_IDEMPOTENCY_REQUEST' using errcode = '22023';
  end if;

  insert into public.sales_operation_reservations
    (request_id, operation, request_fingerprint, actor_id)
  values (p_request_id, p_operation, p_fingerprint, p_actor)
  on conflict (request_id) do nothing
  returning * into v_reservation;

  if found then
    return v_reservation;
  end if;

  select r.*
    into v_reservation
  from public.sales_operation_reservations r
  where r.request_id = p_request_id
  for update;

  if v_reservation.operation is distinct from p_operation
     or v_reservation.request_fingerprint is distinct from p_fingerprint
     or v_reservation.actor_id is distinct from p_actor then
    raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
  end if;

  return v_reservation;
end
$$;

create or replace function public.sales_complete(
  p_request_id uuid,
  p_operation public.sales_operation_kind,
  p_fingerprint text,
  p_actor uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_result jsonb
)
returns public.sales_operation_reservations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_reservation public.sales_operation_reservations;
begin
  if p_request_id is null or p_operation is null or p_actor is null
     or p_fingerprint is null or p_fingerprint <> lower(btrim(p_fingerprint))
     or p_fingerprint = '' or p_entity_type is null
     or btrim(p_entity_type) = '' or p_entity_id is null or p_result is null then
    raise exception 'INVALID_IDEMPOTENCY_COMPLETION' using errcode = '22023';
  end if;

  select r.*
    into v_reservation
  from public.sales_operation_reservations r
  where r.request_id = p_request_id
  for update;

  if not found then
    raise exception 'IDEMPOTENCY_NOT_RESERVED' using errcode = 'P0001';
  end if;

  if v_reservation.operation is distinct from p_operation
     or v_reservation.request_fingerprint is distinct from p_fingerprint
     or v_reservation.actor_id is distinct from p_actor then
    raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
  end if;

  if v_reservation.completed_at is not null then
    return v_reservation;
  end if;

  update public.sales_operation_reservations
  set completed_entity_type = btrim(p_entity_type),
      completed_entity_id = p_entity_id,
      result = p_result,
      completed_at = pg_catalog.now()
  where request_id = p_request_id
    and completed_at is null
  returning * into v_reservation;

  if not found then
    raise exception 'IDEMPOTENCY_ALREADY_COMPLETED' using errcode = 'P0001';
  end if;

  return v_reservation;
end
$$;

-- These snapshot helpers intentionally use ordinary SELECTs.  Future commands
-- acquire their own locks in the documented global order rather than inheriting
-- an incidental lookup lock here.
create or replace function public.sales_stock_bucket_snapshot(
  p_product_id uuid,
  p_variant_id uuid,
  p_condition public.product_condition
)
returns table (
  stock_bucket_id uuid,
  product_id uuid,
  variant_id uuid,
  condition public.product_condition,
  quantity integer,
  weighted_average_cost numeric,
  inventory_revision bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return query
  select b.id, b.product_id, b.variant_id, b.condition, b.quantity,
         b.weighted_average_cost, b.inventory_revision
  from public.stock_buckets b
  where b.serialized = false
    and b.product_id = p_product_id
    and b.variant_id is not distinct from p_variant_id
    and b.condition = p_condition;

  if not found then
    raise exception 'STOCK_BUCKET_NOT_FOUND' using errcode = 'P0001';
  end if;
end
$$;

create or replace function public.sales_serialized_unit_snapshot(p_unit_id uuid)
returns table (
  serialized_unit_id uuid,
  product_id uuid,
  variant_id uuid,
  condition public.product_condition,
  status public.unit_status,
  acquisition_cost numeric,
  lifecycle_revision bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return query
  select u.id, u.product_id, u.variant_id, u.condition, u.status,
         u.acquisition_cost, u.lifecycle_revision
  from public.serialized_units u
  where u.id = p_unit_id;

  if not found then
    raise exception 'SERIALIZED_UNIT_NOT_FOUND' using errcode = 'P0001';
  end if;
end
$$;

-- Retail price is catalogue authority for both tracking modes.  Stock buckets
-- and serialized units are inventory/COGS state only and are intentionally not
-- consulted here.
create or replace function public.sales_resolve_catalogue_price(
  p_product_id uuid,
  p_variant_id uuid,
  p_condition public.product_condition
)
returns table (
  catalogue_price_id uuid,
  product_id uuid,
  variant_id uuid,
  condition public.product_condition,
  selling_price numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_product public.products;
begin
  select p.* into v_product
  from public.products p
  where p.id = p_product_id;

  if not found or not v_product.active then
    raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  if p_variant_id is null then
    if exists (
      select 1 from public.product_variants v
      where v.product_id = p_product_id and v.active
    ) then
      raise exception 'VARIANT_INVALID' using errcode = 'P0001';
    end if;
  elsif not exists (
    select 1 from public.product_variants v
    where v.id = p_variant_id
      and v.product_id = p_product_id
      and v.active
  ) then
    raise exception 'VARIANT_INVALID' using errcode = 'P0001';
  end if;

  return query
  select cp.id, cp.product_id, cp.variant_id, cp.condition, cp.selling_price
  from public.catalogue_prices cp
  where cp.active
    and cp.product_id = p_product_id
    and cp.variant_id is not distinct from p_variant_id
    and cp.condition = p_condition;

  if not found then
    raise exception 'PRICE_NOT_FOUND' using errcode = 'P0001';
  end if;
end
$$;

-- Allocate rounded monetary values deterministically: floor every proportional
-- share to cents, then grant residual cents by fractional remainder and line.
create or replace function public.sales_allocate_discount(
  p_lines jsonb,
  p_discount_total numeric
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result jsonb;
  v_line_count integer;
  v_gross_total numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0
     or p_discount_total is null
     or p_discount_total < 0
     or p_discount_total <> round(p_discount_total, 2) then
    raise exception 'INVALID_DISCOUNT_ALLOCATION' using errcode = '22023';
  end if;

  select count(*), sum(nullif(btrim(x.value ->> 'gross_subtotal'), '')::numeric(14,2))
    into v_line_count, v_gross_total
  from jsonb_array_elements(p_lines) x(value);

  if v_line_count = 0 or v_gross_total is null or v_gross_total <= 0
     or p_discount_total > v_gross_total
     or exists (
       select 1
       from jsonb_array_elements(p_lines) x(value)
       where nullif(btrim(x.value ->> 'line_number'), '')::integer is null
          or nullif(btrim(x.value ->> 'line_number'), '')::integer <= 0
          or nullif(btrim(x.value ->> 'gross_subtotal'), '')::numeric(14,2) is null
          or nullif(btrim(x.value ->> 'gross_subtotal'), '')::numeric(14,2) < 0
     )
     or exists (
       select 1
       from jsonb_array_elements(p_lines) x(value)
       group by nullif(btrim(x.value ->> 'line_number'), '')::integer
       having count(*) > 1
     ) then
    raise exception 'INVALID_DISCOUNT_ALLOCATION' using errcode = '22023';
  end if;

  with input_lines as (
    select nullif(btrim(x.value ->> 'line_number'), '')::integer as line_number,
           nullif(btrim(x.value ->> 'gross_subtotal'), '')::numeric(14,2) as gross_subtotal
    from jsonb_array_elements(p_lines) x(value)
  ), shares as (
    select i.line_number, i.gross_subtotal,
           (i.gross_subtotal * p_discount_total / v_gross_total) as exact_share
    from input_lines i
  ), rounded_down as (
    select s.*, floor(s.exact_share * 100) / 100 as base_share
    from shares s
  ), ranked as (
    select r.*, row_number() over (
      order by (r.exact_share - r.base_share) desc, r.line_number asc
    ) as remainder_rank,
    round((p_discount_total - sum(r.base_share) over ()) * 100)::integer as remainder_cents
    from rounded_down r
  )
  select jsonb_agg(
    jsonb_build_object(
      'line_number', line_number,
      'gross_subtotal', gross_subtotal,
      'allocated_discount', (base_share + case when remainder_rank <= remainder_cents then 0.01 else 0 end)::numeric(14,2)
    )
    order by line_number
  ) into v_result
  from ranked;

  return v_result;
end
$$;

create or replace function public.sales_active_payment_outstanding(p_sale_id uuid)
returns table (
  sale_id uuid,
  final_total numeric,
  active_payment_total numeric,
  outstanding_amount numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return query
  select s.id,
         s.final_total,
         coalesce(sum(p.amount) filter (where r.id is null), 0)::numeric(14,2),
         greatest(s.final_total - coalesce(sum(p.amount) filter (where r.id is null), 0), 0)::numeric(14,2)
  from public.sales s
  left join public.sale_payments p on p.sale_id = s.id
  left join public.sale_payment_reversals r on r.sale_payment_id = p.id
  where s.id = p_sale_id
  group by s.id, s.final_total;

  if not found then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0001';
  end if;
end
$$;

-- Validation never creates decisions or marks approvals consumed.  The partial
-- unique indexes below are the sole consumption guard used by a later checkout.
create or replace function public.sales_validate_discount_approval(
  p_request_id uuid,
  p_current_fingerprint text,
  p_discount_total numeric
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request public.sale_discount_requests;
  v_decision public.sale_discount_decisions;
begin
  select r.* into v_request
  from public.sale_discount_requests r
  where r.id = p_request_id;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0001';
  end if;

  select d.* into v_decision
  from public.sale_discount_decisions d
  where d.sale_discount_request_id = p_request_id;
  if not found or v_decision.decision <> 'APPROVED' then
    raise exception 'APPROVAL_NOT_APPROVED' using errcode = 'P0001';
  end if;

  if v_request.request_fingerprint is distinct from p_current_fingerprint
     or v_decision.approved_discount_amount is distinct from p_discount_total then
    raise exception 'APPROVAL_CONTEXT_MISMATCH' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.sales s where s.discount_request_id = p_request_id) then
    raise exception 'APPROVAL_ALREADY_CONSUMED' using errcode = 'P0001';
  end if;

  return v_decision.id;
end
$$;

create or replace function public.sales_validate_credit_approval(
  p_request_id uuid,
  p_current_fingerprint text,
  p_customer_id uuid,
  p_final_total numeric,
  p_initial_payment numeric,
  p_outstanding_credit numeric
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request public.sale_credit_requests;
  v_decision public.sale_credit_decisions;
begin
  select r.* into v_request
  from public.sale_credit_requests r
  where r.id = p_request_id;
  if not found then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0001';
  end if;

  select d.* into v_decision
  from public.sale_credit_decisions d
  where d.sale_credit_request_id = p_request_id;
  if not found or v_decision.decision <> 'APPROVED' then
    raise exception 'APPROVAL_NOT_APPROVED' using errcode = 'P0001';
  end if;

  if v_request.request_fingerprint is distinct from p_current_fingerprint
     or v_request.customer_id is distinct from p_customer_id
     or v_request.final_total_snapshot is distinct from p_final_total
     or v_request.initial_payment_snapshot is distinct from p_initial_payment
     or v_request.proposed_outstanding_credit is distinct from p_outstanding_credit then
    raise exception 'APPROVAL_CONTEXT_MISMATCH' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.sales s where s.credit_request_id = p_request_id) then
    raise exception 'APPROVAL_ALREADY_CONSUMED' using errcode = 'P0001';
  end if;

  return v_decision.id;
end
$$;

-- One approval request can finance one finalized sale at most.  No duplicate
-- index exists in the Phase 2 schema; IF NOT EXISTS keeps reruns non-destructive.
create unique index if not exists sales_discount_request_consumed_key
  on public.sales (discount_request_id)
  where discount_request_id is not null;

create unique index if not exists sales_credit_request_consumed_key
  on public.sales (credit_request_id)
  where credit_request_id is not null;

-- Existing public.procurement_audit(...) is the common internal audit writer;
-- later sales commands reuse it with sales action/entity labels.  No wrapper is
-- needed, and this infrastructure migration writes no operational audit rows.

revoke all on function
  public.sales_require_active_actor(),
  public.sales_fingerprint(jsonb),
  public.sales_canonical_checkout_payload(public.sale_kind, uuid, date, text, jsonb, jsonb, numeric),
  public.sales_reserve(uuid, public.sales_operation_kind, text, uuid),
  public.sales_complete(uuid, public.sales_operation_kind, text, uuid, text, uuid, jsonb),
  public.sales_stock_bucket_snapshot(uuid, uuid, public.product_condition),
  public.sales_serialized_unit_snapshot(uuid),
  public.sales_resolve_catalogue_price(uuid, uuid, public.product_condition),
  public.sales_allocate_discount(jsonb, numeric),
  public.sales_active_payment_outstanding(uuid),
  public.sales_validate_discount_approval(uuid, text, numeric),
  public.sales_validate_credit_approval(uuid, text, uuid, numeric, numeric, numeric)
from public, anon, authenticated;
