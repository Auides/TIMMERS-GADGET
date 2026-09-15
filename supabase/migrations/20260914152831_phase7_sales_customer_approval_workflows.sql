-- TIMMERS GADGET - Phase 7 Migration 3B: customer and approval workflows.
-- This migration deliberately creates no sale, payment, inventory movement, or
-- serialized-unit lifecycle mutation. Checkout finalization belongs to 3C.

-- All public commands first authenticate with the 3A helper, then apply their
-- own role boundary. This helper is intentionally internal-only.
create or replace function public.sales_require_role(
  p_actor uuid,
  p_allowed_roles public.app_role[]
)
returns public.app_role
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role public.app_role;
begin
  if p_actor is null or p_allowed_roles is null then
    raise exception 'INVALID_SALES_AUTHORIZATION_CONTEXT' using errcode = '22023';
  end if;

  select p.role
    into v_role
  from public.profiles p
  where p.id = p_actor
    and p.is_active = true;

  if not found or not (v_role = any (p_allowed_roles)) then
    raise insufficient_privilege using message = 'The active profile lacks authority for this sales command';
  end if;

  return v_role;
end
$$;

-- Build a server-authoritative approval snapshot. Client amounts, prices, and
-- COGS never enter this value: the canonical 3A payload supplies normalized
-- intent while this helper resolves catalogue prices and exact basket identity.
create or replace function public.sales_build_checkout_approval_snapshot(
  p_sale_kind public.sale_kind,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_requested_discount_amount numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_canonical jsonb;
  v_customer public.customers;
  v_product public.products;
  v_line jsonb;
  v_payment jsonb;
  v_unit_id uuid;
  v_unit record;
  v_price numeric;
  v_product_id uuid;
  v_variant_id uuid;
  v_condition public.product_condition;
  v_quantity integer;
  v_line_number integer := 0;
  v_serialized_unit_count integer;
  v_seen_unit_ids uuid[] := '{}'::uuid[];
  v_lines jsonb := '[]'::jsonb;
  v_gross_subtotal numeric(14,2) := 0;
  v_initial_payment_total numeric(14,2) := 0;
  v_amount numeric(14,2);
begin
  if p_sale_kind is null
     or p_transaction_on is null
     or p_requested_discount_amount is null
     or p_requested_discount_amount < 0
     or p_requested_discount_amount <> pg_catalog.round(p_requested_discount_amount, 2)
     or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_lines) = 0
     or pg_catalog.jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'INVALID_CHECKOUT_APPROVAL_CONTEXT' using errcode = '22023';
  end if;

  if p_sale_kind = 'CREDIT' and p_customer_id is null then
    raise exception 'CREDIT_CUSTOMER_REQUIRED' using errcode = '22023';
  end if;

  if p_customer_id is not null then
    select c.*
      into v_customer
    from public.customers c
    where c.id = p_customer_id;

    if not found then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0001';
    end if;
  end if;

  v_canonical := public.sales_canonical_checkout_payload(
    p_sale_kind,
    p_customer_id,
    p_transaction_on,
    p_notes,
    p_lines,
    p_payments,
    p_requested_discount_amount
  );

  for v_line in
    select l.value
    from pg_catalog.jsonb_array_elements(v_canonical -> 'lines') l(value)
  loop
    v_line_number := v_line_number + 1;
    v_product_id := nullif(btrim(v_line ->> 'product_id'), '')::uuid;
    v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
    v_condition := nullif(btrim(v_line ->> 'condition'), '')::public.product_condition;
    v_quantity := nullif(btrim(v_line ->> 'quantity'), '')::integer;

    if v_product_id is null or v_condition is null or v_quantity is null or v_quantity <= 0 then
      raise exception 'INVALID_CHECKOUT_LINE' using errcode = '22023';
    end if;

    select p.*
      into v_product
    from public.products p
    where p.id = v_product_id;

    if not found then
      raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    select price.selling_price
      into v_price
    from public.sales_resolve_catalogue_price(v_product_id, v_variant_id, v_condition) price;

    v_serialized_unit_count := pg_catalog.jsonb_array_length(v_line -> 'serialized_unit_ids');
    if v_product.serialized then
      if v_serialized_unit_count <> v_quantity then
        raise exception 'SERIALIZED_QUANTITY_MISMATCH' using errcode = '22023';
      end if;

      for v_unit_id in
        select (u.value #>> '{}')::uuid
        from pg_catalog.jsonb_array_elements(v_line -> 'serialized_unit_ids') u(value)
      loop
        if v_unit_id is null or v_unit_id = any (v_seen_unit_ids) then
          raise exception 'DUPLICATE_SERIALIZED_UNIT' using errcode = '22023';
        end if;
        v_seen_unit_ids := array_append(v_seen_unit_ids, v_unit_id);

        select *
          into v_unit
        from public.sales_serialized_unit_snapshot(v_unit_id);

        if v_unit.product_id is distinct from v_product_id
           or v_unit.variant_id is distinct from v_variant_id
           or v_unit.condition is distinct from v_condition
           or v_unit.status is distinct from 'AVAILABLE' then
          raise exception 'SERIALIZED_UNIT_UNAVAILABLE_OR_MISMATCH' using errcode = 'P0001';
        end if;
      end loop;
    elsif v_serialized_unit_count <> 0 then
      raise exception 'NONSERIALIZED_LINE_HAS_SERIALIZED_UNITS' using errcode = '22023';
    end if;

    v_gross_subtotal := v_gross_subtotal + (v_quantity * v_price)::numeric(14,2);
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'line_number', v_line_number,
      'product_id', v_product_id::text,
      'variant_id', v_variant_id::text,
      'condition', v_condition::text,
      'quantity', v_quantity,
      'serialized_unit_ids', v_line -> 'serialized_unit_ids',
      'tracking_mode', v_product.serialized,
      'selling_price', v_price::numeric(14,2),
      'gross_subtotal', (v_quantity * v_price)::numeric(14,2)
    ));
  end loop;

  if p_requested_discount_amount > v_gross_subtotal then
    raise exception 'DISCOUNT_EXCEEDS_GROSS_SUBTOTAL' using errcode = '22023';
  end if;

  for v_payment in
    select p.value
    from pg_catalog.jsonb_array_elements(v_canonical -> 'payments') p(value)
  loop
    v_amount := nullif(btrim(v_payment ->> 'amount'), '')::numeric(14,2);
    if v_amount is null or v_amount <= 0 then
      raise exception 'INVALID_INITIAL_PAYMENT' using errcode = '22023';
    end if;
    v_initial_payment_total := v_initial_payment_total + v_amount;
  end loop;

  return pg_catalog.jsonb_build_object(
    'sale_kind', p_sale_kind::text,
    'customer', case when p_customer_id is null then null else pg_catalog.jsonb_build_object(
      'id', v_customer.id::text,
      'full_name', v_customer.full_name,
      'phone', v_customer.phone
    ) end,
    'transaction_on', p_transaction_on,
    'notes', nullif(btrim(p_notes), ''),
    'lines', v_lines,
    'payments', v_canonical -> 'payments',
    'initial_payment_total', v_initial_payment_total,
    'gross_subtotal', v_gross_subtotal,
    'requested_discount_amount', p_requested_discount_amount::numeric(14,2),
    'final_total', (v_gross_subtotal - p_requested_discount_amount)::numeric(14,2)
  );
end
$$;

-- Manager below-cost authorization evaluates current inventory only. It does
-- not lock or mutate stock: 3C will revalidate again under its own lock order.
create or replace function public.sales_current_checkout_cogs(p_checkout_snapshot jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_line jsonb;
  v_unit_id uuid;
  v_unit record;
  v_bucket record;
  v_product_id uuid;
  v_variant_id uuid;
  v_condition public.product_condition;
  v_quantity integer;
  v_tracking_mode boolean;
  v_seen_unit_ids uuid[] := '{}'::uuid[];
  v_total_cogs numeric(14,2) := 0;
begin
  if pg_catalog.jsonb_typeof(p_checkout_snapshot) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_checkout_snapshot -> 'lines') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_checkout_snapshot -> 'lines') = 0 then
    raise exception 'INVALID_CHECKOUT_SNAPSHOT' using errcode = '22023';
  end if;

  for v_line in
    select l.value
    from pg_catalog.jsonb_array_elements(p_checkout_snapshot -> 'lines') l(value)
  loop
    v_product_id := nullif(btrim(v_line ->> 'product_id'), '')::uuid;
    v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
    v_condition := nullif(btrim(v_line ->> 'condition'), '')::public.product_condition;
    v_quantity := nullif(btrim(v_line ->> 'quantity'), '')::integer;
    v_tracking_mode := (v_line ->> 'tracking_mode')::boolean;

    if v_product_id is null or v_condition is null or v_quantity is null or v_quantity <= 0
       or v_tracking_mode is null
       or pg_catalog.jsonb_typeof(v_line -> 'serialized_unit_ids') is distinct from 'array' then
      raise exception 'INVALID_CHECKOUT_SNAPSHOT_LINE' using errcode = '22023';
    end if;

    if v_tracking_mode then
      if pg_catalog.jsonb_array_length(v_line -> 'serialized_unit_ids') <> v_quantity then
        raise exception 'SERIALIZED_QUANTITY_MISMATCH' using errcode = '22023';
      end if;

      for v_unit_id in
        select (u.value #>> '{}')::uuid
        from pg_catalog.jsonb_array_elements(v_line -> 'serialized_unit_ids') u(value)
      loop
        if v_unit_id is null or v_unit_id = any (v_seen_unit_ids) then
          raise exception 'DUPLICATE_SERIALIZED_UNIT' using errcode = '22023';
        end if;
        v_seen_unit_ids := array_append(v_seen_unit_ids, v_unit_id);

        select *
          into v_unit
        from public.sales_serialized_unit_snapshot(v_unit_id);

        if v_unit.product_id is distinct from v_product_id
           or v_unit.variant_id is distinct from v_variant_id
           or v_unit.condition is distinct from v_condition
           or v_unit.status is distinct from 'AVAILABLE' then
          raise exception 'SERIALIZED_UNIT_UNAVAILABLE_OR_MISMATCH' using errcode = 'P0001';
        end if;

        v_total_cogs := v_total_cogs + v_unit.acquisition_cost::numeric(14,2);
      end loop;
    else
      if pg_catalog.jsonb_array_length(v_line -> 'serialized_unit_ids') <> 0 then
        raise exception 'NONSERIALIZED_LINE_HAS_SERIALIZED_UNITS' using errcode = '22023';
      end if;

      select *
        into v_bucket
      from public.sales_stock_bucket_snapshot(v_product_id, v_variant_id, v_condition);

      if v_bucket.quantity < v_quantity then
        raise exception 'INSUFFICIENT_CURRENT_STOCK' using errcode = 'P0001';
      end if;

      v_total_cogs := v_total_cogs + (v_bucket.weighted_average_cost * v_quantity)::numeric(14,2);
    end if;
  end loop;

  return v_total_cogs;
end
$$;

create or replace function public.sales_checkout_create_customer(
  p_request_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_address text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_customer public.customers;
  v_full_name text := nullif(btrim(p_full_name), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_email text := nullif(btrim(p_email), '');
  v_address text := nullif(btrim(p_address), '');
  v_fingerprint text;
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(v_actor, array['ADMIN', 'MANAGER', 'STAFF']::public.app_role[]);

  if v_full_name is null then
    raise exception 'CUSTOMER_FULL_NAME_REQUIRED' using errcode = '22023';
  end if;

  v_fingerprint := public.sales_fingerprint(pg_catalog.jsonb_build_object(
    'operation', 'CHECKOUT_CUSTOMER_CREATE',
    'full_name', v_full_name,
    'phone', v_phone,
    'email', v_email,
    'address', v_address
  ));
  v_reservation := public.sales_reserve(p_request_id, 'CHECKOUT_CUSTOMER_CREATE', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  insert into public.customers (full_name, phone, email, address)
  values (v_full_name, v_phone, v_email, v_address)
  returning * into v_customer;

  v_result := pg_catalog.jsonb_build_object(
    'customer_id', v_customer.id::text,
    'full_name', v_customer.full_name,
    'phone', v_customer.phone,
    'email', v_customer.email,
    'address', v_customer.address
  );
  perform public.procurement_audit(
    v_actor, 'SALES_CHECKOUT_CUSTOMER_CREATED', 'CUSTOMER', v_customer.id, null, v_result,
    pg_catalog.jsonb_build_object('operation', 'CHECKOUT_CUSTOMER_CREATE')
  );
  perform public.sales_complete(p_request_id, 'CHECKOUT_CUSTOMER_CREATE', v_fingerprint, v_actor, 'CUSTOMER', v_customer.id, v_result);
  return v_result;
end
$$;

create or replace function public.sales_request_discount(
  p_request_id uuid,
  p_sale_kind public.sale_kind,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_requested_discount_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_snapshot jsonb;
  v_fingerprint text;
  v_request public.sale_discount_requests;
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(v_actor, array['ADMIN', 'MANAGER', 'STAFF']::public.app_role[]);

  v_snapshot := public.sales_build_checkout_approval_snapshot(
    p_sale_kind, p_customer_id, p_transaction_on, p_notes, p_lines, p_payments, p_requested_discount_amount
  );
  if p_requested_discount_amount <= 0 then
    raise exception 'DISCOUNT_MUST_BE_POSITIVE' using errcode = '22023';
  end if;

  v_fingerprint := public.sales_fingerprint(v_snapshot);
  v_reservation := public.sales_reserve(p_request_id, 'DISCOUNT_REQUEST', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  insert into public.sale_discount_requests (
    requested_by, checkout_snapshot, request_fingerprint, requested_discount_amount,
    gross_subtotal_snapshot, customer_id, customer_name_snapshot, sale_kind
  ) values (
    v_actor, v_snapshot, v_fingerprint, p_requested_discount_amount::numeric(14,2),
    (v_snapshot ->> 'gross_subtotal')::numeric(14,2), p_customer_id,
    v_snapshot -> 'customer' ->> 'full_name', p_sale_kind
  ) returning * into v_request;

  v_result := pg_catalog.jsonb_build_object(
    'sale_discount_request_id', v_request.id::text,
    'sale_kind', v_request.sale_kind::text,
    'gross_subtotal', v_request.gross_subtotal_snapshot,
    'requested_discount_amount', v_request.requested_discount_amount,
    'request_fingerprint', v_request.request_fingerprint
  );
  perform public.procurement_audit(
    v_actor, 'SALES_DISCOUNT_REQUESTED', 'SALE_DISCOUNT_REQUEST', v_request.id, null, v_result,
    pg_catalog.jsonb_build_object('operation', 'DISCOUNT_REQUEST')
  );
  perform public.sales_complete(p_request_id, 'DISCOUNT_REQUEST', v_fingerprint, v_actor, 'SALE_DISCOUNT_REQUEST', v_request.id, v_result);
  return v_result;
end
$$;

create or replace function public.sales_decide_discount(
  p_request_id uuid,
  p_sale_discount_request_id uuid,
  p_decision public.sale_approval_decision,
  p_approved_discount_amount numeric,
  p_admin_below_cost_authorized boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_actor_role public.app_role;
  v_request public.sale_discount_requests;
  v_reservation public.sales_operation_reservations;
  v_decision public.sale_discount_decisions;
  v_fingerprint text;
  v_reason text := nullif(btrim(p_reason), '');
  v_manager_percent numeric(5,2);
  v_current_cogs numeric(14,2);
  v_net_total numeric(14,2);
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  v_actor_role := public.sales_require_role(v_actor, array['ADMIN', 'MANAGER']::public.app_role[]);

  if p_decision is null then
    raise exception 'DECISION_REQUIRED' using errcode = '22023';
  end if;

  select r.*
    into v_request
  from public.sale_discount_requests r
  where r.id = p_sale_discount_request_id;
  if not found then
    raise exception 'DISCOUNT_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_fingerprint := public.sales_fingerprint(pg_catalog.jsonb_build_object(
    'operation', 'DISCOUNT_DECISION',
    'sale_discount_request_id', v_request.id::text,
    'request_fingerprint', v_request.request_fingerprint,
    'decision', p_decision::text,
    'approved_discount_amount', p_approved_discount_amount,
    'admin_below_cost_authorized', coalesce(p_admin_below_cost_authorized, false),
    'reason', v_reason
  ));
  v_reservation := public.sales_reserve(p_request_id, 'DISCOUNT_DECISION', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  select r.*
    into v_request
  from public.sale_discount_requests r
  where r.id = p_sale_discount_request_id
  for update;
  if not found then
    raise exception 'DISCOUNT_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_request.requested_by = v_actor then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = v_request.requested_by and p.is_active
      and ((p.role = 'STAFF' and v_actor_role in ('MANAGER', 'ADMIN'))
        or (p.role = 'MANAGER' and v_actor_role = 'ADMIN')
        or (p.role = 'ADMIN' and v_actor_role = 'ADMIN'))
  ) then
    raise insufficient_privilege using message = 'The requested discount decision violates sales approval hierarchy';
  end if;

  if exists (select 1 from public.sale_discount_decisions d where d.sale_discount_request_id = v_request.id) then
    raise exception 'DISCOUNT_REQUEST_ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  if p_decision = 'APPROVED' then
    if p_approved_discount_amount is null
       or p_approved_discount_amount <= 0
       or p_approved_discount_amount <> pg_catalog.round(p_approved_discount_amount, 2)
       or p_approved_discount_amount > v_request.requested_discount_amount then
      raise exception 'INVALID_APPROVED_DISCOUNT' using errcode = '22023';
    end if;

    select s.manager_discount_max_percent
      into v_manager_percent
    from public.sales_settings s
    where s.singleton;
    if not found then
      raise exception 'SALES_SETTINGS_NOT_FOUND' using errcode = 'P0001';
    end if;

    v_current_cogs := public.sales_current_checkout_cogs(v_request.checkout_snapshot);
    v_net_total := (v_request.gross_subtotal_snapshot - p_approved_discount_amount)::numeric(14,2);

    if v_actor_role = 'MANAGER' then
      if p_admin_below_cost_authorized is distinct from false
         or p_approved_discount_amount > (v_request.gross_subtotal_snapshot * v_manager_percent / 100)
         or v_net_total < v_current_cogs then
        raise exception 'MANAGER_DISCOUNT_NOT_AUTHORIZED' using errcode = '42501';
      end if;
    elsif (v_net_total < v_current_cogs) is distinct from p_admin_below_cost_authorized then
      raise exception 'ADMIN_BELOW_COST_AUTHORIZATION_REQUIRED' using errcode = '42501';
    elsif v_net_total < v_current_cogs and v_reason is null then
      raise exception 'ADMIN_BELOW_COST_REASON_REQUIRED' using errcode = '22023';
    end if;

    insert into public.sale_discount_decisions (
      sale_discount_request_id, decision, decided_by, approved_discount_amount,
      manager_discount_max_percent_snapshot, admin_below_cost_authorized, reason
    ) values (
      v_request.id, p_decision, v_actor, p_approved_discount_amount::numeric(14,2),
      v_manager_percent, coalesce(p_admin_below_cost_authorized, false), v_reason
    ) returning * into v_decision;
  else
    if p_approved_discount_amount is not null or p_admin_below_cost_authorized is distinct from false then
      raise exception 'INVALID_REJECTED_DISCOUNT_DECISION' using errcode = '22023';
    end if;

    insert into public.sale_discount_decisions (
      sale_discount_request_id, decision, decided_by, approved_discount_amount,
      manager_discount_max_percent_snapshot, admin_below_cost_authorized, reason
    ) values (
      v_request.id, p_decision, v_actor, null, null, false, v_reason
    ) returning * into v_decision;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'sale_discount_decision_id', v_decision.id::text,
    'sale_discount_request_id', v_decision.sale_discount_request_id::text,
    'decision', v_decision.decision::text,
    'approved_discount_amount', v_decision.approved_discount_amount,
    'admin_below_cost_authorized', v_decision.admin_below_cost_authorized,
    'reason', v_decision.reason
  );
  perform public.procurement_audit(
    v_actor, 'SALES_DISCOUNT_DECIDED', 'SALE_DISCOUNT_DECISION', v_decision.id, null, v_result,
    pg_catalog.jsonb_build_object('operation', 'DISCOUNT_DECISION', 'current_cogs', v_current_cogs)
  );
  perform public.sales_complete(p_request_id, 'DISCOUNT_DECISION', v_fingerprint, v_actor, 'SALE_DISCOUNT_DECISION', v_decision.id, v_result);
  return v_result;
end
$$;

create or replace function public.sales_request_credit(
  p_request_id uuid,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_discount_request_id uuid,
  p_approved_discount_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_customer public.customers;
  v_base_snapshot jsonb;
  v_snapshot jsonb;
  v_discount_fingerprint text;
  v_fingerprint text;
  v_discount_decision_id uuid;
  v_credit_request public.sale_credit_requests;
  v_gross_subtotal numeric(14,2);
  v_final_total numeric(14,2);
  v_initial_payment numeric(14,2);
  v_outstanding numeric(14,2);
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(v_actor, array['ADMIN', 'MANAGER', 'STAFF']::public.app_role[]);

  if p_customer_id is null then
    raise exception 'CREDIT_CUSTOMER_REQUIRED' using errcode = '22023';
  end if;
  select c.*
    into v_customer
  from public.customers c
  where c.id = p_customer_id;
  if not found
     or nullif(btrim(v_customer.full_name), '') is null
     or nullif(btrim(v_customer.phone), '') is null then
    raise exception 'CREDIT_CUSTOMER_NAME_AND_PHONE_REQUIRED' using errcode = '22023';
  end if;

  if p_approved_discount_amount is null
     or p_approved_discount_amount < 0
     or p_approved_discount_amount <> pg_catalog.round(p_approved_discount_amount, 2) then
    raise exception 'INVALID_CREDIT_DISCOUNT_CONTEXT' using errcode = '22023';
  end if;

  v_base_snapshot := public.sales_build_checkout_approval_snapshot(
    'CREDIT', p_customer_id, p_transaction_on, p_notes, p_lines, p_payments, p_approved_discount_amount
  );
  v_discount_fingerprint := public.sales_fingerprint(v_base_snapshot);

  if p_discount_request_id is null then
    if p_approved_discount_amount <> 0 then
      raise exception 'DISCOUNT_APPROVAL_REQUIRED' using errcode = '22023';
    end if;
  else
    v_discount_decision_id := public.sales_validate_discount_approval(
      p_discount_request_id, v_discount_fingerprint, p_approved_discount_amount
    );
  end if;

  v_snapshot := v_base_snapshot || pg_catalog.jsonb_build_object(
    'discount_request_id', p_discount_request_id::text,
    'discount_decision_id', v_discount_decision_id::text,
    'approved_discount_amount', p_approved_discount_amount::numeric(14,2)
  );
  v_gross_subtotal := (v_snapshot ->> 'gross_subtotal')::numeric(14,2);
  v_final_total := (v_snapshot ->> 'final_total')::numeric(14,2);
  v_initial_payment := (v_snapshot ->> 'initial_payment_total')::numeric(14,2);
  v_outstanding := (v_final_total - v_initial_payment)::numeric(14,2);
  if v_initial_payment < 0 or v_initial_payment >= v_final_total or v_outstanding <= 0 then
    raise exception 'INVALID_CREDIT_PAYMENT_PROPOSAL' using errcode = '22023';
  end if;

  v_fingerprint := public.sales_fingerprint(v_snapshot);
  v_reservation := public.sales_reserve(p_request_id, 'CREDIT_REQUEST', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  insert into public.sale_credit_requests (
    requested_by, customer_id, customer_name_snapshot, customer_phone_snapshot,
    checkout_snapshot, request_fingerprint, gross_subtotal_snapshot,
    final_total_snapshot, initial_payment_snapshot, proposed_outstanding_credit
  ) values (
    v_actor, v_customer.id, v_customer.full_name, v_customer.phone,
    v_snapshot, v_fingerprint, v_gross_subtotal, v_final_total, v_initial_payment, v_outstanding
  ) returning * into v_credit_request;

  v_result := pg_catalog.jsonb_build_object(
    'sale_credit_request_id', v_credit_request.id::text,
    'customer_id', v_credit_request.customer_id::text,
    'gross_subtotal', v_credit_request.gross_subtotal_snapshot,
    'final_total', v_credit_request.final_total_snapshot,
    'initial_payment', v_credit_request.initial_payment_snapshot,
    'proposed_outstanding_credit', v_credit_request.proposed_outstanding_credit,
    'request_fingerprint', v_credit_request.request_fingerprint
  );
  perform public.procurement_audit(
    v_actor, 'SALES_CREDIT_REQUESTED', 'SALE_CREDIT_REQUEST', v_credit_request.id, null, v_result,
    pg_catalog.jsonb_build_object('operation', 'CREDIT_REQUEST', 'discount_request_id', p_discount_request_id::text)
  );
  perform public.sales_complete(p_request_id, 'CREDIT_REQUEST', v_fingerprint, v_actor, 'SALE_CREDIT_REQUEST', v_credit_request.id, v_result);
  return v_result;
end
$$;

create or replace function public.sales_decide_credit(
  p_request_id uuid,
  p_sale_credit_request_id uuid,
  p_decision public.sale_approval_decision,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_actor_role public.app_role;
  v_request public.sale_credit_requests;
  v_reservation public.sales_operation_reservations;
  v_decision public.sale_credit_decisions;
  v_fingerprint text;
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  v_actor_role := public.sales_require_role(v_actor, array['ADMIN', 'MANAGER']::public.app_role[]);

  if p_decision is null then
    raise exception 'DECISION_REQUIRED' using errcode = '22023';
  end if;

  select r.*
    into v_request
  from public.sale_credit_requests r
  where r.id = p_sale_credit_request_id;
  if not found then
    raise exception 'CREDIT_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  v_fingerprint := public.sales_fingerprint(pg_catalog.jsonb_build_object(
    'operation', 'CREDIT_DECISION',
    'sale_credit_request_id', v_request.id::text,
    'request_fingerprint', v_request.request_fingerprint,
    'decision', p_decision::text,
    'reason', v_reason
  ));
  v_reservation := public.sales_reserve(p_request_id, 'CREDIT_DECISION', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  select r.*
    into v_request
  from public.sale_credit_requests r
  where r.id = p_sale_credit_request_id
  for update;
  if not found then
    raise exception 'CREDIT_REQUEST_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_request.requested_by = v_actor then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = v_request.requested_by and p.is_active
      and ((p.role = 'STAFF' and v_actor_role in ('MANAGER', 'ADMIN'))
        or (p.role = 'MANAGER' and v_actor_role = 'ADMIN')
        or (p.role = 'ADMIN' and v_actor_role = 'ADMIN'))
  ) then
    raise insufficient_privilege using message = 'The requested credit decision violates sales approval hierarchy';
  end if;
  if exists (select 1 from public.sale_credit_decisions d where d.sale_credit_request_id = v_request.id) then
    raise exception 'CREDIT_REQUEST_ALREADY_DECIDED' using errcode = 'P0001';
  end if;

  insert into public.sale_credit_decisions (sale_credit_request_id, decision, decided_by, reason)
  values (v_request.id, p_decision, v_actor, v_reason)
  returning * into v_decision;

  v_result := pg_catalog.jsonb_build_object(
    'sale_credit_decision_id', v_decision.id::text,
    'sale_credit_request_id', v_decision.sale_credit_request_id::text,
    'decision', v_decision.decision::text,
    'reason', v_decision.reason
  );
  perform public.procurement_audit(
    v_actor, 'SALES_CREDIT_DECIDED', 'SALE_CREDIT_DECISION', v_decision.id, null, v_result,
    pg_catalog.jsonb_build_object('operation', 'CREDIT_DECISION')
  );
  perform public.sales_complete(p_request_id, 'CREDIT_DECISION', v_fingerprint, v_actor, 'SALE_CREDIT_DECISION', v_decision.id, v_result);
  return v_result;
end
$$;

create or replace function public.sales_update_settings(
  p_request_id uuid,
  p_manager_discount_max_percent numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_settings public.sales_settings;
  v_old_percent numeric(5,2);
  v_fingerprint text;
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(v_actor, array['ADMIN']::public.app_role[]);

  if p_manager_discount_max_percent is null
     or p_manager_discount_max_percent < 0
     or p_manager_discount_max_percent > 100
     or p_manager_discount_max_percent <> pg_catalog.round(p_manager_discount_max_percent, 2) then
    raise exception 'INVALID_MANAGER_DISCOUNT_MAX_PERCENT' using errcode = '22023';
  end if;

  v_fingerprint := public.sales_fingerprint(pg_catalog.jsonb_build_object(
    'operation', 'SALES_SETTINGS_UPDATE',
    'manager_discount_max_percent', p_manager_discount_max_percent::numeric(5,2)
  ));
  v_reservation := public.sales_reserve(p_request_id, 'SALES_SETTINGS_UPDATE', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  select s.*
    into v_settings
  from public.sales_settings s
  where s.singleton
  for update;
  if not found then
    raise exception 'SALES_SETTINGS_NOT_FOUND' using errcode = 'P0001';
  end if;
  v_old_percent := v_settings.manager_discount_max_percent;

  update public.sales_settings
  set manager_discount_max_percent = p_manager_discount_max_percent::numeric(5,2),
      updated_by = v_actor,
      updated_at = pg_catalog.now()
  where singleton
  returning * into v_settings;

  v_result := pg_catalog.jsonb_build_object(
    'manager_discount_max_percent', v_settings.manager_discount_max_percent,
    'updated_at', v_settings.updated_at
  );
  perform public.procurement_audit(
    v_actor, 'SALES_SETTINGS_UPDATED', 'SALES_SETTINGS', null,
    pg_catalog.jsonb_build_object('manager_discount_max_percent', v_old_percent), v_result,
    pg_catalog.jsonb_build_object('operation', 'SALES_SETTINGS_UPDATE')
  );
  perform public.sales_complete(p_request_id, 'SALES_SETTINGS_UPDATE', v_fingerprint, v_actor, 'SALES_SETTINGS', v_actor, v_result);
  return v_result;
end
$$;

-- Internal helpers and all pre-existing 3A internals remain unavailable to
-- browser roles. Only the six business commands are callable by authenticated
-- users; each command enforces its own active-profile and role checks.
revoke all on function
  public.sales_require_role(uuid, public.app_role[]),
  public.sales_build_checkout_approval_snapshot(public.sale_kind, uuid, date, text, jsonb, jsonb, numeric),
  public.sales_current_checkout_cogs(jsonb)
from public, anon, authenticated;

revoke all on function
  public.sales_checkout_create_customer(uuid, text, text, text, text),
  public.sales_request_discount(uuid, public.sale_kind, uuid, date, text, jsonb, jsonb, numeric),
  public.sales_decide_discount(uuid, uuid, public.sale_approval_decision, numeric, boolean, text),
  public.sales_request_credit(uuid, uuid, date, text, jsonb, jsonb, uuid, numeric),
  public.sales_decide_credit(uuid, uuid, public.sale_approval_decision, text),
  public.sales_update_settings(uuid, numeric)
from public, anon, authenticated;

grant execute on function
  public.sales_checkout_create_customer(uuid, text, text, text, text),
  public.sales_request_discount(uuid, public.sale_kind, uuid, date, text, jsonb, jsonb, numeric),
  public.sales_decide_discount(uuid, uuid, public.sale_approval_decision, numeric, boolean, text),
  public.sales_request_credit(uuid, uuid, date, text, jsonb, jsonb, uuid, numeric),
  public.sales_decide_credit(uuid, uuid, public.sale_approval_decision, text),
  public.sales_update_settings(uuid, numeric)
to authenticated;
