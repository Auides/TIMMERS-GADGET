-- Phase 7: keep the parent/variant catalogue model aligned with every
-- inventory creation path and with the cashier's serialized-unit lookup.
-- This migration is source-only until applied through the normal migration
-- process.  It deliberately does not alter existing inventory records.

create or replace function public.inventory_assert_variant_target(
  p_product_id uuid,
  p_variant_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_product_active boolean;
  v_variant_product_id uuid;
  v_variant_active boolean;
begin
  select p.active
    into v_product_active
  from public.products p
  where p.id = p_product_id
  for key share;

  if v_product_active is distinct from true then
    raise exception 'PRODUCT_INACTIVE' using errcode = 'P0001';
  end if;

  if p_variant_id is null then
    if exists (
      select 1
      from public.product_variants pv
      where pv.product_id = p_product_id
        and pv.active
    ) then
      raise exception 'VARIANT_REQUIRED' using errcode = 'P0001';
    end if;
    return;
  end if;

  select pv.product_id, pv.active
    into v_variant_product_id, v_variant_active
  from public.product_variants pv
  where pv.id = p_variant_id
  for key share;

  if not found then
    raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_variant_product_id is distinct from p_product_id then
    raise exception 'VARIANT_PRODUCT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_variant_active is distinct from true then
    raise exception 'VARIANT_INACTIVE' using errcode = 'P0001';
  end if;
end
$$;

create or replace function public.enforce_inventory_variant_target()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.inventory_assert_variant_target(new.product_id, new.variant_id);
  return new;
end
$$;

drop trigger if exists opening_stock_lines_variant_target on public.opening_stock_lines;
create trigger opening_stock_lines_variant_target
before insert or update of product_id, variant_id on public.opening_stock_lines
for each row execute function public.enforce_inventory_variant_target();

drop trigger if exists purchase_items_variant_target on public.purchase_items;
create trigger purchase_items_variant_target
before insert or update of product_id, variant_id on public.purchase_items
for each row execute function public.enforce_inventory_variant_target();

-- The source-line triggers above give callers a clear business error.  These
-- two guards protect any future direct inventory creation path as well.
drop trigger if exists stock_buckets_variant_target on public.stock_buckets;
create trigger stock_buckets_variant_target
before insert or update of product_id, variant_id on public.stock_buckets
for each row execute function public.enforce_inventory_variant_target();

drop trigger if exists serialized_units_variant_target on public.serialized_units;
create trigger serialized_units_variant_target
before insert or update of product_id, variant_id on public.serialized_units
for each row execute function public.enforce_inventory_variant_target();

create or replace function public.catalogue_switch_to_variant_pricing(
  p_product_id uuid,
  p_variant_id uuid
)
returns public.product_variants
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := public.require_catalogue_manager();
  v_product public.products;
  v_variant_before public.product_variants;
  v_variant_after public.product_variants;
  v_base_prices_before jsonb;
  v_variant_prices_before jsonb;
  v_base_prices_after jsonb;
  v_variant_prices_after jsonb;
begin
  select *
    into v_product
  from public.products p
  where p.id = p_product_id
  for update;
  if not found or not v_product.active then
    raise exception 'PARENT_PRODUCT_INACTIVE' using errcode = 'P0001';
  end if;

  -- Catalogue writes use product then variant then price locks.  Acquiring the
  -- complete product set in that order makes the mode transition atomic with
  -- ordinary catalogue edits and never activates an unrelated variant.
  perform 1
  from public.product_variants pv
  where pv.product_id = p_product_id
  order by pv.id
  for update;
  perform 1
  from public.catalogue_prices cp
  where cp.product_id = p_product_id
  order by cp.variant_id nulls first, cp.condition
  for update;

  select *
    into v_variant_before
  from public.product_variants pv
  where pv.id = p_variant_id
    and pv.product_id = p_product_id;
  if not found then
    raise exception 'VARIANT_PRODUCT_MISMATCH' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(cp) order by cp.condition), '[]'::jsonb)
    into v_variant_prices_before
  from public.catalogue_prices cp
  where cp.product_id = p_product_id
    and cp.variant_id = p_variant_id;
  if v_variant_prices_before = '[]'::jsonb then
    raise exception 'VARIANT_PRICE_REQUIRED' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(cp) order by cp.condition), '[]'::jsonb)
    into v_base_prices_before
  from public.catalogue_prices cp
  where cp.product_id = p_product_id
    and cp.variant_id is null
    and cp.active;

  update public.catalogue_prices
  set active = false,
      updated_by = v_actor
  where product_id = p_product_id
    and variant_id is null
    and active;

  update public.product_variants
  set active = true
  where id = p_variant_id
  returning * into v_variant_after;

  update public.catalogue_prices
  set active = true,
      updated_by = v_actor
  where product_id = p_product_id
    and variant_id = p_variant_id
    and not active;

  select coalesce(jsonb_agg(to_jsonb(cp) order by cp.condition), '[]'::jsonb)
    into v_base_prices_after
  from public.catalogue_prices cp
  where cp.product_id = p_product_id
    and cp.variant_id is null;
  select coalesce(jsonb_agg(to_jsonb(cp) order by cp.condition), '[]'::jsonb)
    into v_variant_prices_after
  from public.catalogue_prices cp
  where cp.product_id = p_product_id
    and cp.variant_id = p_variant_id;

  perform public.catalogue_audit(
    v_actor,
    'CATALOGUE_VARIANT_PRICING_SWITCHED',
    'PRODUCT_VARIANT',
    v_variant_after.id,
    jsonb_build_object(
      'product_id', p_product_id,
      'variant', to_jsonb(v_variant_before),
      'active_base_prices', v_base_prices_before,
      'variant_prices', v_variant_prices_before
    ),
    jsonb_build_object(
      'product_id', p_product_id,
      'variant', to_jsonb(v_variant_after),
      'base_prices', v_base_prices_after,
      'variant_prices', v_variant_prices_after
    )
  );

  return v_variant_after;
end
$$;

-- This lookup is intentionally narrower than staff_serialized_lookup: it is
-- checkout-only, returns no cost or valuation data, and excludes valid but
-- unpriced inventory and all unavailable units.
create or replace function public.staff_sellable_serialized_lookup(
  p_search text
)
returns table(
  unit_id uuid,
  product_id uuid,
  product_name text,
  product_sku text,
  product_barcode text,
  variant_id uuid,
  variant_label text,
  variant_sku text,
  variant_barcode text,
  condition public.product_condition,
  status public.unit_status,
  selling_price numeric,
  identifier_type public.identifier_type,
  identifier_value text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  if p_search is null or btrim(p_search) = '' then
    raise exception 'SERIALIZED_SEARCH_REQUIRED' using errcode = '22023';
  end if;

  return query
  select
    u.id,
    p.id,
    p.name,
    p.sku,
    p.barcode,
    v.id,
    v.label,
    v.sku,
    v.barcode,
    u.condition,
    u.status,
    cp.selling_price,
    i.identifier_type,
    i.normalized_value
  from public.serialized_units u
  join public.products p
    on p.id = u.product_id
   and p.active
  left join public.product_variants v
    on v.id = u.variant_id
  join public.catalogue_prices cp
    on cp.product_id = p.id
   and cp.variant_id is not distinct from u.variant_id
   and cp.condition = u.condition
   and cp.active
  join public.unit_identifiers i
    on i.unit_id = u.id
  where u.status = 'AVAILABLE'
    and (
      (
        u.variant_id is null
        and not exists (
          select 1
          from public.product_variants active_variant
          where active_variant.product_id = p.id
            and active_variant.active
        )
      )
      or (
        u.variant_id is not null
        and v.active
      )
    )
    and (
      i.normalized_value = upper(btrim(p_search))
      or p.sku = upper(btrim(p_search))
      or p.barcode = upper(btrim(p_search))
      or v.sku = upper(btrim(p_search))
      or v.barcode = upper(btrim(p_search))
      or p.name ilike '%' || btrim(p_search) || '%'
      or v.label ilike '%' || btrim(p_search) || '%'
    )
  order by p.name, v.label nulls first, u.condition, u.id, i.identifier_type;
end
$$;

-- A Manager/Admin-only read report for review before a future explicit,
-- audited reassignment workflow.  It never updates, moves, or sells legacy
-- variant-less inventory.
create or replace function public.catalogue_variant_mode_legacy_inventory_report()
returns table(
  inventory_kind text,
  inventory_id uuid,
  product_id uuid,
  product_name text,
  condition public.product_condition,
  quantity integer,
  status public.unit_status
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_catalogue_manager();
  return query
  select
    'STOCK_BUCKET'::text,
    b.id,
    p.id,
    p.name,
    b.condition,
    b.quantity,
    null::public.unit_status
  from public.stock_buckets b
  join public.products p on p.id = b.product_id
  where b.variant_id is null
    and b.quantity > 0
    and exists (
      select 1
      from public.product_variants active_variant
      where active_variant.product_id = p.id
        and active_variant.active
    )
  union all
  select
    'SERIALIZED_UNIT'::text,
    u.id,
    p.id,
    p.name,
    u.condition,
    1,
    u.status
  from public.serialized_units u
  join public.products p on p.id = u.product_id
  where u.variant_id is null
    and u.status = 'AVAILABLE'
    and exists (
      select 1
      from public.product_variants active_variant
      where active_variant.product_id = p.id
        and active_variant.active
    )
  order by 4, 1, 2;
end
$$;

revoke all on function public.inventory_assert_variant_target(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enforce_inventory_variant_target() from public, anon, authenticated;
revoke all on function public.catalogue_switch_to_variant_pricing(uuid, uuid) from public, anon, authenticated;
revoke all on function public.staff_sellable_serialized_lookup(text) from public, anon, authenticated;
revoke all on function public.catalogue_variant_mode_legacy_inventory_report() from public, anon, authenticated;

grant execute on function public.catalogue_switch_to_variant_pricing(uuid, uuid) to authenticated;
grant execute on function public.staff_sellable_serialized_lookup(text) to authenticated;
grant execute on function public.catalogue_variant_mode_legacy_inventory_report() to authenticated;
