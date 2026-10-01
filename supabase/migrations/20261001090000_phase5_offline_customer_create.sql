-- Phase 5A source-only migration. It is intentionally not applied by this task.
-- Durable, narrow idempotency for the sole approved offline command: CUSTOMER_CREATE.

create table public.offline_customer_create_operations (
  operation_id uuid primary key,
  idempotency_key uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid not null unique references public.customers(id) on delete restrict deferrable initially deferred,
  request_fingerprint text not null check (request_fingerprint = btrim(request_fingerprint) and request_fingerprint <> ''),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.offline_customer_create_operations enable row level security;
revoke all on table public.offline_customer_create_operations from public, anon, authenticated;

create or replace function public.offline_customer_create(
  p_operation_id uuid,
  p_idempotency_key uuid,
  p_customer_id uuid,
  p_full_name text,
  p_phone text,
  p_email text
)
returns table(customer_id uuid, idempotent_replay boolean)
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
  v_existing public.offline_customer_create_operations;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_role not in ('ADMIN'::public.app_role, 'MANAGER'::public.app_role, 'STAFF'::public.app_role) then
    raise insufficient_privilege using message = 'CUSTOMER_CREATE_NOT_AUTHORIZED';
  end if;

  v_full_name := nullif(pg_catalog.btrim(p_full_name), '');
  v_phone := nullif(pg_catalog.btrim(p_phone), '');
  v_email := nullif(pg_catalog.btrim(p_email), '');
  if p_operation_id is null or p_idempotency_key is null or p_customer_id is null or v_full_name is null then
    raise exception 'INVALID_CUSTOMER_CREATE' using errcode = '22023';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'customer_id', p_customer_id::text,
    'full_name', v_full_name,
    'phone', v_phone,
    'email', v_email
  )::text);

  insert into public.offline_customer_create_operations
    (operation_id, idempotency_key, actor_id, customer_id, request_fingerprint)
  values
    (p_operation_id, p_idempotency_key, v_actor, p_customer_id, v_fingerprint)
  on conflict (operation_id) do nothing
  returning * into v_existing;

  if found then
    insert into public.customers (id, full_name, phone, email)
    values (p_customer_id, v_full_name, v_phone, v_email);

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data, metadata)
    values (
      v_actor,
      'CUSTOMER_CREATED',
      'CUSTOMER',
      p_customer_id,
      pg_catalog.jsonb_build_object('customer_id', p_customer_id::text),
      pg_catalog.jsonb_build_object('operation_id', p_operation_id::text, 'idempotency_key', p_idempotency_key::text, 'source', 'OFFLINE_REPLAY')
    );

    return query select p_customer_id, false;
    return;
  end if;

  select o.* into v_existing
  from public.offline_customer_create_operations o
  where o.operation_id = p_operation_id
  for update;

  if not found
     or v_existing.idempotency_key is distinct from p_idempotency_key
     or v_existing.actor_id is distinct from v_actor
     or v_existing.customer_id is distinct from p_customer_id
     or v_existing.request_fingerprint is distinct from v_fingerprint then
    raise exception 'CUSTOMER_CREATE_IDEMPOTENCY_MISMATCH' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.customers c where c.id = v_existing.customer_id) then
    raise exception 'CUSTOMER_CREATE_RESULT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  return query select v_existing.customer_id, true;
end;
$$;

revoke all on function public.offline_customer_create(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.offline_customer_create(uuid, uuid, uuid, text, text, text) to authenticated;
