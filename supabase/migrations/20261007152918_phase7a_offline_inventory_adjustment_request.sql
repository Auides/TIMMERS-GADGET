-- Phase 7A-B source-only migration.  This file is intentionally not applied by
-- the offline client; it introduces a narrow, idempotent request-creation RPC.

create table public.offline_inventory_adjustment_request_operations (
  operation_id uuid primary key,
  idempotency_key uuid not null unique,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  request_fingerprint text not null,
  adjustment_request_id uuid unique references public.inventory_adjustment_requests(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((adjustment_request_id is null) = (completed_at is null))
);

alter table public.offline_inventory_adjustment_request_operations enable row level security;

create function public.offline_inventory_adjustment_request_create(
  p_operation_id uuid,
  p_idempotency_key uuid,
  p_kind text,
  p_product_id uuid,
  p_variant_id uuid,
  p_condition public.product_condition,
  p_unit_id uuid,
  p_requested_quantity integer,
  p_reason text
) returns table(adjustment_request_id uuid, idempotent_replay boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text := upper(btrim(p_kind));
  v_reason text := nullif(btrim(p_reason), '');
  v_fingerprint text;
  v_product public.products%rowtype;
  v_unit public.serialized_units%rowtype;
  v_existing public.offline_inventory_adjustment_request_operations%rowtype;
  v_request public.inventory_adjustment_requests%rowtype;
begin
  perform public.require_active_profile();
  if public.current_role() not in ('STAFF', 'MANAGER') then
    raise insufficient_privilege using message = 'Staff or Manager offline adjustment-request authority is required';
  end if;

  if p_operation_id is null or p_idempotency_key is null or p_requested_quantity is null or p_requested_quantity = 0 or v_reason is null then
    raise exception using errcode = '22023', message = 'Invalid offline adjustment request payload';
  end if;
  if v_kind not in ('NON_SERIALIZED', 'SERIALIZED') then
    raise exception using errcode = '22023', message = 'Invalid offline adjustment request kind';
  end if;

  if v_kind = 'NON_SERIALIZED' then
    if p_unit_id is not null or p_condition is null then
      raise exception using errcode = '22023', message = 'Invalid non-serialized adjustment request';
    end if;
  else
    if p_unit_id is null or p_condition is not null or p_requested_quantity <> -1 then
      raise exception using errcode = '22023', message = 'Invalid serialized adjustment request';
    end if;
  end if;

  v_fingerprint := pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object(
      'kind', v_kind,
      'product_id', p_product_id,
      'variant_id', p_variant_id,
      'condition', p_condition::text,
      'unit_id', p_unit_id,
      'requested_quantity', p_requested_quantity,
      'reason', v_reason
    )::text,
    'sha256'
  ), 'hex');

  insert into public.offline_inventory_adjustment_request_operations(operation_id, idempotency_key, actor_id, request_fingerprint)
  values(p_operation_id, p_idempotency_key, v_actor, v_fingerprint)
  on conflict do nothing;

  if not found then
    select o.* into v_existing
    from public.offline_inventory_adjustment_request_operations o
    where o.operation_id = p_operation_id
    for update;
    if not found
       or v_existing.idempotency_key <> p_idempotency_key
       or v_existing.actor_id <> v_actor
       or v_existing.request_fingerprint <> v_fingerprint
       or v_existing.adjustment_request_id is null
       or v_existing.completed_at is null then
      raise exception using errcode = 'P0001', message = 'Offline adjustment request idempotency conflict';
    end if;
    return query select v_existing.adjustment_request_id, true;
    return;
  end if;

  -- Resolve a completed exact retry above before consulting mutable catalogue
  -- or unit state. A lost response must return its original request identity.
  select p.* into v_product from public.products p where p.id = p_product_id for key share;
  if not found or not v_product.active then
    raise exception using errcode = 'P0001', message = 'The requested product is no longer available';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.product_variants v where v.id = p_variant_id and v.product_id = p_product_id and v.active
  ) then
    raise exception using errcode = 'P0001', message = 'The requested variant is no longer available';
  end if;
  if (v_kind = 'NON_SERIALIZED' and v_product.serialized) or (v_kind = 'SERIALIZED' and not v_product.serialized) then
    raise exception using errcode = '22023', message = 'Adjustment request kind does not match the product';
  end if;
  if v_kind = 'SERIALIZED' then
    select u.* into v_unit from public.serialized_units u where u.id = p_unit_id for key share;
    if not found
       or v_unit.product_id <> p_product_id
       or v_unit.variant_id is distinct from p_variant_id
       or v_unit.status <> 'AVAILABLE' then
      raise exception using errcode = 'P0001', message = 'The serialized unit is no longer available';
    end if;
  end if;

  select * into v_request
  from public.inventory_submit_adjustment_request(
    p_product_id, p_variant_id, p_unit_id, p_condition, p_requested_quantity, v_reason
  );

  update public.offline_inventory_adjustment_request_operations
  set adjustment_request_id = v_request.id, completed_at = now()
  where operation_id = p_operation_id;

  return query select v_request.id, false;
end;
$$;

revoke all on table public.offline_inventory_adjustment_request_operations from public, anon, authenticated;
revoke all on function public.offline_inventory_adjustment_request_create(uuid, uuid, text, uuid, uuid, public.product_condition, uuid, integer, text) from public, anon;
grant execute on function public.offline_inventory_adjustment_request_create(uuid, uuid, text, uuid, uuid, public.product_condition, uuid, integer, text) to authenticated;
