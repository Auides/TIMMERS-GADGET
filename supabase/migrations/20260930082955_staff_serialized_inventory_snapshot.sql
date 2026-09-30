-- Read-only Staff projection for future encrypted offline inventory replication.
-- Visibility and fields intentionally mirror staff_serialized_lookup(text).
create function public.staff_serialized_inventory_snapshot()
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
  identifier_type public.identifier_type,
  identifier_value text
)
language plpgsql
security definer
set search_path = public, pg_temp
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
    i.identifier_type,
    i.normalized_value
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
  join public.unit_identifiers i on i.unit_id = u.id
  where u.status in ('AVAILABLE', 'SOLD', 'RETURN_PENDING')
  order by u.created_at desc, u.id desc, i.identifier_type asc, i.normalized_value asc;
end;
$$;

revoke all on function public.staff_serialized_inventory_snapshot() from public, anon, authenticated;
grant execute on function public.staff_serialized_inventory_snapshot() to authenticated;
