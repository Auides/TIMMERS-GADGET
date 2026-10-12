-- Phase 7B-C source-only migration.  It is intentionally unapplied here.
-- It adds a cost-safe serialized checkout projection and extends the existing
-- provisional wrapper; the established finalizer remains sale authority.

create or replace function public.staff_offline_sellable_serialized_snapshot()
returns table(
  unit_id uuid, product_id uuid, product_name text, product_sku text,
  product_barcode text, product_model text, brand_name text, category_name text,
  variant_id uuid, variant_label text, variant_sku text, variant_barcode text,
  condition public.product_condition, status public.unit_status,
  catalogue_price_id uuid, price_revision bigint, selling_price numeric,
  identifier_type public.identifier_type, identifier_value text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  return query
  select u.id, p.id, p.name, p.sku, p.barcode, p.model, b.name, c.name,
    v.id, v.label, v.sku, v.barcode, u.condition, u.status,
    cp.id, cp.quote_revision, cp.selling_price, i.identifier_type, i.normalized_value
  from public.serialized_units u
  join public.products p on p.id = u.product_id and p.active
  left join public.brands b on b.id = p.brand_id and b.active
  left join public.categories c on c.id = p.category_id and c.active
  left join public.product_variants v on v.id = u.variant_id
  join public.catalogue_prices cp on cp.product_id = p.id
    and cp.variant_id is not distinct from u.variant_id
    and cp.condition = u.condition and cp.active
  join public.unit_identifiers i on i.unit_id = u.id
  where u.status = 'AVAILABLE'
    and ((u.variant_id is null and not exists (
      select 1 from public.product_variants av where av.product_id = p.id and av.active
    )) or (u.variant_id is not null and v.active))
  order by p.name, v.label nulls first, u.condition, u.id, i.identifier_type, i.normalized_value;
end
$$;

create or replace function public.offline_sales_checkout(
  p_operation_id uuid, p_request_id uuid, p_business_date date,
  p_customer_id uuid, p_notes text, p_lines jsonb, p_payment jsonb
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid; v_role public.app_role; v_reservation public.offline_sale_checkout_reservations;
  v_line jsonb; v_quote jsonb; v_product public.products; v_variant public.product_variants;
  v_price public.catalogue_prices; v_customer public.customers;
  v_product_id uuid; v_variant_id uuid; v_price_id uuid; v_condition public.product_condition;
  v_quantity integer; v_quote_revision bigint; v_quote_price numeric(14,2);
  v_payment_amount numeric(14,2); v_total numeric(14,2) := 0;
  v_unit_id uuid; v_seen_units uuid[] := '{}'::uuid[]; v_line_units uuid[];
  v_checkout_lines jsonb := '[]'::jsonb; v_canonical jsonb; v_fingerprint text; v_result jsonb;
begin
  perform public.require_active_profile(); v_actor := auth.uid(); v_role := public.current_role();
  if v_actor is null or v_role not in ('STAFF'::public.app_role, 'MANAGER'::public.app_role) then
    raise insufficient_privilege using message = 'OFFLINE_SALE_CHECKOUT_NOT_AUTHORIZED';
  end if;
  if p_operation_id is null or p_request_id is null or p_business_date is null
    or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0
    or jsonb_typeof(p_payment) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(p_payment) k(key) where k.key not in ('method', 'amount'))
    or p_payment ->> 'method' <> 'CASH' or jsonb_typeof(p_payment -> 'amount') is distinct from 'string'
    or (p_payment ->> 'amount') !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$' or (p_payment ->> 'amount') = '0.00' then
    raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
  end if;

  -- Canonical, order-independent identity includes sorted exact unit IDs.
  select jsonb_build_object('business_date', p_business_date, 'customer_id', p_customer_id::text,
    'notes', nullif(btrim(p_notes), ''), 'lines', coalesce(jsonb_agg(jsonb_build_object(
      'product_id', value ->> 'product_id', 'variant_id', value ->> 'variant_id',
      'condition', value ->> 'condition', 'quantity', value ->> 'quantity', 'quote', value -> 'quote',
      'serialized_unit_ids', coalesce((select jsonb_agg(unit_id order by unit_id)
        from jsonb_array_elements_text(coalesce(value -> 'serialized_unit_ids', '[]'::jsonb)) unit_id), '[]'::jsonb)
    ) order by value ->> 'product_id', value ->> 'variant_id', value ->> 'condition'), '[]'::jsonb),
    'payment', p_payment)
  into v_canonical from jsonb_array_elements(p_lines);
  v_fingerprint := public.sales_fingerprint(v_canonical);

  insert into public.offline_sale_checkout_reservations(operation_id, request_id, actor_id, request_fingerprint)
  values (p_operation_id, p_request_id, v_actor, v_fingerprint) on conflict do nothing returning * into v_reservation;
  if not found then
    select * into v_reservation from public.offline_sale_checkout_reservations where operation_id = p_operation_id for update;
    if not found then
      select * into v_reservation from public.offline_sale_checkout_reservations where request_id = p_request_id for update;
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    elsif v_reservation.request_id is distinct from p_request_id or v_reservation.actor_id is distinct from v_actor or v_reservation.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
  end if;
  -- A lost-response retry succeeds before inspecting a unit now made SOLD by itself.
  if v_reservation.completed_at is not null then return v_reservation.result; end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id for key share;
    if not found then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) order by value ->> 'product_id', value ->> 'variant_id', value ->> 'condition' loop
    if jsonb_typeof(v_line) <> 'object'
      or exists (select 1 from jsonb_object_keys(v_line) k(key) where k.key not in ('product_id', 'variant_id', 'condition', 'quantity', 'serialized_unit_ids', 'quote'))
      or jsonb_typeof(v_line -> 'quote') is distinct from 'object'
      or jsonb_typeof(v_line -> 'serialized_unit_ids') is distinct from 'array'
      or exists (select 1 from jsonb_object_keys(v_line -> 'quote') k(key) where k.key not in ('catalogue_price_id', 'price_revision', 'quoted_selling_price')) then
      raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
    end if;
    v_quote := v_line -> 'quote';
    begin
      v_product_id := nullif(btrim(v_line ->> 'product_id'), '')::uuid; v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
      v_condition := upper(btrim(v_line ->> 'condition'))::public.product_condition; v_quantity := nullif(btrim(v_line ->> 'quantity'), '')::integer;
      v_price_id := nullif(btrim(v_quote ->> 'catalogue_price_id'), '')::uuid; v_quote_revision := nullif(btrim(v_quote ->> 'price_revision'), '')::bigint;
      v_quote_price := nullif(btrim(v_quote ->> 'quoted_selling_price'), '')::numeric(14,2);
      select coalesce(array_agg(nullif(btrim(value), '')::uuid order by nullif(btrim(value), '')::uuid), '{}'::uuid[]) into v_line_units from jsonb_array_elements_text(v_line -> 'serialized_unit_ids');
    exception when others then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end;
    if v_quantity is null or v_quantity <= 0 or v_quote_revision is null or v_quote_revision < 1 or v_quote_price is null or v_quote_price < 0 or v_quote_price <> round(v_quote_price, 2) or (v_quote ->> 'quoted_selling_price') !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$' then
      raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
    end if;
    if cardinality(v_line_units) <> jsonb_array_length(v_line -> 'serialized_unit_ids') or cardinality(v_line_units) <> cardinality(array(select distinct unnest(v_line_units))) then
      raise exception 'DUPLICATE_SERIALIZED_UNIT' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_line_units) id where id = any(v_seen_units)) then raise exception 'DUPLICATE_SERIALIZED_UNIT' using errcode = '22023'; end if;
    v_seen_units := v_seen_units || v_line_units;
    select * into v_product from public.products p where p.id = v_product_id for key share;
    if not found or not v_product.active then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    if v_variant_id is null then
      if exists (select 1 from public.product_variants pv where pv.product_id = v_product_id and pv.active) then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    else
      select * into v_variant from public.product_variants v where v.id = v_variant_id and v.product_id = v_product_id for key share;
      if not found or not v_variant.active then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    end if;
    if v_product.serialized and cardinality(v_line_units) <> v_quantity then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end if;
    if not v_product.serialized and cardinality(v_line_units) <> 0 then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end if;
    select * into v_price from public.catalogue_prices cp where cp.id = v_price_id and cp.product_id = v_product_id and cp.variant_id is not distinct from v_variant_id and cp.condition = v_condition for update;
    if not found or not v_price.active or v_price.quote_revision <> v_quote_revision or v_price.selling_price <> v_quote_price then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    if exists (select 1 from jsonb_array_elements(v_checkout_lines) prior(value) where prior.value ->> 'product_id' = v_product_id::text and prior.value ->> 'variant_id' is not distinct from v_variant_id::text and prior.value ->> 'condition' = v_condition::text) then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end if;
    v_checkout_lines := v_checkout_lines || jsonb_build_array(jsonb_build_object('product_id', v_product_id::text, 'variant_id', v_variant_id::text, 'condition', v_condition::text, 'quantity', v_quantity, 'serialized_unit_ids', to_jsonb(v_line_units)));
    v_total := v_total + v_quote_price * v_quantity;
  end loop;
  begin v_payment_amount := (p_payment ->> 'amount')::numeric(14,2); exception when others then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end;
  if v_payment_amount <> v_total then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
  -- All unit locks, availability/product/variant/condition checks, COGS, stock,
  -- sale/payment/effect/audit writes remain only in the authoritative finalizer.
  v_result := public.sales_finalize_checkout(p_request_id, 'ORDINARY'::public.sale_kind, p_customer_id, p_business_date, nullif(btrim(p_notes), ''), v_checkout_lines,
    jsonb_build_array(jsonb_build_object('amount', v_payment_amount, 'method', 'CASH', 'paid_on', p_business_date, 'reference', null, 'notes', null)), null, 0, null);
  update public.offline_sale_checkout_reservations set result = v_result, completed_at = now() where operation_id = p_operation_id;
  return v_result;
end
$$;

revoke all on function public.staff_offline_sellable_serialized_snapshot() from public, anon, authenticated;
grant execute on function public.staff_offline_sellable_serialized_snapshot() to authenticated;
revoke all on function public.offline_sales_checkout(uuid, uuid, date, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.offline_sales_checkout(uuid, uuid, date, uuid, text, jsonb, jsonb) to authenticated;
