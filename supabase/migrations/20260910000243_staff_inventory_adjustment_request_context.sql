-- Staff can read their own request rows through RLS, but not the protected
-- serialized identity tables. This is a deliberately narrow historical
-- projection for request-card enrichment only.
create function public.staff_inventory_adjustment_request_context()
returns table(
  adjustment_request_id uuid,
  product_name text,
  product_sku text,
  variant_label text,
  variant_sku text,
  identifiers jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise insufficient_privilege using message = 'An authenticated user is required';
  end if;

  perform public.require_active_profile();

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and profile.is_active
      and profile.role = 'STAFF'::public.app_role
  ) then
    raise insufficient_privilege using message = 'This Staff request-history lookup is not available for this profile';
  end if;

  return query
  select
    request.id,
    product.name,
    product.sku,
    variant.label,
    variant.sku,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'type', identifier.identifier_type::text,
            'value', identifier.normalized_value
          )
          order by
            case identifier.identifier_type::text
              when 'IMEI_1' then 1
              when 'IMEI_2' then 2
              when 'SERIAL' then 3
              else 99
            end,
            identifier.normalized_value
        )
        from public.unit_identifiers as identifier
        where identifier.unit_id = request.unit_id
      ),
      '[]'::jsonb
    )
  from public.inventory_adjustment_requests as request
  join public.products as product
    on product.id = request.product_id
  left join public.product_variants as variant
    on variant.id = request.variant_id
   and variant.product_id = request.product_id
  where request.requested_by = auth.uid()
  order by request.created_at desc;
end;
$$;

revoke all on function public.staff_inventory_adjustment_request_context() from public, anon, authenticated;
grant execute on function public.staff_inventory_adjustment_request_context() to authenticated;
