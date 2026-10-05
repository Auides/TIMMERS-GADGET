-- Phase 6B source-only migration. It is intentionally not applied by this task.
-- The suppliers_updated trigger maintains suppliers.updated_at on every update;
-- this server-owned value is the optimistic-concurrency token exposed below.

create table public.offline_supplier_update_operations (
  operation_id uuid primary key,
  idempotency_key uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  expected_supplier_version timestamptz not null,
  request_fingerprint text not null check (request_fingerprint = pg_catalog.btrim(request_fingerprint) and request_fingerprint <> ''),
  applied_supplier_version timestamptz,
  completed_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now()
);

alter table public.offline_supplier_update_operations enable row level security;
revoke all on table public.offline_supplier_update_operations from public, anon, authenticated;

-- Preserve the approved Phase 4A signature while exposing only the server token
-- required for a Manager's narrow offline supplier update.
create function public.manager_supplier_reference_snapshot_v2()
returns table(supplier_id uuid, business_name text, contact_name text, phone text, email text, active boolean, supplier_version timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_active_profile();
  if public.current_role() <> 'MANAGER'::public.app_role then
    raise insufficient_privilege using message = 'SUPPLIER_REFERENCE_NOT_AUTHORIZED';
  end if;

  return query
  select s.id, s.business_name, s.contact_name, s.phone, s.email, s.active, s.updated_at
  from public.suppliers s
  order by s.business_name, s.id;
end;
$$;

revoke all on function public.manager_supplier_reference_snapshot_v2() from public, anon, authenticated;
grant execute on function public.manager_supplier_reference_snapshot_v2() to authenticated;

create function public.offline_supplier_update(
  p_operation_id uuid,
  p_idempotency_key uuid,
  p_supplier_id uuid,
  p_business_name text,
  p_contact_name text,
  p_phone text,
  p_email text,
  p_expected_supplier_version timestamptz
)
returns table(supplier_id uuid, supplier_version timestamptz, idempotent_replay boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_business_name text;
  v_contact_name text;
  v_phone text;
  v_email text;
  v_fingerprint text;
  v_existing public.offline_supplier_update_operations;
  v_supplier public.suppliers;
  v_before jsonb;
  v_updated_at timestamptz;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_role is distinct from 'MANAGER'::public.app_role then
    raise insufficient_privilege using message = 'SUPPLIER_UPDATE_NOT_AUTHORIZED';
  end if;

  v_business_name := nullif(pg_catalog.btrim(p_business_name), '');
  v_contact_name := nullif(pg_catalog.btrim(p_contact_name), '');
  v_phone := nullif(pg_catalog.btrim(p_phone), '');
  v_email := nullif(pg_catalog.btrim(p_email), '');
  if p_operation_id is null or p_idempotency_key is null or p_supplier_id is null
     or p_expected_supplier_version is null or v_business_name is null then
    raise exception 'INVALID_SUPPLIER_UPDATE' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'supplier_id', p_supplier_id::text,
    'business_name', v_business_name,
    'contact_name', v_contact_name,
    'phone', v_phone,
    'email', v_email,
    'expected_supplier_version', p_expected_supplier_version
  )::text);

  -- Resolve a committed matching operation before inspecting the supplier token.
  -- A lost-response retry is therefore replayed rather than reported as stale.
  select o.* into v_existing
  from public.offline_supplier_update_operations o
  where o.operation_id = p_operation_id
  for update;

  if found then
    if v_existing.idempotency_key is distinct from p_idempotency_key
       or v_existing.actor_id is distinct from v_actor
       or v_existing.supplier_id is distinct from p_supplier_id
       or v_existing.expected_supplier_version is distinct from p_expected_supplier_version
       or v_existing.request_fingerprint is distinct from v_fingerprint
       or v_existing.applied_supplier_version is null then
      raise exception 'SUPPLIER_UPDATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return query select v_existing.supplier_id, v_existing.applied_supplier_version, true;
    return;
  end if;

  -- Reserve first. A concurrent retry waits and follows the replay branch.
  insert into public.offline_supplier_update_operations
    (operation_id, idempotency_key, actor_id, supplier_id, expected_supplier_version, request_fingerprint)
  values
    (p_operation_id, p_idempotency_key, v_actor, p_supplier_id, p_expected_supplier_version, v_fingerprint)
  on conflict do nothing
  returning * into v_existing;

  if not found then
    select o.* into v_existing
    from public.offline_supplier_update_operations o
    where o.operation_id = p_operation_id
    for update;
    if not found
       or v_existing.idempotency_key is distinct from p_idempotency_key
       or v_existing.actor_id is distinct from v_actor
       or v_existing.supplier_id is distinct from p_supplier_id
       or v_existing.expected_supplier_version is distinct from p_expected_supplier_version
       or v_existing.request_fingerprint is distinct from v_fingerprint
       or v_existing.applied_supplier_version is null then
      raise exception 'SUPPLIER_UPDATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
    end if;
    return query select v_existing.supplier_id, v_existing.applied_supplier_version, true;
    return;
  end if;

  select s.* into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id
  for update;

  if not found then
    raise exception 'SUPPLIER_UPDATE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_supplier.updated_at is distinct from p_expected_supplier_version then
    raise exception 'SUPPLIER_UPDATE_STALE' using errcode = 'P0001';
  end if;
  -- Preserve the online archive rule: archived suppliers retain their business name.
  if not v_supplier.active and v_business_name is distinct from v_supplier.business_name then
    raise exception 'SUPPLIER_UPDATE_ARCHIVED_NAME' using errcode = 'P0001';
  end if;

  v_before := pg_catalog.to_jsonb(v_supplier);
  update public.suppliers s
  set business_name = case when s.active then v_business_name else s.business_name end,
      contact_name = v_contact_name,
      phone = v_phone,
      email = v_email
  where s.id = p_supplier_id
  returning s.updated_at into v_updated_at;

  select s.* into v_supplier from public.suppliers s where s.id = p_supplier_id;
  update public.offline_supplier_update_operations o
  set applied_supplier_version = v_updated_at
  where o.operation_id = p_operation_id;

  perform public.procurement_audit(
    v_actor,
    'SUPPLIER_UPDATED',
    'SUPPLIER',
    p_supplier_id,
    v_before,
    pg_catalog.to_jsonb(v_supplier),
    pg_catalog.jsonb_build_object('operation_id', p_operation_id::text, 'idempotency_key', p_idempotency_key::text, 'source', 'OFFLINE_REPLAY')
  );

  return query select p_supplier_id, v_updated_at, false;
end;
$$;

revoke all on function public.offline_supplier_update(uuid, uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.offline_supplier_update(uuid, uuid, uuid, text, text, text, text, timestamptz) to authenticated;
