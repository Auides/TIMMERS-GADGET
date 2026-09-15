-- TIMMERS GADGET - Phase 7 Migration 3B corrective hardening.
--
-- Corrects credit-request validation when a discount is approved for less than
-- the originally requested amount, and explicitly removes direct browser-role
-- customer DML privileges. No sale, payment, inventory, or approval history is
-- mutated by this migration.

create or replace function public.sales_request_credit(
  p_request_id uuid,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_discount_request_id uuid,
  p_approved_discount_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_customer public.customers;
  v_discount_request public.sale_discount_requests;
  v_discount_validation_snapshot jsonb;
  v_base_snapshot jsonb;
  v_snapshot jsonb;
  v_discount_fingerprint text;
  v_fingerprint text;
  v_discount_decision_id uuid;
  v_credit_request public.sale_credit_requests;
  v_gross_subtotal numeric(14,2);
  v_final_total numeric(14,2);
  v_initial_payment numeric(14,2);
  v_outstanding numeric(14,2);
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(v_actor, array['ADMIN', 'MANAGER', 'STAFF']::public.app_role[]);

  if p_customer_id is null then
    raise exception 'CREDIT_CUSTOMER_REQUIRED' using errcode = '22023';
  end if;

  select c.*
    into v_customer
  from public.customers c
  where c.id = p_customer_id;

  if not found
     or nullif(btrim(v_customer.full_name), '') is null
     or nullif(btrim(v_customer.phone), '') is null then
    raise exception 'CREDIT_CUSTOMER_NAME_AND_PHONE_REQUIRED' using errcode = '22023';
  end if;

  if p_approved_discount_amount is null
     or p_approved_discount_amount < 0
     or p_approved_discount_amount <> pg_catalog.round(p_approved_discount_amount, 2) then
    raise exception 'INVALID_CREDIT_DISCOUNT_CONTEXT' using errcode = '22023';
  end if;

  if p_discount_request_id is null then
    if p_approved_discount_amount <> 0 then
      raise exception 'DISCOUNT_APPROVAL_REQUIRED' using errcode = '22023';
    end if;
  else
    -- A discount request fingerprint contains the amount that was REQUESTED.
    -- The approval may legitimately be for a smaller amount. Rebuild the
    -- current authoritative checkout context using the immutable requested
    -- amount for request-fingerprint validation, then separately build the
    -- credit snapshot using the actually approved amount.
    select r.*
      into v_discount_request
    from public.sale_discount_requests r
    where r.id = p_discount_request_id;

    if not found then
      raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0001';
    end if;

    v_discount_validation_snapshot := public.sales_build_checkout_approval_snapshot(
      'CREDIT',
      p_customer_id,
      p_transaction_on,
      p_notes,
      p_lines,
      p_payments,
      v_discount_request.requested_discount_amount
    );
    v_discount_fingerprint := public.sales_fingerprint(v_discount_validation_snapshot);

    v_discount_decision_id := public.sales_validate_discount_approval(
      p_discount_request_id,
      v_discount_fingerprint,
      p_approved_discount_amount
    );
  end if;

  -- The credit request itself must use the approved discount amount because
  -- that is the amount that determines the proposed final total/outstanding.
  v_base_snapshot := public.sales_build_checkout_approval_snapshot(
    'CREDIT',
    p_customer_id,
    p_transaction_on,
    p_notes,
    p_lines,
    p_payments,
    p_approved_discount_amount
  );

  v_snapshot := v_base_snapshot || pg_catalog.jsonb_build_object(
    'discount_request_id', p_discount_request_id::text,
    'discount_decision_id', v_discount_decision_id::text,
    'approved_discount_amount', p_approved_discount_amount::numeric(14,2)
  );

  v_gross_subtotal := (v_snapshot ->> 'gross_subtotal')::numeric(14,2);
  v_final_total := (v_snapshot ->> 'final_total')::numeric(14,2);
  v_initial_payment := (v_snapshot ->> 'initial_payment_total')::numeric(14,2);
  v_outstanding := (v_final_total - v_initial_payment)::numeric(14,2);

  if v_initial_payment < 0
     or v_initial_payment >= v_final_total
     or v_outstanding <= 0 then
    raise exception 'INVALID_CREDIT_PAYMENT_PROPOSAL' using errcode = '22023';
  end if;

  v_fingerprint := public.sales_fingerprint(v_snapshot);
  v_reservation := public.sales_reserve(p_request_id, 'CREDIT_REQUEST', v_fingerprint, v_actor);
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  insert into public.sale_credit_requests (
    requested_by,
    customer_id,
    customer_name_snapshot,
    customer_phone_snapshot,
    checkout_snapshot,
    request_fingerprint,
    gross_subtotal_snapshot,
    final_total_snapshot,
    initial_payment_snapshot,
    proposed_outstanding_credit
  ) values (
    v_actor,
    v_customer.id,
    v_customer.full_name,
    v_customer.phone,
    v_snapshot,
    v_fingerprint,
    v_gross_subtotal,
    v_final_total,
    v_initial_payment,
    v_outstanding
  )
  returning * into v_credit_request;

  v_result := pg_catalog.jsonb_build_object(
    'sale_credit_request_id', v_credit_request.id::text,
    'customer_id', v_credit_request.customer_id::text,
    'gross_subtotal', v_credit_request.gross_subtotal_snapshot,
    'final_total', v_credit_request.final_total_snapshot,
    'initial_payment', v_credit_request.initial_payment_snapshot,
    'proposed_outstanding_credit', v_credit_request.proposed_outstanding_credit,
    'request_fingerprint', v_credit_request.request_fingerprint
  );

  perform public.procurement_audit(
    v_actor,
    'SALES_CREDIT_REQUESTED',
    'SALE_CREDIT_REQUEST',
    v_credit_request.id,
    null,
    v_result,
    pg_catalog.jsonb_build_object(
      'operation',
      'CREDIT_REQUEST',
      'discount_request_id',
      p_discount_request_id::text
    )
  );

  perform public.sales_complete(
    p_request_id,
    'CREDIT_REQUEST',
    v_fingerprint,
    v_actor,
    'SALE_CREDIT_REQUEST',
    v_credit_request.id,
    v_result
  );

  return v_result;
end
$$;

-- Customer creation is intentionally command-RPC-only for browser roles.
-- Existing management SELECT remains governed by RLS, and the security-definer
-- checkout customer-create command remains able to insert.
revoke insert, update, delete on table public.customers from public, anon, authenticated;

-- Reassert the intended command boundary after CREATE OR REPLACE.
revoke all on function public.sales_request_credit(
  uuid, uuid, date, text, jsonb, jsonb, uuid, numeric
) from public, anon;

grant execute on function public.sales_request_credit(
  uuid, uuid, date, text, jsonb, jsonb, uuid, numeric
) to authenticated;
