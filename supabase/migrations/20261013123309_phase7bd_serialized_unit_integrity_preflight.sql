-- Source-only release-preflight diagnostic. It never alters serialized
-- inventory, identifiers, prices, or history, and must be applied only by the
-- normal approved migration process after production backup/preflight.
--
-- The existing schema already enforces globally unique normalized identifier
-- values and one identifier type per unit. A unique index for
-- opening_stock_line_id is intentionally not added here: existing production
-- data has not yet been inspected for legacy violations. This report makes
-- those violations visible before any separately approved constraint change.

create or replace function public.serialized_unit_integrity_preflight()
returns table(
  finding_class text,
  finding_code text,
  source_kind text,
  source_id uuid,
  unit_ids uuid[],
  identifier_value text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_catalogue_manager();

  return query
  with duplicate_identifiers as (
    select
      min(i.id) as source_id,
      array_agg(i.unit_id order by i.unit_id)::uuid[] as unit_ids,
      i.normalized_value as identifier_value
    from public.unit_identifiers i
    group by i.normalized_value
    having count(*) > 1
  ), duplicate_opening_units as (
    select
      u.opening_stock_line_id as source_id,
      array_agg(u.id order by u.id)::uuid[] as unit_ids
    from public.serialized_units u
    where u.opening_stock_line_id is not null
    group by u.opening_stock_line_id
    having count(*) > 1
  ), missing_identifiers as (
    select u.id as source_id, array[u.id]::uuid[] as unit_ids
    from public.serialized_units u
    where not exists (select 1 from public.unit_identifiers i where i.unit_id = u.id)
  ), purchase_overage as (
    select pi.id as source_id, array_agg(u.id order by u.id)::uuid[] as unit_ids
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id and p.serialized
    join public.serialized_units u on u.purchase_item_id = pi.id
    group by pi.id, pi.quantity
    having count(*) > pi.quantity
  ), ambiguous_origin as (
    select u.id as source_id, array[u.id]::uuid[] as unit_ids
    from public.serialized_units u
    where (u.purchase_item_id is null) = (u.opening_stock_line_id is null)
  )
  select 'DEFINITE'::text, 'DUPLICATE_IDENTIFIER_VALUE'::text,
         'UNIT_IDENTIFIER'::text, d.source_id, d.unit_ids, d.identifier_value
  from duplicate_identifiers d
  union all
  select 'DEFINITE', 'MULTIPLE_UNITS_FOR_OPENING_STOCK_LINE',
         'OPENING_STOCK_LINE', d.source_id, d.unit_ids, null::text
  from duplicate_opening_units d
  union all
  select 'DEFINITE', 'SERIALIZED_UNIT_WITHOUT_IDENTIFIER',
         'SERIALIZED_UNIT', m.source_id, m.unit_ids, null::text
  from missing_identifiers m
  union all
  select 'PROBABLE', 'PURCHASE_ITEM_UNIT_COUNT_EXCEEDS_QUANTITY',
         'PURCHASE_ITEM', p.source_id, p.unit_ids, null::text
  from purchase_overage p
  union all
  select 'AMBIGUOUS', 'SERIALIZED_UNIT_ORIGIN_NEEDS_REVIEW',
         'SERIALIZED_UNIT', a.source_id, a.unit_ids, null::text
  from ambiguous_origin a
  order by 1, 2, 4;
end;
$$;

revoke all on function public.serialized_unit_integrity_preflight() from public, anon, authenticated;
grant execute on function public.serialized_unit_integrity_preflight() to authenticated;
