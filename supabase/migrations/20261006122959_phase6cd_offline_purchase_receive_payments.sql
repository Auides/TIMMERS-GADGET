-- Phase 6C-D source-only migration. It extends the existing Manager receipt
-- boundary to pass narrowly validated initial-payment intent to the already
-- authoritative purchase_receive transaction. Do not apply from this task.

create or replace function public.offline_purchase_receive(
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
  v_serial_unit jsonb;
  v_payment jsonb;
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
     or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' or pg_catalog.jsonb_array_length(p_lines) = 0
     or pg_catalog.jsonb_typeof(p_initial_payments) is distinct from 'array' then
    raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE' using errcode = '22023';
  end if;

  -- Only caller-entered payment fields cross this offline boundary. The
  -- authoritative transaction still validates the Lagos date, receipt total,
  -- method enum, financial ledger, and every write atomically.
  for v_payment in select value from pg_catalog.jsonb_array_elements(p_initial_payments) loop
    if pg_catalog.jsonb_typeof(v_payment) <> 'object'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_payment) as payment_key(key)
         where payment_key.key not in ('amount', 'method', 'paid_on', 'reference', 'notes')
       )
       or pg_catalog.jsonb_typeof(v_payment -> 'amount') is distinct from 'string'
       or (v_payment ->> 'amount') !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{2}$'
       or (v_payment ->> 'amount') = '0.00'
       or pg_catalog.jsonb_typeof(v_payment -> 'method') is distinct from 'string'
       or (v_payment ->> 'method') not in ('CASH', 'POS', 'BANK_TRANSFER', 'OTHER')
       or pg_catalog.jsonb_typeof(v_payment -> 'paid_on') is distinct from 'string'
       or (v_payment ->> 'paid_on') !~ '^\d{4}-\d{2}-\d{2}$'
       or (v_payment ? 'reference' and pg_catalog.jsonb_typeof(v_payment -> 'reference') not in ('string', 'null'))
       or (v_payment ? 'notes' and pg_catalog.jsonb_typeof(v_payment -> 'notes') not in ('string', 'null')) then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE_PAYMENT' using errcode = '22023';
    end if;
    begin
      perform (v_payment ->> 'paid_on')::date;
    exception when others then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE_PAYMENT' using errcode = '22023';
    end;
  end loop;

  -- Reject client-supplied operational state or database identity. The
  -- authoritative transaction generates unit IDs and lifecycle state itself.
  for v_line in select value from pg_catalog.jsonb_array_elements(p_lines) loop
    if pg_catalog.jsonb_typeof(v_line) <> 'object'
       or v_line ? 'id' or v_line ? 'status' or v_line ? 'lifecycle_revision' or v_line ? 'unit_id'
       or pg_catalog.jsonb_typeof(v_line -> 'serialized_units') is distinct from 'array' then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE' using errcode = '22023';
    end if;
    for v_serial_unit in select value from pg_catalog.jsonb_array_elements(v_line -> 'serialized_units') loop
      if pg_catalog.jsonb_typeof(v_serial_unit) <> 'object'
         or v_serial_unit ? 'id' or v_serial_unit ? 'status' or v_serial_unit ? 'lifecycle_revision' or v_serial_unit ? 'unit_id' then
        raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE' using errcode = '22023';
      end if;
    end loop;
  end loop;

  -- A completed retry is resolved before mutable catalogue checks. The
  -- delegated function verifies actor and canonical full receipt/payment
  -- fingerprint, then returns the stored original result.
  select r.completed_at into v_completed_at
  from public.procurement_operation_reservations r
  where r.request_id = p_request_id;
  if found and v_completed_at is not null then
    return public.purchase_receive(p_request_id, p_supplier_id, p_received_on, p_supplier_reference, p_notes, p_lines, p_initial_payments);
  end if;

  -- This boundary checks only product-shape compatibility. purchase_receive
  -- owns canonical identifiers, payment insertion, totals, locks, WAC,
  -- effects, audit evidence, and complete transactional rollback.
  for v_line in select value from pg_catalog.jsonb_array_elements(p_lines) loop
    begin
      v_product_id := nullif(pg_catalog.btrim(v_line ->> 'product_id'), '')::uuid;
    exception when others then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE_PRODUCT' using errcode = '22023';
    end;
    select p.serialized into v_serialized from public.products p where p.id = v_product_id;
    if not found then
      raise exception 'INVALID_OFFLINE_PURCHASE_RECEIVE_PRODUCT' using errcode = '22023';
    end if;
    if v_serialized then
      if (v_line ? 'unit_cost' and nullif(pg_catalog.btrim(v_line ->> 'unit_cost'), '') is not null)
         or pg_catalog.jsonb_array_length(v_line -> 'serialized_units') = 0 then
        raise exception 'INVALID_OFFLINE_SERIALIZED_PURCHASE_RECEIVE' using errcode = '22023';
      end if;
    elsif pg_catalog.jsonb_array_length(v_line -> 'serialized_units') <> 0 then
      raise exception 'INVALID_OFFLINE_NON_SERIALIZED_PURCHASE_RECEIVE' using errcode = '22023';
    end if;
  end loop;

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
