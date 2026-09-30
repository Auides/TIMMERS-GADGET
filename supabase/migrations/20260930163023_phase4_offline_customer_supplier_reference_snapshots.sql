-- Phase 4A source-only migration. It is intentionally not applied by this task.
-- Narrow encrypted-cache projections: no credit, sales, purchase, payment, cost, or history data.

create or replace function public.staff_customer_reference_snapshot()
returns table(customer_id uuid, full_name text, phone text, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_active_profile();

  return query
  select c.id, c.full_name, c.phone, c.email
  from public.customers c
  order by c.full_name, c.id;
end;
$$;

create or replace function public.manager_supplier_reference_snapshot()
returns table(supplier_id uuid, business_name text, contact_name text, phone text, email text, active boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_active_profile();
  if public.current_role() <> 'MANAGER'::public.app_role then
    raise insufficient_privilege using message = 'Manager authority is required for supplier references';
  end if;

  return query
  select s.id, s.business_name, s.contact_name, s.phone, s.email, s.active
  from public.suppliers s
  order by s.business_name, s.id;
end;
$$;

revoke all on function public.staff_customer_reference_snapshot() from public, anon, authenticated;
revoke all on function public.manager_supplier_reference_snapshot() from public, anon, authenticated;
grant execute on function public.staff_customer_reference_snapshot() to authenticated;
grant execute on function public.manager_supplier_reference_snapshot() to authenticated;
