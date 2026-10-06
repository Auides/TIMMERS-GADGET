-- Phase 6C-B source-only migration. It is intentionally not applied by this task.
-- This is a deliberately narrow Manager boundary around the already-authoritative
-- purchase_receive transaction; it does not calculate WAC or mutate inventory itself.

create function public.offline_purchase_receive(
  p_request_id uuid,
  p_supplier_id uuid,
  p_received_on date,
  p_supplier_reference text,
  p_notes text,
  p_lines jsonb,
  p_initial_payments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_role public.app_role;
  v_line jsonb;
  v_product_id uuid;
  v_serialized boolean;
  v_completed_at timestamptz;
begin
  perform public.require_active_profile();
  v_actor := auth.uid();
  v_role := public.current_role();
  if v_actor is null or v_role is distinct from 'MANAGER'::public.app_role then
    raise insufficient_privilege using message = 'OFFLINE_PURCHASE_RECEIVE_NOT_AUTHORIZED';
  end if;

  if p_request_id is null or p_supplier_id is null or p_received_on is null
     or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0
     or jsonb_typeof(p_initial_payments) is distinct from 'array' or jsonb_array_length(p_initial_payments) <> 0 then
    raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE' using errcode = '22023';
  end if;

  -- Reject serialized units at the server boundary. An empty array is the
  -- route's explicit nonserialized representation and cannot create a unit.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'serialized_units') is distinct from 'array'
       or jsonb_array_length(v_line -> 'serialized_units') <> 0 then
      raise exception 'OFFLINE_PURCHASE_RECEIVE_NON_SERIALIZED_ONLY' using errcode = '22023';
    end if;
  end loop;

  -- Preserve a completed existing receipt replay before considering mutable
  -- catalogue tracking state. purchase_receive validates the same request's
  -- actor/fingerprint and returns only its established replay result.
  select r.completed_at into v_completed_at
  from public.procurement_operation_reservations r
  where r.request_id = p_request_id;
  if found and v_completed_at is not null then
    return public.purchase_receive(p_request_id, p_supplier_id, p_received_on, p_supplier_reference, p_notes, p_lines, p_initial_payments);
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    begin
      v_product_id := nullif(pg_catalog.btrim(v_line ->> 'product_id'), '')::uuid;
    exception when others then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE_PRODUCT' using errcode = '22023';
    end;
    select p.serialized into v_serialized from public.products p where p.id = v_product_id;
    if not found or v_serialized then
      raise exception 'OFFLINE_PURCHASE_RECEIVE_NON_SERIALIZED_ONLY' using errcode = '22023';
    end if;
  end loop;

  -- purchase_receive owns canonical fingerprinting, reservation/replay,
  -- supplier/catalogue/bucket lock order, financial totals, WAC, inventory
  -- effects, audit evidence, and the final atomic commit.
  return public.purchase_receive(
    p_request_id,
    p_supplier_id,
    p_received_on,
    p_supplier_reference,
    p_notes,
    p_lines,
    p_initial_payments
  );
end;
$$;

revoke all on function public.offline_purchase_receive(uuid, uuid, date, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.offline_purchase_receive(uuid, uuid, date, text, text, jsonb, jsonb) to authenticated;
