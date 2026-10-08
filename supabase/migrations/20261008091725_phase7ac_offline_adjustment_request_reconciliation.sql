-- Phase 7A-C source-only migration. This narrow status projection does not
-- execute, approve, reject, or mutate inventory.
create function public.offline_inventory_adjustment_request_status_snapshot()
returns table(adjustment_request_id uuid, product_id uuid, variant_id uuid, unit_id uuid, condition public.product_condition, requested_quantity integer, reason text, status text, requested_at timestamptz, reviewed_at timestamptz, rejection_reason text)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_role public.app_role;
begin
  if auth.uid() is null then raise insufficient_privilege using message = 'An authenticated user is required'; end if;
  perform public.require_active_profile();
  v_role := public.current_role();
  if v_role not in ('STAFF', 'MANAGER') then raise insufficient_privilege using message = 'Offline request-status reconciliation is not available for this profile'; end if;
  return query select request.id, request.product_id, request.variant_id, request.unit_id, request.condition, request.requested_quantity, request.reason, request.status::text, request.created_at, request.reviewed_at, request.rejection_reason from public.inventory_adjustment_requests as request where v_role = 'MANAGER' or request.requested_by = auth.uid() order by request.created_at desc, request.id desc;
end;
$$;
revoke all on function public.offline_inventory_adjustment_request_status_snapshot() from public, anon, authenticated;
grant execute on function public.offline_inventory_adjustment_request_status_snapshot() to authenticated;
