-- Phase 5 proposal only. Do not apply until Product Owner review approval.
-- Lock order for opening stock: idempotency batch -> product -> variant ->
-- exact non-serialized bucket -> serialized unit identifiers.

-- The approved foundation installs pgcrypto. Supabase installs extensions in
-- the extensions schema; fail closed if that dependency is not present there
-- rather than widening SECURITY DEFINER search paths to resolve digest().
do $$
begin
  if not exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions'
  ) or to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'The pgcrypto extension must be installed in the extensions schema';
  end if;
end $$;

-- One canonical implementation is used by both the identifier trigger and
-- request fingerprinting. This preserves the foundation's normalisation rule.
create or replace function public.normalize_identifier_value(p_value text) returns text
language plpgsql immutable strict set search_path=pg_catalog,public,pg_temp as $$
declare normalized text := upper(btrim(p_value));
begin
  if normalized = '' then raise exception 'Identifier cannot be empty'; end if;
  return normalized;
end $$;
create or replace function public.normalize_identifier() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  new.normalized_value = public.normalize_identifier_value(new.normalized_value);
  return new;
end $$;

create table public.opening_stock_batches (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_fingerprint text not null check(request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  notes text check(notes is null or (notes = btrim(notes) and notes <> '')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.opening_stock_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.opening_stock_batches(id) on delete restrict,
  product_id uuid not null,
  variant_id uuid,
  serialized boolean not null,
  condition public.product_condition not null,
  quantity integer not null check(quantity > 0),
  unit_cost numeric(14,2) not null check(unit_cost >= 0),
  warranty_start date,
  warranty_expiry date,
  created_at timestamptz not null default now(),
  foreign key(product_id, serialized) references public.products(id, serialized) on delete restrict,
  foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  check((not serialized) or quantity = 1),
  check(serialized or (warranty_start is null and warranty_expiry is null)),
  check(warranty_expiry is null or warranty_start is null or warranty_expiry >= warranty_start)
);

create index opening_stock_lines_batch_id_idx on public.opening_stock_lines(batch_id);
create index opening_stock_lines_product_variant_idx on public.opening_stock_lines(product_id, variant_id);

-- Catalogue prices are now authoritative. These legacy snapshots must not force
-- a fabricated selling price when the shop enters opening stock before pricing it.
alter table public.stock_buckets alter column selling_price drop not null;
alter table public.serialized_units alter column current_selling_price drop not null;

alter table public.serialized_units add column opening_stock_line_id uuid references public.opening_stock_lines(id) on delete restrict;
alter table public.serialized_units alter column purchase_item_id drop not null;
alter table public.serialized_units add constraint serialized_units_acquisition_origin_xor
  check(num_nonnulls(purchase_item_id, opening_stock_line_id) = 1);
create unique index serialized_units_opening_stock_line_id_key
  on public.serialized_units(opening_stock_line_id) where opening_stock_line_id is not null;

-- Preserve existing purchase-origin checks while adding the opening-stock origin.
create or replace function public.validate_serialized_purchase_origin() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  item public.purchase_items;
  opening_line public.opening_stock_lines;
  product_is_serialized boolean;
  linked_unit_count integer;
begin
  select serialized into product_is_serialized from public.products where id = new.product_id;
  if product_is_serialized is distinct from true then
    raise exception 'Serialized units may reference only serialized products';
  end if;

  if num_nonnulls(new.purchase_item_id, new.opening_stock_line_id) <> 1 then
    raise exception 'A serialized unit requires exactly one acquisition origin';
  end if;

  if new.purchase_item_id is not null then
    select * into item from public.purchase_items where id = new.purchase_item_id for update;
    if not found or item.product_id <> new.product_id or item.variant_id is distinct from new.variant_id then
      raise exception 'Serialized unit purchase origin must match its product and variant';
    end if;
    if new.acquisition_cost is distinct from item.unit_cost then
      raise exception 'Serialized acquisition cost must equal its purchase item cost';
    end if;
    if tg_op = 'INSERT' then
      select count(*) into linked_unit_count from public.serialized_units where purchase_item_id = new.purchase_item_id;
      if linked_unit_count >= item.quantity then
        raise exception 'Serialized unit count cannot exceed the purchase item quantity';
      end if;
    end if;
  else
    select * into opening_line from public.opening_stock_lines where id = new.opening_stock_line_id for key share;
    if not found or not opening_line.serialized or opening_line.product_id <> new.product_id or opening_line.variant_id is distinct from new.variant_id then
      raise exception 'Serialized opening stock origin must match its product and variant';
    end if;
    if new.acquisition_cost is distinct from opening_line.unit_cost then
      raise exception 'Serialized acquisition cost must equal its opening stock cost';
    end if;
    if tg_op = 'INSERT' and new.condition is distinct from opening_line.condition then
      raise exception 'Serialized opening stock condition must match its opening stock origin';
    end if;
    if tg_op = 'INSERT' and (new.warranty_start is distinct from opening_line.warranty_start or new.warranty_expiry is distinct from opening_line.warranty_expiry) then
      raise exception 'Serialized opening stock warranty data must match its opening stock origin';
    end if;
    if tg_op = 'INSERT' then
      select count(*) into linked_unit_count from public.serialized_units where opening_stock_line_id = new.opening_stock_line_id;
      if linked_unit_count >= opening_line.quantity then
        raise exception 'Serialized unit count cannot exceed the opening stock line quantity';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.purchase_item_id is distinct from old.purchase_item_id or
    new.opening_stock_line_id is distinct from old.opening_stock_line_id or
    new.acquisition_cost is distinct from old.acquisition_cost
  ) then
    raise exception 'Serialized acquisition origin and cost are immutable';
  end if;
  if tg_op = 'UPDATE' and (new.warranty_start is distinct from old.warranty_start or new.warranty_expiry is distinct from old.warranty_expiry) then
    raise exception 'Serialized warranty history requires a separate audited correction workflow';
  end if;
  return new;
end $$;

create type public.inventory_adjustment_request_status as enum ('OPEN', 'RESOLVED', 'REJECTED');
create table public.inventory_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid,
  unit_id uuid references public.serialized_units(id) on delete restrict,
  condition public.product_condition,
  requested_quantity integer not null check(requested_quantity <> 0),
  reason text not null check(reason = btrim(reason) and reason <> ''),
  status public.inventory_adjustment_request_status not null default 'OPEN',
  requested_by uuid not null references public.profiles(id) on delete restrict,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  rejection_reason text check(rejection_reason is null or (rejection_reason = btrim(rejection_reason) and rejection_reason <> '')),
  created_at timestamptz not null default now(),
  foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  check((unit_id is not null) or (condition is not null)),
  check((unit_id is null) or condition is null),
  check((unit_id is null) or requested_quantity = -1),
  check((status = 'OPEN' and reviewed_by is null and reviewed_at is null and rejection_reason is null) or (status = 'RESOLVED' and reviewed_by is not null and reviewed_at is not null and rejection_reason is null) or (status = 'REJECTED' and reviewed_by is not null and reviewed_at is not null and rejection_reason is not null))
);
create index inventory_adjustment_requests_requester_created_idx on public.inventory_adjustment_requests(requested_by, created_at desc);
create index inventory_adjustment_requests_open_created_idx on public.inventory_adjustment_requests(created_at desc) where status = 'OPEN';
create index inventory_adjustment_requests_product_variant_idx on public.inventory_adjustment_requests(product_id, variant_id);
create index inventory_adjustment_requests_unit_id_idx on public.inventory_adjustment_requests(unit_id) where unit_id is not null;

create table public.inventory_adjustment_executions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_fingerprint text not null check(request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  adjustment_request_id uuid unique references public.inventory_adjustment_requests(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid,
  unit_id uuid references public.serialized_units(id) on delete restrict,
  stock_bucket_id uuid references public.stock_buckets(id) on delete restrict,
  condition public.product_condition not null,
  quantity integer not null check(quantity <> 0),
  unit_cost numeric(14,2) not null check(unit_cost >= 0),
  reason text not null check(reason = btrim(reason) and reason <> ''),
  executed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  -- An immutable execution is recorded only after its authoritative target is
  -- known: exactly one serialized unit or one non-serialized stock bucket.
  check((unit_id is null and stock_bucket_id is not null) or (unit_id is not null and stock_bucket_id is null)),
  check((unit_id is null) or quantity = -1)
);
create table public.inventory_adjustment_reservations (
  request_id uuid primary key,
  request_fingerprint text not null,
  execution_id uuid references public.inventory_adjustment_executions(id) on delete restrict,
  reserved_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check(request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> '')
);
create index inventory_adjustment_executions_product_created_idx on public.inventory_adjustment_executions(product_id, created_at desc);
create index inventory_adjustment_executions_unit_id_idx on public.inventory_adjustment_executions(unit_id) where unit_id is not null;

create or replace function public.forbid_opening_stock_mutation() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  raise exception 'Opening stock history is immutable';
end $$;
create trigger immutable_opening_stock_batches before update or delete on public.opening_stock_batches for each row execute function public.forbid_opening_stock_mutation();
create trigger immutable_opening_stock_lines before update or delete on public.opening_stock_lines for each row execute function public.forbid_opening_stock_mutation();
create trigger immutable_inventory_adjustment_executions before update or delete on public.inventory_adjustment_executions for each row execute function public.forbid_opening_stock_mutation();

create or replace function public.require_inventory_opening_authority() returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid := auth.uid();
begin
  perform public.require_active_profile();
  if public.current_role() not in ('ADMIN', 'MANAGER') then
    raise insufficient_privilege using message = 'Admin or Manager opening-stock authority is required';
  end if;
  return actor;
end $$;

create or replace function public.inventory_record_opening_stock(p_request_id uuid, p_notes text, p_lines jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  actor uuid := public.require_inventory_opening_authority();
  batch public.opening_stock_batches;
  product_row public.products;
  variant_row public.product_variants;
  bucket public.stock_buckets;
  line_row public.opening_stock_lines;
  unit_row public.serialized_units;
  input jsonb;
  identifier jsonb;
  identifier_count integer;
  input_product_id uuid;
  input_variant_id uuid;
  line_condition public.product_condition;
  line_quantity integer;
  line_unit_cost numeric(14,2);
  line_warranty_start date;
  line_warranty_expiry date;
  new_quantity integer;
  new_weighted_cost numeric(14,2);
  bucket_group record;
  fingerprint text;
  summary jsonb;
begin
  if p_request_id is null then
    raise exception 'An opening stock request id is required';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Opening stock requires at least one line';
  end if;
  -- The request fingerprint contains the authoritative logical payload, not
  -- presentation ordering. Identifier order and identifier normalisation
  -- therefore cannot turn an equivalent retry into a different request.
  with canonical_lines as (
    select jsonb_build_object(
      'product_id', nullif(btrim(line.value ->> 'product_id'), '')::uuid,
      'variant_id', nullif(btrim(line.value ->> 'variant_id'), '')::uuid,
      'condition', upper(btrim(line.value ->> 'condition'))::public.product_condition,
      'quantity', nullif(btrim(line.value ->> 'quantity'), '')::integer,
      'acquisition_cost', nullif(btrim(line.value ->> 'acquisition_cost'), '')::numeric(14,2),
      'warranty_start', nullif(btrim(line.value ->> 'warranty_start'), '')::date,
      'warranty_expiry', nullif(btrim(line.value ->> 'warranty_expiry'), '')::date,
      'identifiers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'type', upper(btrim(identifier.value ->> 'type'))::public.identifier_type,
          'value', public.normalize_identifier_value(identifier.value ->> 'value')
        ) order by
          upper(btrim(identifier.value ->> 'type'))::public.identifier_type,
          public.normalize_identifier_value(identifier.value ->> 'value'))
        from jsonb_array_elements(coalesce(line.value -> 'identifiers', '[]'::jsonb)) as identifier(value)
      ), '[]'::jsonb)
    ) as canonical_line
    from jsonb_array_elements(p_lines) as line(value)
  )
  select pg_catalog.encode(extensions.digest(jsonb_build_object(
    'notes', nullif(btrim(p_notes), ''),
    'lines', coalesce(jsonb_agg(canonical_line order by canonical_line), '[]'::jsonb)
  )::text, 'sha256'), 'hex')
  into fingerprint
  from canonical_lines;

  insert into public.opening_stock_batches(request_id, request_fingerprint, notes, created_by)
  values(p_request_id, fingerprint, nullif(btrim(p_notes), ''), actor)
  on conflict(request_id) do nothing
  returning * into batch;

  if not found then
    select * into batch from public.opening_stock_batches where request_id = p_request_id for key share;
    if batch.created_by is distinct from actor then
      raise insufficient_privilege using message = 'Opening stock request id belongs to another user';
    end if;
    if batch.request_fingerprint <> fingerprint then
      raise exception 'Opening stock request id was already used for a different submission';
    end if;
    select jsonb_build_object(
      'opening_stock_batch_id', batch.id,
      'idempotent_replay', true,
      'lines', coalesce(jsonb_agg(jsonb_build_object(
        'opening_stock_line_id', l.id,
        'product_id', l.product_id,
        'variant_id', l.variant_id,
        'condition', l.condition,
        'quantity', l.quantity,
        'unit_cost', l.unit_cost,
        'stock_bucket_id', m.stock_bucket_id,
        'serialized_unit_id', u.id,
        'identifiers', coalesce((
          select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.normalized_value) order by i.identifier_type, i.normalized_value)
          from public.unit_identifiers i where i.unit_id = u.id
        ), '[]'::jsonb)
      ) order by l.created_at, l.id), '[]'::jsonb)
    ) into summary
    from public.opening_stock_lines l
    left join public.serialized_units u on u.opening_stock_line_id = l.id
    left join public.inventory_movements m on m.reference_type = 'OPENING_STOCK_LINE' and m.reference_id = l.id
    where l.batch_id = batch.id;
    return summary;
  end if;

  for input in
    select value
    from jsonb_array_elements(p_lines)
    order by (value ->> 'product_id')::uuid, coalesce(nullif(value ->> 'variant_id', '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid), value ->> 'condition'
  loop
    if jsonb_typeof(input) <> 'object' then
      raise exception 'Every opening stock line must be an object';
    end if;
    input_product_id := (input ->> 'product_id')::uuid;
    input_variant_id := nullif(btrim(input ->> 'variant_id'), '')::uuid;
    line_condition := (input ->> 'condition')::public.product_condition;
    line_quantity := (input ->> 'quantity')::integer;
    line_unit_cost := (input ->> 'acquisition_cost')::numeric(14,2);
    line_warranty_start := nullif(btrim(input ->> 'warranty_start'), '')::date;
    line_warranty_expiry := nullif(btrim(input ->> 'warranty_expiry'), '')::date;
    if line_quantity is null or line_quantity <= 0 or line_unit_cost is null or line_unit_cost < 0 then
      raise exception 'Opening stock quantity must be positive and acquisition cost cannot be negative';
    end if;

    select p.* into product_row from public.products p where p.id = input_product_id for update;
    if not found or not product_row.active then
      raise exception 'Opening stock requires an active product';
    end if;
    if input_variant_id is not null then
      select v.* into variant_row from public.product_variants v where v.id = input_variant_id and v.product_id = input_product_id for key share;
      if not found or not variant_row.active then
        raise exception 'Opening stock requires an active variant belonging to the product';
      end if;
    end if;
    if not product_row.serialized and (line_warranty_start is not null or line_warranty_expiry is not null) then
      raise exception 'Warranty data is supported only for serialized opening stock';
    end if;
    if product_row.serialized and line_quantity <> 1 then
      raise exception 'Serialized opening stock requires one unit per line';
    end if;
    if line_warranty_expiry is not null and line_warranty_start is not null and line_warranty_expiry < line_warranty_start then
      raise exception 'Warranty expiry cannot be earlier than warranty start';
    end if;

    insert into public.opening_stock_lines(batch_id, product_id, variant_id, serialized, condition, quantity, unit_cost, warranty_start, warranty_expiry)
    values(batch.id, input_product_id, input_variant_id, product_row.serialized, line_condition, line_quantity, line_unit_cost, line_warranty_start, line_warranty_expiry)
    returning * into line_row;

    if product_row.serialized then
      if jsonb_typeof(coalesce(input -> 'identifiers', '[]'::jsonb)) <> 'array' then
        raise exception 'Serialized opening stock identifiers must be an array';
      end if;
      if jsonb_array_length(coalesce(input -> 'identifiers', '[]'::jsonb)) = 0 then
        raise exception 'Every serialized opening-stock unit requires at least one identifier';
      end if;
      insert into public.serialized_units(product_id, variant_id, opening_stock_line_id, condition, status, current_selling_price, acquisition_cost, warranty_start, warranty_expiry)
      values(input_product_id, input_variant_id, line_row.id, line_condition, 'AVAILABLE', null, line_unit_cost, line_warranty_start, line_warranty_expiry)
      returning * into unit_row;
      identifier_count := 0;
      for identifier in select value from jsonb_array_elements(coalesce(input -> 'identifiers', '[]'::jsonb)) loop
        if jsonb_typeof(identifier) <> 'object' then
          raise exception 'Every serialized identifier must be an object';
        end if;
        insert into public.unit_identifiers(unit_id, identifier_type, normalized_value)
        values(unit_row.id, upper(btrim(identifier ->> 'type'))::public.identifier_type, public.normalize_identifier_value(identifier ->> 'value'));
        identifier_count := identifier_count + 1;
      end loop;
      if identifier_count = 0 then raise exception 'Every serialized opening-stock unit requires at least one identifier'; end if;
      insert into public.inventory_movements(product_id, variant_id, unit_id, movement, quantity, condition_before, condition_after, unit_cost, reference_type, reference_id, reason, performed_by)
      values(input_product_id, input_variant_id, unit_row.id, 'OPENING_STOCK', 1, null, line_condition, line_unit_cost, 'OPENING_STOCK_LINE', line_row.id, 'Opening stock', actor);
    end if;
  end loop;

  -- Aggregate each exact non-serialized bucket once. This avoids sequential
  -- per-line rounding and makes WAC independent of equivalent line ordering.
  for bucket_group in
    select l.product_id, l.variant_id, l.condition,
           sum(l.quantity)::integer as incoming_quantity,
           sum(l.quantity * l.unit_cost)::numeric(14,2) as incoming_value
    from public.opening_stock_lines l
    where l.batch_id = batch.id and not l.serialized
    group by l.product_id, l.variant_id, l.condition
    order by l.product_id, l.variant_id nulls first, l.condition
  loop
    perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s', bucket_group.product_id, coalesce(bucket_group.variant_id::text, 'BASE'), bucket_group.condition::text), 0));
    select b.* into bucket from public.stock_buckets b
    where b.product_id = bucket_group.product_id
      and b.variant_id is not distinct from bucket_group.variant_id
      and b.condition = bucket_group.condition
    for update;
    if found then
      new_quantity := bucket.quantity + bucket_group.incoming_quantity;
      new_weighted_cost := case
        when bucket.quantity = 0 then round(bucket_group.incoming_value / bucket_group.incoming_quantity, 2)
        else round(((bucket.quantity * bucket.weighted_average_cost) + bucket_group.incoming_value) / new_quantity, 2)
      end;
      update public.stock_buckets
      set quantity = new_quantity, weighted_average_cost = new_weighted_cost
      where id = bucket.id
      returning * into bucket;
    else
      new_weighted_cost := round(bucket_group.incoming_value / bucket_group.incoming_quantity, 2);
      insert into public.stock_buckets(product_id, variant_id, serialized, condition, quantity, selling_price, weighted_average_cost)
      values(bucket_group.product_id, bucket_group.variant_id, false, bucket_group.condition, bucket_group.incoming_quantity, null, new_weighted_cost)
      returning * into bucket;
    end if;
    -- Preserve each acquisition component and its own immutable movement.
    for line_row in
      select * from public.opening_stock_lines
      where batch_id = batch.id and not serialized
        and product_id = bucket_group.product_id
        and variant_id is not distinct from bucket_group.variant_id
        and condition = bucket_group.condition
      order by created_at, id
    loop
      insert into public.inventory_movements(product_id, variant_id, stock_bucket_id, movement, quantity, condition_before, condition_after, unit_cost, reference_type, reference_id, reason, performed_by)
      values(line_row.product_id, line_row.variant_id, bucket.id, 'OPENING_STOCK', line_row.quantity, null, line_row.condition, line_row.unit_cost, 'OPENING_STOCK_LINE', line_row.id, 'Opening stock', actor);
    end loop;
  end loop;

  select jsonb_build_object(
    'opening_stock_batch_id', batch.id,
    'idempotent_replay', false,
    'lines', coalesce(jsonb_agg(jsonb_build_object(
      'opening_stock_line_id', l.id,
      'product_id', l.product_id,
      'variant_id', l.variant_id,
      'condition', l.condition,
      'quantity', l.quantity,
      'unit_cost', l.unit_cost,
      'stock_bucket_id', m.stock_bucket_id,
      'serialized_unit_id', u.id,
      'identifiers', coalesce((
        select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.normalized_value) order by i.identifier_type, i.normalized_value)
        from public.unit_identifiers i where i.unit_id = u.id
      ), '[]'::jsonb)
    ) order by l.created_at, l.id), '[]'::jsonb)
  ) into summary
  from public.opening_stock_lines l
  left join public.serialized_units u on u.opening_stock_line_id = l.id
  left join public.inventory_movements m on m.reference_type = 'OPENING_STOCK_LINE' and m.reference_id = l.id
  where l.batch_id = batch.id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values(actor, 'OPENING_STOCK_RECORDED', 'OPENING_STOCK_BATCH', batch.id, null, summary, jsonb_build_object('request_id', p_request_id));
  return summary;
end $$;

create or replace function public.inventory_submit_adjustment_request(p_product_id uuid, p_variant_id uuid, p_unit_id uuid, p_condition public.product_condition, p_requested_quantity integer, p_reason text) returns public.inventory_adjustment_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare
  actor uuid := auth.uid();
  product_row public.products;
  unit_row public.serialized_units;
  request_row public.inventory_adjustment_requests;
begin
  perform public.require_active_profile();
  if p_requested_quantity is null or p_requested_quantity = 0 or nullif(btrim(p_reason), '') is null then
    raise exception 'An adjustment request requires a non-zero quantity and reason';
  end if;
  select * into product_row from public.products where id = p_product_id for key share;
  if not found or not product_row.active then raise exception 'Adjustment request requires an active product'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id = p_variant_id and product_id = p_product_id and active) then
    raise exception 'Adjustment request requires an active matching variant';
  end if;
  if product_row.serialized then
    if p_unit_id is null or p_condition is not null or p_requested_quantity <> -1 then raise exception 'Serialized adjustment requests require one available unit and quantity -1'; end if;
    select * into unit_row from public.serialized_units where id = p_unit_id for key share;
    if not found or unit_row.product_id <> p_product_id or unit_row.variant_id is distinct from p_variant_id or unit_row.status <> 'AVAILABLE' then
      raise exception 'Serialized unit does not match the requested product and variant';
    end if;
    if p_requested_quantity not in (-1, 1) then
      raise exception 'Serialized adjustment requests must be for one unit';
    end if;
    if p_condition is not null then
      raise exception 'Serialized adjustment requests identify the unit instead of a stock condition';
    end if;
  else
    if p_unit_id is not null or p_condition is null then raise exception 'Non-serialized adjustment requests require an exact condition and no serialized unit'; end if;
  end if;
  insert into public.inventory_adjustment_requests(product_id, variant_id, unit_id, condition, requested_quantity, reason, requested_by)
  values(p_product_id, p_variant_id, p_unit_id, p_condition, p_requested_quantity, btrim(p_reason), actor)
  returning * into request_row;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, before_data, after_data)
  values(actor, 'INVENTORY_ADJUSTMENT_REQUESTED', 'INVENTORY_ADJUSTMENT_REQUEST', request_row.id, null, to_jsonb(request_row));
  return request_row;
end $$;

create or replace function public.protect_adjusted_out_unit() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.status = 'ADJUSTED_OUT' and new.status is distinct from old.status then
    raise exception 'Restoring an adjusted-out unit requires a separate approved Admin workflow';
  end if;
  if new.status = 'ADJUSTED_OUT' and old.status <> 'AVAILABLE' then
    raise exception 'Only an available serialized unit can be adjusted out';
  end if;
  return new;
end $$;

create or replace function public.require_inventory_adjustment_admin() returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid := auth.uid();
begin
  perform public.require_active_profile();
  if public.current_role() <> 'ADMIN' then raise insufficient_privilege using message = 'Admin inventory-adjustment authority is required'; end if;
  return actor;
end $$;

create or replace function public.inventory_reject_adjustment_request(p_request_id uuid, p_rejection_reason text) returns public.inventory_adjustment_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid := public.require_inventory_adjustment_admin(); r public.inventory_adjustment_requests; before_row jsonb;
begin
  if nullif(btrim(p_rejection_reason),'') is null then raise exception 'An adjustment rejection reason is required'; end if;
  select * into r from public.inventory_adjustment_requests where id=p_request_id for update;
  if not found or r.status <> 'OPEN' then raise exception 'Only an open adjustment request can be rejected'; end if;
  before_row:=to_jsonb(r);
  update public.inventory_adjustment_requests set status='REJECTED', reviewed_by=actor, reviewed_at=now(), rejection_reason=btrim(p_rejection_reason) where id=r.id returning * into r;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,before_data,after_data) values(actor,'INVENTORY_ADJUSTMENT_REQUEST_REJECTED','INVENTORY_ADJUSTMENT_REQUEST',r.id,before_row,to_jsonb(r));
  return r;
end $$;
create trigger protect_adjusted_out_unit before update of status on public.serialized_units for each row execute function public.protect_adjusted_out_unit();

create or replace function public.inventory_execute_adjustment(p_request_id uuid, p_adjustment_request_id uuid, p_product_id uuid, p_variant_id uuid, p_unit_id uuid, p_condition public.product_condition, p_quantity integer, p_unit_cost numeric, p_reason text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  actor uuid := public.require_inventory_adjustment_admin();
  request_row public.inventory_adjustment_requests;
  reservation public.inventory_adjustment_reservations;
  execution public.inventory_adjustment_executions;
  product_row public.products;
  unit_row public.serialized_units;
  bucket public.stock_buckets;
  product_id_value uuid := p_product_id;
  variant_id_value uuid := p_variant_id;
  unit_id_value uuid := p_unit_id;
  condition_value public.product_condition := p_condition;
  quantity_value integer := p_quantity;
  cost_value numeric(14,2) := p_unit_cost;
  fingerprint_cost numeric(14,2);
  reason_value text := nullif(btrim(p_reason), '');
  fingerprint text;
  resulting_quantity integer;
  resulting_wac numeric(14,2);
  bucket_preexisted boolean := false;
  request_before jsonb;
  request_after jsonb;
  bucket_before jsonb;
  bucket_after jsonb;
  unit_before jsonb;
  unit_after jsonb;
  result jsonb;
begin
  if p_request_id is null then raise exception 'An adjustment request idempotency key is required'; end if;
  if p_adjustment_request_id is not null then
    select * into request_row from public.inventory_adjustment_requests where id = p_adjustment_request_id for update;
    if not found then raise exception 'Adjustment request does not exist'; end if;
    request_before := to_jsonb(request_row);
    product_id_value := request_row.product_id; variant_id_value := request_row.variant_id; unit_id_value := request_row.unit_id;
    condition_value := request_row.condition; quantity_value := request_row.requested_quantity; reason_value := request_row.reason;
  end if;
  if quantity_value is null or quantity_value = 0 or reason_value is null then raise exception 'An adjustment requires a non-zero quantity and reason'; end if;
  -- Cost is authoritative only for positive non-serialized adjustments.
  -- Serialized actual cost and negative-bucket movement cost are derived later.
  fingerprint_cost := case when unit_id_value is not null or quantity_value < 0 then null else cost_value end;
  fingerprint := pg_catalog.encode(extensions.digest(jsonb_build_object(
    'request', p_adjustment_request_id,
    'product', product_id_value,
    'variant', variant_id_value,
    'unit', unit_id_value,
    'condition', condition_value,
    'quantity', quantity_value,
    'cost', fingerprint_cost,
    'reason', reason_value
  )::text, 'sha256'), 'hex');
  -- This mutable reservation serializes duplicate submissions. The separate
  -- execution table is never used as an in-progress record.
  insert into public.inventory_adjustment_reservations(request_id,request_fingerprint,reserved_by)
  values(p_request_id,fingerprint,actor)
  on conflict(request_id) do nothing
  returning * into reservation;
  if not found then
    select r.* into reservation from public.inventory_adjustment_reservations r where r.request_id=p_request_id for key share;
    if not found or reservation.reserved_by is distinct from actor or reservation.request_fingerprint <> fingerprint or reservation.execution_id is null then
      raise exception 'Adjustment request id was already used for a different submission';
    end if;
    select * into execution from public.inventory_adjustment_executions where id=reservation.execution_id;
    return jsonb_build_object('adjustment_execution_id',execution.id,'idempotent_replay',true);
  end if;
  if p_adjustment_request_id is not null and request_row.status <> 'OPEN' then
    raise exception 'Adjustment request is not open';
  end if;
  select p.* into product_row from public.products p where p.id=product_id_value for update;
  if not found or not product_row.active then raise exception 'Adjustment requires an active product'; end if;
  if variant_id_value is not null and not exists(select 1 from public.product_variants v where v.id=variant_id_value and v.product_id=product_id_value and v.active) then raise exception 'Adjustment requires an active matching variant'; end if;
  if unit_id_value is not null then
    if quantity_value <> -1 or not product_row.serialized then raise exception 'Serialized adjustments can only adjust one available unit out'; end if;
    if condition_value is not null then raise exception 'Serialized adjustments identify the unit and must not supply a stock condition'; end if;
    select * into unit_row from public.serialized_units where id=unit_id_value for update;
    if not found or unit_row.product_id<>product_id_value or unit_row.variant_id is distinct from variant_id_value or unit_row.status<>'AVAILABLE' then raise exception 'Serialized adjustment requires an available matching unit'; end if;
    unit_before := jsonb_build_object(
      'unit_id', unit_row.id,
      'status', unit_row.status,
      'acquisition_cost', unit_row.acquisition_cost,
      'purchase_item_id', unit_row.purchase_item_id,
      'opening_stock_line_id', unit_row.opening_stock_line_id,
      'identifiers', coalesce((
        select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'value', i.normalized_value) order by i.identifier_type, i.normalized_value)
        from public.unit_identifiers i where i.unit_id = unit_row.id
      ), '[]'::jsonb)
    );
    unit_after := unit_before || jsonb_build_object('status', 'ADJUSTED_OUT');
    -- All immutable execution values are resolved and locked before this one
    -- insert. The following unit transition/movement reference this final row.
    insert into public.inventory_adjustment_executions(request_id,request_fingerprint,adjustment_request_id,product_id,variant_id,unit_id,stock_bucket_id,condition,quantity,unit_cost,reason,executed_by)
    values(p_request_id,fingerprint,p_adjustment_request_id,product_id_value,variant_id_value,unit_row.id,null,unit_row.condition,-1,unit_row.acquisition_cost,reason_value,actor) returning * into execution;
    update public.serialized_units set status='ADJUSTED_OUT' where id=unit_row.id;
    insert into public.inventory_movements(product_id,variant_id,unit_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)
    values(product_id_value,variant_id_value,unit_row.id,'ADJUSTMENT',-1,unit_row.condition,unit_row.condition,unit_row.acquisition_cost,'INVENTORY_ADJUSTMENT_EXECUTION',execution.id,reason_value,actor);
  else
    if product_row.serialized or condition_value is null then raise exception 'Non-serialized adjustment requires an exact stock condition'; end if;
    perform pg_advisory_xact_lock(hashtextextended(format('stock-bucket:%s:%s:%s',product_id_value,coalesce(variant_id_value::text,'BASE'),condition_value::text),0));
    select b.* into bucket from public.stock_buckets b where b.product_id=product_id_value and b.variant_id is not distinct from variant_id_value and b.condition=condition_value for update;
    bucket_preexisted := found;
    if bucket_preexisted then
      bucket_before := jsonb_build_object('stock_bucket_id', bucket.id, 'quantity', bucket.quantity, 'weighted_average_cost', bucket.weighted_average_cost);
    else
      bucket_before := jsonb_build_object('stock_bucket_id', null, 'quantity', 0, 'weighted_average_cost', null);
    end if;
    if quantity_value > 0 then
      if cost_value is null or cost_value < 0 then raise exception 'Positive adjustment requires a non-negative acquisition unit cost'; end if;
      if bucket_preexisted then
        resulting_quantity:=bucket.quantity+quantity_value;
        resulting_wac:=case when bucket.quantity=0 then cost_value else round(((bucket.quantity*bucket.weighted_average_cost)+(quantity_value*cost_value))/resulting_quantity,2) end;
      else
        resulting_quantity := quantity_value;
        resulting_wac := cost_value;
        insert into public.stock_buckets(product_id,variant_id,serialized,condition,quantity,selling_price,weighted_average_cost) values(product_id_value,variant_id_value,false,condition_value,quantity_value,null,cost_value) returning * into bucket;
      end if;
    else
      if not bucket_preexisted or bucket.quantity+quantity_value<0 then raise exception 'Adjustment would create negative inventory'; end if;
      resulting_quantity := bucket.quantity + quantity_value;
      resulting_wac := bucket.weighted_average_cost;
      cost_value:=bucket.weighted_average_cost;
    end if;
    bucket_after := jsonb_build_object('stock_bucket_id', bucket.id, 'quantity', resulting_quantity, 'weighted_average_cost', resulting_wac);
    -- This immutable row is inserted only after the exact bucket, cost
    -- snapshot, resulting quantity, and WAC have been resolved.
    insert into public.inventory_adjustment_executions(request_id,request_fingerprint,adjustment_request_id,product_id,variant_id,unit_id,stock_bucket_id,condition,quantity,unit_cost,reason,executed_by)
    values(p_request_id,fingerprint,p_adjustment_request_id,product_id_value,variant_id_value,null,bucket.id,condition_value,quantity_value,cost_value,reason_value,actor) returning * into execution;
    if bucket_preexisted then
      update public.stock_buckets
      set quantity = resulting_quantity, weighted_average_cost = resulting_wac
      where id = bucket.id
      returning * into bucket;
    end if;
    insert into public.inventory_movements(product_id,variant_id,stock_bucket_id,movement,quantity,condition_before,condition_after,unit_cost,reference_type,reference_id,reason,performed_by)
    values(product_id_value,variant_id_value,bucket.id,'ADJUSTMENT',quantity_value,condition_value,condition_value,cost_value,'INVENTORY_ADJUSTMENT_EXECUTION',execution.id,reason_value,actor);
  end if;
  update public.inventory_adjustment_reservations set execution_id=execution.id where request_id=p_request_id;
  if p_adjustment_request_id is not null then
    update public.inventory_adjustment_requests
    set status='RESOLVED', reviewed_by=actor, reviewed_at=now()
    where id=p_adjustment_request_id
    returning * into request_row;
    request_after := to_jsonb(request_row);
  end if;
  result:=jsonb_build_object('adjustment_execution_id',execution.id,'idempotent_replay',false);
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,before_data,after_data,metadata)
  values(
    actor,
    'INVENTORY_ADJUSTMENT_EXECUTED',
    'INVENTORY_ADJUSTMENT_EXECUTION',
    execution.id,
    jsonb_build_object('request', request_before, 'stock_bucket', bucket_before, 'serialized_unit', unit_before),
    jsonb_build_object('request', request_after, 'stock_bucket', bucket_after, 'serialized_unit', unit_after),
    jsonb_build_object(
      'adjustment_request_id', p_adjustment_request_id,
      'adjustment_quantity', execution.quantity,
      'movement_cost_snapshot', execution.unit_cost,
      'stock_bucket_id', execution.stock_bucket_id,
      'unit_id', execution.unit_id
    )
  );
  return result;
end $$;

-- Staff serialized lookup continues to expose only safe current operational data.
drop function public.staff_serialized_lookup(text);
create function public.staff_serialized_lookup(search_text text) returns table(unit_id uuid, product_id uuid, product_name text, product_sku text, product_barcode text, product_model text, brand_name text, category_name text, variant_id uuid, variant_label text, variant_sku text, variant_barcode text, condition public.product_condition, status public.unit_status, selling_price numeric, identifier_type public.identifier_type, identifier_value text) language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.require_active_profile();
  if search_text is null or btrim(search_text) = '' then raise exception 'A serialized identifier or product search value is required'; end if;
  return query
  select u.id, p.id, p.name, p.sku, p.barcode, p.model, br.name, c.name, v.id, v.label, v.sku, v.barcode, u.condition, u.status, cp.selling_price, i.identifier_type, i.normalized_value
  from public.serialized_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.categories c on c.id = p.category_id
  left join public.product_variants v on v.id = u.variant_id
  left join public.catalogue_prices cp on cp.product_id = p.id and cp.variant_id is not distinct from u.variant_id and cp.condition = u.condition and cp.active
  join public.unit_identifiers i on i.unit_id = u.id
  where u.status in ('AVAILABLE', 'SOLD', 'RETURN_PENDING')
    and (i.normalized_value = upper(btrim(search_text)) or p.sku = upper(btrim(search_text)) or p.barcode = upper(btrim(search_text)) or v.sku = upper(btrim(search_text)) or v.barcode = upper(btrim(search_text)) or p.name ilike '%' || btrim(search_text) || '%')
  order by u.created_at desc limit 50;
end $$;

alter table public.opening_stock_batches enable row level security;
alter table public.opening_stock_lines enable row level security;
alter table public.inventory_adjustment_requests enable row level security;
alter table public.inventory_adjustment_executions enable row level security;
alter table public.inventory_adjustment_reservations enable row level security;
create policy "management read opening stock batches" on public.opening_stock_batches for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read opening stock lines" on public.opening_stock_lines for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read adjustment requests" on public.inventory_adjustment_requests for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "requester reads own adjustment requests" on public.inventory_adjustment_requests for select using (requested_by = (select auth.uid()));
create policy "management read adjustment executions" on public.inventory_adjustment_executions for select using (public.current_role() in ('ADMIN', 'MANAGER'));

revoke all on table public.opening_stock_batches, public.opening_stock_lines, public.inventory_adjustment_requests, public.inventory_adjustment_executions, public.inventory_adjustment_reservations from public, anon, authenticated;
grant select on table public.opening_stock_batches, public.opening_stock_lines, public.inventory_adjustment_requests, public.inventory_adjustment_executions to authenticated;
revoke all on function public.require_inventory_opening_authority(), public.require_inventory_adjustment_admin(), public.forbid_opening_stock_mutation(), public.protect_adjusted_out_unit(), public.normalize_identifier_value(text), public.normalize_identifier() from public, anon, authenticated;
revoke all on function public.inventory_record_opening_stock(uuid, text, jsonb), public.inventory_submit_adjustment_request(uuid, uuid, uuid, public.product_condition, integer, text), public.inventory_execute_adjustment(uuid, uuid, uuid, uuid, uuid, public.product_condition, integer, numeric, text), public.inventory_reject_adjustment_request(uuid, text), public.staff_serialized_lookup(text) from public, anon, authenticated;
grant execute on function public.inventory_record_opening_stock(uuid, text, jsonb), public.inventory_submit_adjustment_request(uuid, uuid, uuid, public.product_condition, integer, text), public.inventory_execute_adjustment(uuid, uuid, uuid, uuid, uuid, public.product_condition, integer, numeric, text), public.inventory_reject_adjustment_request(uuid, text), public.staff_serialized_lookup(text) to authenticated;
