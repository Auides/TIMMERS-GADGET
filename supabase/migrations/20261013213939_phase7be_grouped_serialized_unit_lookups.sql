-- Phase 7B-E source-only migration. It is intentionally unapplied here.
--
-- Existing serialized read RPCs return one row per identifier.  These v2
-- projections make the physical serialized unit the cardinality boundary and
-- return its identifiers as a safe, ordered display collection.  The v1
-- signatures are retained for compatibility while all application callers use
-- these v2 endpoints.

create function public.staff_serialized_lookup_v2(search_text text)
returns table(
  unit_id uuid,
  product_id uuid,
  product_name text,
  product_sku text,
  product_barcode text,
  product_model text,
  brand_name text,
  category_name text,
  variant_id uuid,
  variant_label text,
  variant_sku text,
  variant_barcode text,
  condition public.product_condition,
  status public.unit_status,
  selling_price numeric,
  identifiers jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  if search_text is null or btrim(search_text) = '' then
    raise exception 'A serialized identifier or product search value is required';
  end if;

  -- The search predicate uses EXISTS and identifiers are aggregated per unit
  -- before the result is ordered and limited. A unit can never consume several
  -- slots because it has several IMEI/serial identifiers.
  return query
  select
    u.id,
    p.id,
    p.name,
    p.sku,
    p.barcode,
    p.model,
    br.name,
    c.name,
    v.id,
    v.label,
    v.sku,
    v.barcode,
    u.condition,
    u.status,
    cp.selling_price,
    identifier_projection.identifiers
  from public.serialized_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.categories c on c.id = p.category_id
  left join public.product_variants v on v.id = u.variant_id
  left join public.catalogue_prices cp
    on cp.product_id = p.id
   and cp.variant_id is not distinct from u.variant_id
   and cp.condition = u.condition
   and cp.active
  cross join lateral (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'identifier_type', i.identifier_type::text,
          'identifier_value', i.normalized_value
        )
        order by i.identifier_type::text, i.normalized_value
      ),
      '[]'::jsonb
    ) as identifiers
    from public.unit_identifiers i
    where i.unit_id = u.id
  ) identifier_projection
  where u.status in ('AVAILABLE', 'SOLD', 'RETURN_PENDING')
    and (
      exists (
        select 1
        from public.unit_identifiers search_identifier
        where search_identifier.unit_id = u.id
          and search_identifier.normalized_value = upper(btrim(search_text))
      )
      or p.sku = upper(btrim(search_text))
      or p.barcode = upper(btrim(search_text))
      or v.sku = upper(btrim(search_text))
      or v.barcode = upper(btrim(search_text))
      or p.name ilike '%' || btrim(search_text) || '%'
      or v.label ilike '%' || btrim(search_text) || '%'
    )
  order by u.created_at desc, u.id desc
  limit 50;
end
$$;

create function public.staff_sellable_serialized_lookup_v2(p_search text)
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
  identifiers jsonb
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
    identifier_projection.identifiers
  from public.serialized_units u
  join public.products p
    on p.id = u.product_id
   and p.active
  left join public.product_variants v on v.id = u.variant_id
  join public.catalogue_prices cp
    on cp.product_id = p.id
   and cp.variant_id is not distinct from u.variant_id
   and cp.condition = u.condition
   and cp.active
  cross join lateral (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'identifier_type', i.identifier_type::text,
          'identifier_value', i.normalized_value
        )
        order by i.identifier_type::text, i.normalized_value
      ),
      '[]'::jsonb
    ) as identifiers
    from public.unit_identifiers i
    where i.unit_id = u.id
  ) identifier_projection
  where u.status = 'AVAILABLE'
    and (
      (u.variant_id is null and not exists (
        select 1
        from public.product_variants active_variant
        where active_variant.product_id = p.id
          and active_variant.active
      ))
      or (u.variant_id is not null and v.active)
    )
    and (
      exists (
        select 1
        from public.unit_identifiers search_identifier
        where search_identifier.unit_id = u.id
          and search_identifier.normalized_value = upper(btrim(p_search))
      )
      or p.sku = upper(btrim(p_search))
      or p.barcode = upper(btrim(p_search))
      or v.sku = upper(btrim(p_search))
      or v.barcode = upper(btrim(p_search))
      or p.name ilike '%' || btrim(p_search) || '%'
      or v.label ilike '%' || btrim(p_search) || '%'
    )
  order by p.name, v.label nulls first, u.condition, u.id;
end
$$;

create function public.staff_serialized_inventory_snapshot_v2()
returns table(
  unit_id uuid,
  product_id uuid,
  product_name text,
  product_sku text,
  product_barcode text,
  product_model text,
  brand_name text,
  category_name text,
  variant_id uuid,
  variant_label text,
  variant_sku text,
  variant_barcode text,
  condition public.product_condition,
  status public.unit_status,
  selling_price numeric,
  identifiers jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  return query
  select
    u.id,
    p.id,
    p.name,
    p.sku,
    p.barcode,
    p.model,
    br.name,
    c.name,
    v.id,
    v.label,
    v.sku,
    v.barcode,
    u.condition,
    u.status,
    cp.selling_price,
    identifier_projection.identifiers
  from public.serialized_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.categories c on c.id = p.category_id
  left join public.product_variants v on v.id = u.variant_id
  left join public.catalogue_prices cp
    on cp.product_id = p.id
   and cp.variant_id is not distinct from u.variant_id
   and cp.condition = u.condition
   and cp.active
  cross join lateral (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'identifier_type', i.identifier_type::text,
          'identifier_value', i.normalized_value
        )
        order by i.identifier_type::text, i.normalized_value
      ),
      '[]'::jsonb
    ) as identifiers
    from public.unit_identifiers i
    where i.unit_id = u.id
  ) identifier_projection
  where u.status in ('AVAILABLE', 'SOLD', 'RETURN_PENDING')
  order by u.created_at desc, u.id desc;
end
$$;

create function public.staff_offline_sellable_serialized_snapshot_v2()
returns table(
  unit_id uuid,
  product_id uuid,
  product_name text,
  product_sku text,
  product_barcode text,
  product_model text,
  brand_name text,
  category_name text,
  variant_id uuid,
  variant_label text,
  variant_sku text,
  variant_barcode text,
  condition public.product_condition,
  status public.unit_status,
  catalogue_price_id uuid,
  price_revision bigint,
  selling_price numeric,
  identifiers jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  return query
  select
    u.id,
    p.id,
    p.name,
    p.sku,
    p.barcode,
    p.model,
    b.name,
    c.name,
    v.id,
    v.label,
    v.sku,
    v.barcode,
    u.condition,
    u.status,
    cp.id,
    cp.quote_revision,
    cp.selling_price,
    identifier_projection.identifiers
  from public.serialized_units u
  join public.products p on p.id = u.product_id and p.active
  left join public.brands b on b.id = p.brand_id and b.active
  left join public.categories c on c.id = p.category_id and c.active
  left join public.product_variants v on v.id = u.variant_id
  join public.catalogue_prices cp
    on cp.product_id = p.id
   and cp.variant_id is not distinct from u.variant_id
   and cp.condition = u.condition
   and cp.active
  cross join lateral (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'identifier_type', i.identifier_type::text,
          'identifier_value', i.normalized_value
        )
        order by i.identifier_type::text, i.normalized_value
      ),
      '[]'::jsonb
    ) as identifiers
    from public.unit_identifiers i
    where i.unit_id = u.id
  ) identifier_projection
  where u.status = 'AVAILABLE'
    and (
      (u.variant_id is null and not exists (
        select 1 from public.product_variants active_variant
        where active_variant.product_id = p.id and active_variant.active
      ))
      or (u.variant_id is not null and v.active)
    )
  order by p.name, v.label nulls first, u.condition, u.id;
end
$$;

revoke all on function public.staff_serialized_lookup_v2(text) from public, anon, authenticated;
revoke all on function public.staff_sellable_serialized_lookup_v2(text) from public, anon, authenticated;
revoke all on function public.staff_serialized_inventory_snapshot_v2() from public, anon, authenticated;
revoke all on function public.staff_offline_sellable_serialized_snapshot_v2() from public, anon, authenticated;

grant execute on function public.staff_serialized_lookup_v2(text) to authenticated;
grant execute on function public.staff_sellable_serialized_lookup_v2(text) to authenticated;
grant execute on function public.staff_serialized_inventory_snapshot_v2() to authenticated;
grant execute on function public.staff_offline_sellable_serialized_snapshot_v2() to authenticated;
