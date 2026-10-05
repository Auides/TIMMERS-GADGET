-- Phase 6A source-only migration. It is intentionally not applied by this task.
-- The only new offline command is the Manager-only, idempotent SUPPLIER_CREATE.

create table public.offline_supplier_create_operations (
  operation_id uuid primary key,
  idempotency_key uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  supplier_id uuid not null unique references public.suppliers(id) on delete restrict deferrable initially deferred,
  request_fingerprint text not null check (request_fingerprint = btrim(request_fingerprint) and request_fingerprint <> ''),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.offline_supplier_create_operations enable row level security;
revoke all on table public.offline_supplier_create_operations from public, anon, authenticated;

create or replace function public.offline_supplier_create(
  p_operation_id uuid,
  p_idempotency_key uuid,
  p_supplier_id uuid,
  p_business_name text,
  p_contact_name text,
  p_phone text,
  p_email text
)
returns table(supplier_id uuid, idempotent_replay boolean)
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
  v_existing public.offline_supplier_create_operations;
  v_supplier public.suppliers;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_role is distinct from 'MANAGER'::public.app_role then
    raise insufficient_privilege using message = 'SUPPLIER_CREATE_NOT_AUTHORIZED';
  end if;

  v_business_name := nullif(pg_catalog.btrim(p_business_name), '');
  v_contact_name := nullif(pg_catalog.btrim(p_contact_name), '');
  v_phone := nullif(pg_catalog.btrim(p_phone), '');
  v_email := nullif(pg_catalog.btrim(p_email), '');
  if p_operation_id is null or p_idempotency_key is null or p_supplier_id is null or v_business_name is null then
    raise exception 'INVALID_SUPPLIER_CREATE' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'supplier_id', p_supplier_id::text,
    'business_name', v_business_name,
    'contact_name', v_contact_name,
    'phone', v_phone,
    'email', v_email
  )::text);

  -- Reserving first serializes concurrent retries. The deferred supplier FK is
  -- satisfied by the insert below in this same transaction.
  insert into public.offline_supplier_create_operations
    (operation_id, idempotency_key, actor_id, supplier_id, request_fingerprint)
  values
    (p_operation_id, p_idempotency_key, v_actor, p_supplier_id, v_fingerprint)
  on conflict (operation_id) do nothing
  returning * into v_existing;

  if found then
    insert into public.suppliers (id, business_name, contact_name, phone, email)
    values (p_supplier_id, v_business_name, v_contact_name, v_phone, v_email)
    returning * into v_supplier;

    -- Match the established supplier-create audit contract without opening the
    -- procurement audit helper to client roles.
    perform public.procurement_audit(
      v_actor,
      'SUPPLIER_CREATED',
      'SUPPLIER',
      v_supplier.id,
      null,
      pg_catalog.to_jsonb(v_supplier)
    );

    return query select p_supplier_id, false;
    return;
  end if;

  select o.* into v_existing
  from public.offline_supplier_create_operations o
  where o.operation_id = p_operation_id
  for update;

  if not found
     or v_existing.idempotency_key is distinct from p_idempotency_key
     or v_existing.actor_id is distinct from v_actor
     or v_existing.supplier_id is distinct from p_supplier_id
     or v_existing.request_fingerprint is distinct from v_fingerprint then
    raise exception 'SUPPLIER_CREATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.suppliers s where s.id = v_existing.supplier_id) then
    raise exception 'SUPPLIER_CREATE_RESULT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  return query select v_existing.supplier_id, true;
end;
$$;

revoke all on function public.offline_supplier_create(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.offline_supplier_create(uuid, uuid, uuid, text, text, text, text) to authenticated;
