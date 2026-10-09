-- Phase 7B-B source-only migration. This is intentionally unapplied here.
-- It adds a strict quote boundary for provisional, cash-only, nonserialized
-- offline checkout and delegates all sale writes to sales_finalize_checkout.

alter table public.catalogue_prices
  add column if not exists quote_revision bigint not null default 1
  check (quote_revision > 0);

create or replace function public.increment_catalogue_price_quote_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.quote_revision := old.quote_revision + 1;
  return new;
end
$$;

drop trigger if exists catalogue_prices_quote_revision on public.catalogue_prices;
create trigger catalogue_prices_quote_revision
before update on public.catalogue_prices
for each row execute function public.increment_catalogue_price_quote_revision();

-- This projection replaces no existing lookup. It adds only the safe price
-- identity/version required to compose an exact offline quote.
create or replace function public.staff_offline_catalogue_snapshot()
returns table(
  product_id uuid,
  product_name text,
  product_sku text,
  product_barcode text,
  brand_name text,
  category_name text,
  serialized boolean,
  variant_id uuid,
  variant_label text,
  variant_sku text,
  variant_barcode text,
  condition public.product_condition,
  quantity integer,
  catalogue_price_id uuid,
  price_revision bigint,
  selling_price numeric
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  return query
  select p.id, p.name, p.sku, p.barcode, b.name, c.name, p.serialized,
    v.id, v.label, v.sku, v.barcode, cp.condition, coalesce(sb.quantity, 0),
    cp.id, cp.quote_revision, cp.selling_price
  from public.products p
  left join public.brands b on b.id = p.brand_id and b.active
  left join public.categories c on c.id = p.category_id and c.active
  left join public.product_variants v on v.product_id = p.id and v.active
  join public.catalogue_prices cp on cp.product_id = p.id
    and cp.variant_id is not distinct from v.id and cp.active
  left join public.stock_buckets sb on sb.product_id = p.id
    and sb.variant_id is not distinct from v.id and sb.condition = cp.condition
  where p.active and not p.serialized
  order by p.name, v.label nulls first, cp.condition;
end
$$;

create table public.offline_sale_checkout_reservations (
  operation_id uuid primary key,
  request_id uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((completed_at is null and result is null) or (completed_at is not null and result is not null))
);
alter table public.offline_sale_checkout_reservations enable row level security;
revoke all on table public.offline_sale_checkout_reservations from public, anon, authenticated;

create or replace function public.offline_sales_checkout(
  p_operation_id uuid,
  p_request_id uuid,
  p_business_date date,
  p_customer_id uuid,
  p_notes text,
  p_lines jsonb,
  p_payment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_reservation public.offline_sale_checkout_reservations;
  v_line jsonb;
  v_quote jsonb;
  v_product public.products;
  v_variant public.product_variants;
  v_price public.catalogue_prices;
  v_customer public.customers;
  v_product_id uuid;
  v_variant_id uuid;
  v_price_id uuid;
  v_condition public.product_condition;
  v_quantity integer;
  v_quote_revision bigint;
  v_quote_price numeric(14,2);
  v_payment_amount numeric(14,2);
  v_total numeric(14,2) := 0;
  v_checkout_lines jsonb := '[]'::jsonb;
  v_canonical jsonb;
  v_fingerprint text;
  v_result jsonb;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_actor is null or v_role not in ('STAFF'::public.app_role, 'MANAGER'::public.app_role) then
    raise insufficient_privilege using message = 'OFFLINE_SALE_CHECKOUT_NOT_AUTHORIZED';
  end if;

  if p_operation_id is null or p_request_id is null or p_business_date is null
    or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_lines) = 0
    or pg_catalog.jsonb_typeof(p_payment) is distinct from 'object'
    or exists (select 1 from pg_catalog.jsonb_object_keys(p_payment) k(key) where k.key not in ('method', 'amount'))
    or pg_catalog.jsonb_typeof(p_payment -> 'method') is distinct from 'string'
    or p_payment ->> 'method' <> 'CASH'
    or pg_catalog.jsonb_typeof(p_payment -> 'amount') is distinct from 'string'
    or (p_payment ->> 'amount') !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$'
    or (p_payment ->> 'amount') = '0.00' then
    raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
  end if;

  -- Build the canonical fingerprint before reservation; it includes every
  -- business-semantic quote field, not a client-computed total or any cost.
  v_canonical := pg_catalog.jsonb_build_object(
    'business_date', p_business_date,
    'customer_id', p_customer_id::text,
    'notes', nullif(pg_catalog.btrim(p_notes), ''),
    'lines', coalesce((
      select pg_catalog.jsonb_agg(value order by value ->> 'product_id', value ->> 'variant_id', value ->> 'condition', value ->> 'quantity', value -> 'quote')
      from pg_catalog.jsonb_array_elements(p_lines)
    ), '[]'::jsonb),
    'payment', p_payment
  );
  v_fingerprint := public.sales_fingerprint(v_canonical);

  insert into public.offline_sale_checkout_reservations(operation_id, request_id, actor_id, request_fingerprint)
  values (p_operation_id, p_request_id, v_actor, v_fingerprint)
  on conflict do nothing
  returning * into v_reservation;
  if not found then
    select * into v_reservation
    from public.offline_sale_checkout_reservations
    where operation_id = p_operation_id
    for update;
    if not found then
      -- A request ID can never be reused for another operation. Lock it so
      -- concurrent lost-response retries classify consistently as conflict.
      select * into v_reservation
      from public.offline_sale_checkout_reservations
      where request_id = p_request_id
      for update;
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    elsif v_reservation.request_id is distinct from p_request_id
      or v_reservation.actor_id is distinct from v_actor
      or v_reservation.request_fingerprint is distinct from v_fingerprint then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
  end if;
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id for key share;
    if not found then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
  end if;

  -- Lock catalogues in canonical payload order before inventory. Exact price
  -- identity/revision/value is mandatory: replay never silently reprices.
  for v_line in
    select value from pg_catalog.jsonb_array_elements(p_lines)
    order by value ->> 'product_id', value ->> 'variant_id', value ->> 'condition'
  loop
    if pg_catalog.jsonb_typeof(v_line) <> 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(v_line) k(key) where k.key not in ('product_id', 'variant_id', 'condition', 'quantity', 'quote'))
      or pg_catalog.jsonb_typeof(v_line -> 'quote') is distinct from 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(v_line -> 'quote') k(key) where k.key not in ('catalogue_price_id', 'price_revision', 'quoted_selling_price')) then
      raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
    end if;
    v_quote := v_line -> 'quote';
    begin
      v_product_id := nullif(pg_catalog.btrim(v_line ->> 'product_id'), '')::uuid;
      v_variant_id := nullif(pg_catalog.btrim(v_line ->> 'variant_id'), '')::uuid;
      v_condition := upper(pg_catalog.btrim(v_line ->> 'condition'))::public.product_condition;
      v_quantity := nullif(pg_catalog.btrim(v_line ->> 'quantity'), '')::integer;
      v_price_id := nullif(pg_catalog.btrim(v_quote ->> 'catalogue_price_id'), '')::uuid;
      v_quote_revision := nullif(pg_catalog.btrim(v_quote ->> 'price_revision'), '')::bigint;
      v_quote_price := nullif(pg_catalog.btrim(v_quote ->> 'quoted_selling_price'), '')::numeric(14,2);
    exception when others then
      raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
    end;
    if v_quantity is null or v_quantity <= 0 or v_quote_revision is null or v_quote_revision < 1
      or v_quote_price is null or v_quote_price < 0 or v_quote_price <> pg_catalog.round(v_quote_price, 2)
      or (v_quote ->> 'quoted_selling_price') !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$' then
      raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
    end if;
    select * into v_product from public.products p where p.id = v_product_id for key share;
    if not found or not v_product.active then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    if v_product.serialized then raise exception 'OFFLINE_SERIALIZED_SALE_NOT_SUPPORTED' using errcode = '22023'; end if;
    if v_variant_id is not null then
      select * into v_variant from public.product_variants v where v.id = v_variant_id and v.product_id = v_product_id for key share;
      if not found or not v_variant.active then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;
    end if;
    select * into v_price from public.catalogue_prices cp
    where cp.id = v_price_id and cp.product_id = v_product_id
      and cp.variant_id is not distinct from v_variant_id and cp.condition = v_condition
    for update;
    if not found or not v_price.active or v_price.quote_revision <> v_quote_revision or v_price.selling_price <> v_quote_price then
      raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(v_checkout_lines) prior(value)
      where prior.value ->> 'product_id' = v_product_id::text
        and prior.value ->> 'variant_id' is not distinct from v_variant_id::text
        and prior.value ->> 'condition' = v_condition::text
    ) then raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023'; end if;
    v_checkout_lines := v_checkout_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'product_id', v_product_id::text, 'variant_id', v_variant_id::text,
      'condition', v_condition::text, 'quantity', v_quantity, 'serialized_unit_ids', '[]'::jsonb
    ));
    v_total := v_total + (v_quote_price * v_quantity);
  end loop;

  begin v_payment_amount := (p_payment ->> 'amount')::numeric(14,2); exception when others then
    raise exception 'INVALID_OFFLINE_SALE_CHECKOUT' using errcode = '22023';
  end;
  if v_payment_amount <> v_total then raise exception 'OFFLINE_SALE_CHECKOUT_CONFLICT' using errcode = 'P0001'; end if;

  -- The established finalizer owns stock locks, WAC/COGS, immutable sale rows,
  -- payment insertion, inventory effects, audit, and its own durable request
  -- reservation. This outer reservation returns the same result first on an
  -- exact lost-response retry before any mutable catalogue or stock check.
  v_result := public.sales_finalize_checkout(
    p_request_id, 'ORDINARY'::public.sale_kind, p_customer_id, p_business_date,
    nullif(pg_catalog.btrim(p_notes), ''), v_checkout_lines,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('amount', v_payment_amount, 'method', 'CASH', 'paid_on', p_business_date, 'reference', null, 'notes', null)),
    null, 0, null
  );
  update public.offline_sale_checkout_reservations
  set result = v_result, completed_at = now()
  where operation_id = p_operation_id;
  return v_result;
end
$$;

revoke all on function public.increment_catalogue_price_quote_revision() from public, anon, authenticated;
revoke all on function public.staff_offline_catalogue_snapshot() from public, anon, authenticated;
grant execute on function public.staff_offline_catalogue_snapshot() to authenticated;
revoke all on function public.offline_sales_checkout(uuid, uuid, date, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.offline_sales_checkout(uuid, uuid, date, uuid, text, jsonb, jsonb) to authenticated;
