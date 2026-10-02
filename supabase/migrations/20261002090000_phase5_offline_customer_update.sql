-- Phase 5B source-only migration. It is intentionally not applied by this task.
-- The existing customers_updated trigger changes customers.updated_at on every update;
-- that server-maintained value is the optimistic-concurrency token exposed below.

create table public.offline_customer_update_operations (
  operation_id uuid primary key,
  idempotency_key uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  expected_customer_version timestamptz not null,
  request_fingerprint text not null check (request_fingerprint = pg_catalog.btrim(request_fingerprint) and request_fingerprint <> ''),
  applied_customer_version timestamptz,
  completed_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now()
);

alter table public.offline_customer_update_operations enable row level security;
revoke all on table public.offline_customer_update_operations from public, anon, authenticated;

-- A new name preserves the already-approved Phase 4A function signature while
-- extending only the customer reference projection with its server version.
create function public.staff_customer_reference_snapshot_v2()
returns table(customer_id uuid, full_name text, phone text, email text, customer_version timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();

  return query
  select c.id, c.full_name, c.phone, c.email, c.updated_at
  from public.customers c
  order by c.full_name, c.id;
end;
$$;

revoke all on function public.staff_customer_reference_snapshot_v2() from public, anon, authenticated;
grant execute on function public.staff_customer_reference_snapshot_v2() to authenticated;

create function public.offline_customer_update(
  p_operation_id uuid,
  p_idempotency_key uuid,
  p_customer_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_expected_customer_version timestamptz
)
returns table(customer_id uuid, customer_version timestamptz, idempotent_replay boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_full_name text;
  v_phone text;
  v_email text;
  v_fingerprint text;
  v_existing public.offline_customer_update_operations;
  v_customer public.customers;
  v_updated_at timestamptz;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_role not in ('ADMIN'::public.app_role, 'MANAGER'::public.app_role, 'STAFF'::public.app_role) then
    raise insufficient_privilege using message = 'CUSTOMER_UPDATE_NOT_AUTHORIZED';
  end if;

  v_full_name := nullif(pg_catalog.btrim(p_full_name), '');
  v_phone := nullif(pg_catalog.btrim(p_phone), '');
  v_email := nullif(pg_catalog.btrim(p_email), '');
  if p_operation_id is null or p_idempotency_key is null or p_customer_id is null
     or p_expected_customer_version is null or v_full_name is null then
    raise exception 'INVALID_CUSTOMER_UPDATE' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'customer_id', p_customer_id::text,
    'full_name', v_full_name,
    'phone', v_phone,
    'email', v_email,
    'expected_customer_version', p_expected_customer_version
  )::text);

  -- Check a prior committed operation before inspecting the current row version.
  -- This makes a lost response retry return the original result, not a false stale conflict.
  select o.* into v_existing
  from public.offline_customer_update_operations o
  where o.operation_id = p_operation_id
  for update;

  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
       or v_existing.actor_id is distinct from v_actor
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.expected_customer_version is distinct from p_expected_customer_version
       or v_existing.request_fingerprint is distinct from v_fingerprint
       or v_existing.applied_customer_version is null then
      raise exception 'CUSTOMER_UPDATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return query select v_existing.customer_id, v_existing.applied_customer_version, true;
    return;
  end if;

  -- Reserve first. A concurrent retry waits on this row and then follows the replay branch above.
  insert into public.offline_customer_update_operations
    (operation_id, idempotency_key, actor_id, customer_id, expected_customer_version, request_fingerprint)
  values
    (p_operation_id, p_idempotency_key, v_actor, p_customer_id, p_expected_customer_version, v_fingerprint)
  on conflict do nothing
  returning * into v_existing;

  if not found then
    select o.* into v_existing
    from public.offline_customer_update_operations o
    where o.operation_id = p_operation_id
    for update;
    if not found
       or v_existing.idempotency_key is distinct from p_idempotency_key
       or v_existing.actor_id is distinct from v_actor
       or v_existing.customer_id is distinct from p_customer_id
       or v_existing.expected_customer_version is distinct from p_expected_customer_version
       or v_existing.request_fingerprint is distinct from v_fingerprint
       or v_existing.applied_customer_version is null then
      raise exception 'CUSTOMER_UPDATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return query select v_existing.customer_id, v_existing.applied_customer_version, true;
    return;
  end if;

  select c.* into v_customer
  from public.customers c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'CUSTOMER_UPDATE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_customer.updated_at is distinct from p_expected_customer_version then
    raise exception 'CUSTOMER_UPDATE_STALE' using errcode = 'P0001';
  end if;

  update public.customers c
  set full_name = v_full_name,
      phone = v_phone,
      email = v_email
  where c.id = p_customer_id
  returning c.updated_at into v_updated_at;

  update public.offline_customer_update_operations o
  set applied_customer_version = v_updated_at
  where o.operation_id = p_operation_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data, metadata)
  values (
    v_actor,
    'CUSTOMER_UPDATED',
    'CUSTOMER',
    p_customer_id,
    pg_catalog.jsonb_build_object('customer_id', p_customer_id::text),
    pg_catalog.jsonb_build_object('operation_id', p_operation_id::text, 'idempotency_key', p_idempotency_key::text, 'source', 'OFFLINE_REPLAY')
  );

  return query select p_customer_id, v_updated_at, false;
end;
$$;

revoke all on function public.offline_customer_update(uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.offline_customer_update(uuid, uuid, uuid, text, text, text, timestamptz) to authenticated;
