-- TIMMERS GADGET - Phase 7 Migration 3C: atomic sales checkout finalization.
--
-- Adds only the authoritative checkout command. Post-sale repayment/reversal
-- workflows and UI/read-boundary work remain for later migrations.

create or replace function public.sales_finalize_checkout(
  p_request_id uuid,
  p_sale_kind public.sale_kind,
  p_customer_id uuid,
  p_transaction_on date,
  p_notes text,
  p_lines jsonb,
  p_payments jsonb,
  p_discount_request_id uuid,
  p_approved_discount_amount numeric,
  p_credit_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_reservation public.sales_operation_reservations;
  v_intent jsonb;
  v_intent_fingerprint text;
  v_discount_request public.sale_discount_requests;
  v_discount_decision public.sale_discount_decisions;
  v_discount_decision_id uuid;
  v_discount_validation_snapshot jsonb;
  v_discount_fingerprint text;
  v_credit_request public.sale_credit_requests;
  v_credit_decision public.sale_credit_decisions;
  v_credit_decision_id uuid;
  v_credit_snapshot jsonb;
  v_credit_fingerprint text;
  v_customer public.customers;
  v_product public.products;
  v_variant public.product_variants;
  v_price public.catalogue_prices;
  v_bucket public.stock_buckets;
  v_unit public.serialized_units;
  v_sale public.sales;
  v_sale_line public.sale_lines;
  v_sale_serialized public.sale_serialized_units;
  v_payment_row public.sale_payments;
  v_bucket_effect public.inventory_bucket_effects;
  v_movement public.inventory_movements;
  v_lifecycle_effect public.serialized_unit_lifecycle_effects;
  v_base_snapshot jsonb;
  v_allocations jsonb;
  v_line jsonb;
  v_payment jsonb;
  v_product_id uuid;
  v_variant_id uuid;
  v_unit_id uuid;
  v_condition public.product_condition;
  v_quantity integer;
  v_line_number integer;
  v_tracking_mode boolean;
  v_gross_unit_price numeric(14,2);
  v_line_gross numeric(14,2);
  v_allocated_discount numeric(14,2);
  v_line_cogs numeric(14,2);
  v_current_cogs numeric(14,2);
  v_total_cogs_written numeric(14,2) := 0;
  v_gross_subtotal numeric(14,2);
  v_discount_total numeric(14,2);
  v_final_total numeric(14,2);
  v_initial_payment_total numeric(14,2);
  v_outstanding numeric(14,2);
  v_identifier text;
  v_before_quantity integer;
  v_before_wac numeric(14,2);
  v_before_revision bigint;
  v_before_unit_revision bigint;
  v_payment_amount numeric(14,2);
  v_payment_paid_on date;
  v_payment_method public.supplier_payment_method;
  v_today date;
  v_result jsonb;
begin
  v_actor := public.sales_require_active_actor();
  perform public.sales_require_role(
    v_actor,
    array['ADMIN', 'MANAGER', 'STAFF']::public.app_role[]
  );

  v_today := public.procurement_lagos_today();

  if p_sale_kind is null
     or p_transaction_on is null
     or p_transaction_on > v_today
     or p_approved_discount_amount is null
     or p_approved_discount_amount < 0
     or p_approved_discount_amount <> pg_catalog.round(p_approved_discount_amount, 2)
     or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_lines) = 0
     or pg_catalog.jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'INVALID_CHECKOUT_CONTEXT' using errcode = '22023';
  end if;

  if p_sale_kind = 'ORDINARY' and p_credit_request_id is not null then
    raise exception 'ORDINARY_SALE_CANNOT_USE_CREDIT_APPROVAL' using errcode = '22023';
  elsif p_sale_kind = 'CREDIT' and p_credit_request_id is null then
    raise exception 'CREDIT_APPROVAL_REQUIRED' using errcode = 'P0001';
  end if;

  if p_discount_request_id is null and p_approved_discount_amount <> 0 then
    raise exception 'DISCOUNT_APPROVAL_REQUIRED' using errcode = 'P0001';
  elsif p_discount_request_id is not null and p_approved_discount_amount <= 0 then
    raise exception 'INVALID_APPROVED_DISCOUNT' using errcode = '22023';
  end if;

  if p_sale_kind = 'CREDIT' and p_customer_id is null then
    raise exception 'CREDIT_CUSTOMER_REQUIRED' using errcode = '22023';
  end if;

  -- Idempotency is claimed from normalized caller intent before any business
  -- locks. Current prices/stock remain server-authoritative and are revalidated
  -- below; a completed identical request replays without a second sale.
  v_intent := public.sales_canonical_checkout_payload(
    p_sale_kind,
    p_customer_id,
    p_transaction_on,
    p_notes,
    p_lines,
    p_payments,
    p_approved_discount_amount
  ) || pg_catalog.jsonb_build_object(
    'discount_request_id', p_discount_request_id::text,
    'credit_request_id', p_credit_request_id::text
  );

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
    group by
      l.value ->> 'product_id',
      l.value ->> 'variant_id',
      l.value ->> 'condition'
    having count(*) > 1
  ) then
    raise exception 'DUPLICATE_CHECKOUT_LINE' using errcode = '22023';
  end if;

  v_intent_fingerprint := public.sales_fingerprint(v_intent);
  v_reservation := public.sales_reserve(
    p_request_id,
    'CHECKOUT_FINALIZATION',
    v_intent_fingerprint,
    v_actor
  );
  if v_reservation.completed_at is not null then
    return v_reservation.result;
  end if;

  -- Global lock order:
  -- reservation -> approvals -> customer -> catalogue -> buckets -> units.
  if p_discount_request_id is not null then
    select r.*
      into v_discount_request
    from public.sale_discount_requests r
    where r.id = p_discount_request_id
    for update;
    if not found then
      raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0001';
    end if;

    select d.*
      into v_discount_decision
    from public.sale_discount_decisions d
    where d.sale_discount_request_id = p_discount_request_id
    for update;
    if not found or v_discount_decision.decision <> 'APPROVED' then
      raise exception 'APPROVAL_NOT_APPROVED' using errcode = 'P0001';
    end if;
  end if;

  if p_credit_request_id is not null then
    select r.*
      into v_credit_request
    from public.sale_credit_requests r
    where r.id = p_credit_request_id
    for update;
    if not found then
      raise exception 'APPROVAL_NOT_FOUND' using errcode = 'P0001';
    end if;

    select d.*
      into v_credit_decision
    from public.sale_credit_decisions d
    where d.sale_credit_request_id = p_credit_request_id
    for update;
    if not found or v_credit_decision.decision <> 'APPROVED' then
      raise exception 'APPROVAL_NOT_APPROVED' using errcode = 'P0001';
    end if;
  end if;

  if p_customer_id is not null then
    select c.*
      into v_customer
    from public.customers c
    where c.id = p_customer_id
    for share;
    if not found then
      raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0001';
    end if;

    if p_sale_kind = 'CREDIT'
       and (
         nullif(btrim(v_customer.full_name), '') is null
         or nullif(btrim(v_customer.phone), '') is null
       ) then
      raise exception 'CREDIT_CUSTOMER_NAME_AND_PHONE_REQUIRED' using errcode = '22023';
    end if;
  end if;

  -- Lock all catalogue authority in canonical line order. Product locks also
  -- serialize approved catalogue mutation RPCs, which lock their parent product.
  for v_line in
    select l.value
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
  loop
    v_product_id := nullif(btrim(v_line ->> 'product_id'), '')::uuid;
    v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
    v_condition := nullif(btrim(v_line ->> 'condition'), '')::public.product_condition;
    v_quantity := nullif(btrim(v_line ->> 'quantity'), '')::integer;

    if v_product_id is null
       or v_condition is null
       or v_quantity is null
       or v_quantity <= 0 then
      raise exception 'INVALID_CHECKOUT_LINE' using errcode = '22023';
    end if;

    select p.*
      into v_product
    from public.products p
    where p.id = v_product_id
    for share;
    if not found or not v_product.active then
      raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0001';
    end if;

    if v_variant_id is null then
      if exists (
        select 1
        from public.product_variants pv
        where pv.product_id = v_product_id
          and pv.active
      ) then
        raise exception 'VARIANT_INVALID' using errcode = 'P0001';
      end if;
    else
      select pv.*
        into v_variant
      from public.product_variants pv
      where pv.id = v_variant_id
        and pv.product_id = v_product_id
      for share;
      if not found or not v_variant.active then
        raise exception 'VARIANT_INVALID' using errcode = 'P0001';
      end if;
    end if;

    select cp.*
      into v_price
    from public.catalogue_prices cp
    where cp.product_id = v_product_id
      and cp.variant_id is not distinct from v_variant_id
      and cp.condition = v_condition
      and cp.active
    for share;
    if not found then
      raise exception 'PRICE_NOT_FOUND' using errcode = 'P0001';
    end if;

    if v_product.serialized then
      if pg_catalog.jsonb_array_length(v_line -> 'serialized_unit_ids') <> v_quantity then
        raise exception 'SERIALIZED_QUANTITY_MISMATCH' using errcode = '22023';
      end if;
    elsif pg_catalog.jsonb_array_length(v_line -> 'serialized_unit_ids') <> 0 then
      raise exception 'NONSERIALIZED_LINE_HAS_SERIALIZED_UNITS' using errcode = '22023';
    end if;
  end loop;

  -- Lock exact nonserialized buckets in the same canonical product/variant/
  -- condition order. No mutation happens until every required resource is held.
  for v_line in
    select l.value
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
    v_condition := (v_line ->> 'condition')::public.product_condition;
    v_quantity := (v_line ->> 'quantity')::integer;

    select p.*
      into v_product
    from public.products p
    where p.id = v_product_id;

    if not v_product.serialized then
      select b.*
        into v_bucket
      from public.stock_buckets b
      where b.serialized = false
        and b.product_id = v_product_id
        and b.variant_id is not distinct from v_variant_id
        and b.condition = v_condition
      for update;

      if not found then
        raise exception 'STOCK_BUCKET_NOT_FOUND' using errcode = 'P0001';
      end if;
      if v_bucket.quantity < v_quantity then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
    cross join lateral pg_catalog.jsonb_array_elements(l.value -> 'serialized_unit_ids') u(value)
    where u.value = 'null'::jsonb
  ) then
    raise exception 'SERIALIZED_UNIT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
    cross join lateral pg_catalog.jsonb_array_elements(l.value -> 'serialized_unit_ids') u(value)
    group by (u.value #>> '{}')::uuid
    having count(*) > 1
  ) then
    raise exception 'DUPLICATE_SERIALIZED_UNIT' using errcode = '22023';
  end if;

  -- All serialized units are locked after all buckets, globally ordered by UUID.
  for v_unit_id in
    select distinct (u.value #>> '{}')::uuid
    from pg_catalog.jsonb_array_elements(v_intent -> 'lines') l(value)
    cross join lateral pg_catalog.jsonb_array_elements(l.value -> 'serialized_unit_ids') u(value)
    order by 1
  loop
    select su.*
      into v_unit
    from public.serialized_units su
    where su.id = v_unit_id
    for update;
    if not found then
      raise exception 'SERIALIZED_UNIT_NOT_FOUND' using errcode = 'P0001';
    end if;
  end loop;

  -- Rebuild current authoritative snapshots only after every catalogue and
  -- inventory row required by the checkout is locked.
  if p_discount_request_id is not null then
    v_discount_validation_snapshot := public.sales_build_checkout_approval_snapshot(
      p_sale_kind,
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

  v_base_snapshot := public.sales_build_checkout_approval_snapshot(
    p_sale_kind,
    p_customer_id,
    p_transaction_on,
    p_notes,
    p_lines,
    p_payments,
    p_approved_discount_amount
  );

  v_gross_subtotal := (v_base_snapshot ->> 'gross_subtotal')::numeric(14,2);
  v_discount_total := p_approved_discount_amount::numeric(14,2);
  v_final_total := (v_base_snapshot ->> 'final_total')::numeric(14,2);
  v_initial_payment_total := (v_base_snapshot ->> 'initial_payment_total')::numeric(14,2);
  v_outstanding := (v_final_total - v_initial_payment_total)::numeric(14,2);

  if p_sale_kind = 'ORDINARY' then
    if v_initial_payment_total is distinct from v_final_total then
      raise exception 'ORDINARY_SALE_MUST_BE_FULLY_PAID' using errcode = '22023';
    end if;
  else
    if v_initial_payment_total < 0
       or v_initial_payment_total >= v_final_total
       or v_outstanding <= 0 then
      raise exception 'INVALID_CREDIT_PAYMENT_PROPOSAL' using errcode = '22023';
    end if;

    v_credit_snapshot := v_base_snapshot || pg_catalog.jsonb_build_object(
      'discount_request_id', p_discount_request_id::text,
      'discount_decision_id', v_discount_decision_id::text,
      'approved_discount_amount', v_discount_total
    );
    v_credit_fingerprint := public.sales_fingerprint(v_credit_snapshot);
    v_credit_decision_id := public.sales_validate_credit_approval(
      p_credit_request_id,
      v_credit_fingerprint,
      p_customer_id,
      v_final_total,
      v_initial_payment_total,
      v_outstanding
    );
  end if;

  -- Payment dates are server-validated independently of monetary totals.
  for v_payment in
    select p.value
    from pg_catalog.jsonb_array_elements(v_base_snapshot -> 'payments') p(value)
  loop
    v_payment_amount := nullif(btrim(v_payment ->> 'amount'), '')::numeric(14,2);
    v_payment_paid_on := nullif(btrim(v_payment ->> 'paid_on'), '')::date;
    v_payment_method := upper(btrim(v_payment ->> 'method'))::public.supplier_payment_method;

    if v_payment_amount is null
       or v_payment_amount <= 0
       or v_payment_paid_on is null
       or v_payment_paid_on < p_transaction_on
       or v_payment_paid_on > v_today then
      raise exception 'INVALID_SALE_PAYMENT' using errcode = '22023';
    end if;
  end loop;

  v_current_cogs := public.sales_current_checkout_cogs(v_base_snapshot);

  -- An approval that has become below-cost because current inventory COGS
  -- changed since decision time cannot silently pass unless the immutable
  -- decision contains explicit Admin below-cost authorization.
  if p_discount_request_id is not null
     and v_final_total < v_current_cogs
     and not coalesce(v_discount_decision.admin_below_cost_authorized, false) then
    raise exception 'DISCOUNT_BELOW_CURRENT_COGS_REQUIRES_ADMIN' using errcode = '42501';
  end if;

  if v_gross_subtotal = 0 then
    if v_discount_total <> 0 then
      raise exception 'DISCOUNT_EXCEEDS_GROSS_SUBTOTAL' using errcode = '22023';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'line_number', (l.value ->> 'line_number')::integer,
        'gross_subtotal', (l.value ->> 'gross_subtotal')::numeric(14,2),
        'allocated_discount', 0::numeric(14,2)
      )
      order by (l.value ->> 'line_number')::integer
    )
      into v_allocations
    from pg_catalog.jsonb_array_elements(v_base_snapshot -> 'lines') l(value);
  else
    v_allocations := public.sales_allocate_discount(
      v_base_snapshot -> 'lines',
      v_discount_total
    );
  end if;

  insert into public.sales (
    customer_id,
    sale_kind,
    transaction_on,
    customer_name_snapshot,
    customer_phone_snapshot,
    gross_subtotal,
    discount_total,
    final_total,
    notes,
    discount_request_id,
    credit_request_id,
    finalized_by
  ) values (
    p_customer_id,
    p_sale_kind,
    p_transaction_on,
    case when p_customer_id is null then null else v_customer.full_name end,
    case when p_customer_id is null then null else v_customer.phone end,
    v_gross_subtotal,
    v_discount_total,
    v_final_total,
    nullif(btrim(p_notes), ''),
    p_discount_request_id,
    p_credit_request_id,
    v_actor
  )
  returning * into v_sale;

  -- Persist immutable line revenue/COGS, then apply each already-locked
  -- inventory mutation and its exact provenance evidence.
  for v_line in
    select l.value
    from pg_catalog.jsonb_array_elements(v_base_snapshot -> 'lines') l(value)
    order by (l.value ->> 'line_number')::integer
  loop
    v_line_number := (v_line ->> 'line_number')::integer;
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_variant_id := nullif(btrim(v_line ->> 'variant_id'), '')::uuid;
    v_condition := (v_line ->> 'condition')::public.product_condition;
    v_quantity := (v_line ->> 'quantity')::integer;
    v_tracking_mode := (v_line ->> 'tracking_mode')::boolean;
    v_gross_unit_price := (v_line ->> 'selling_price')::numeric(14,2);
    v_line_gross := (v_line ->> 'gross_subtotal')::numeric(14,2);

    select (a.value ->> 'allocated_discount')::numeric(14,2)
      into v_allocated_discount
    from pg_catalog.jsonb_array_elements(v_allocations) a(value)
    where (a.value ->> 'line_number')::integer = v_line_number;

    if v_allocated_discount is null then
      raise exception 'INVALID_DISCOUNT_ALLOCATION' using errcode = 'P0001';
    end if;

    select p.*
      into v_product
    from public.products p
    where p.id = v_product_id;

    if v_variant_id is not null then
      select pv.*
        into v_variant
      from public.product_variants pv
      where pv.id = v_variant_id;
    end if;

    if v_tracking_mode then
      v_line_cogs := 0;

      for v_unit_id in
        select (u.value #>> '{}')::uuid
        from pg_catalog.jsonb_array_elements(v_line -> 'serialized_unit_ids') u(value)
        order by 1
      loop
        select su.*
          into v_unit
        from public.serialized_units su
        where su.id = v_unit_id;

        if not found
           or v_unit.status is distinct from 'AVAILABLE'
           or v_unit.product_id is distinct from v_product_id
           or v_unit.variant_id is distinct from v_variant_id
           or v_unit.condition is distinct from v_condition then
          raise exception 'SERIALIZED_UNIT_UNAVAILABLE_OR_MISMATCH' using errcode = 'P0001';
        end if;

        v_line_cogs := v_line_cogs + v_unit.acquisition_cost::numeric(14,2);
      end loop;

      insert into public.sale_lines (
        sale_id,
        line_number,
        product_id,
        variant_id,
        condition,
        product_name_snapshot,
        variant_label_snapshot,
        tracking_mode_snapshot,
        quantity,
        gross_unit_price,
        gross_subtotal,
        allocated_discount,
        net_revenue,
        nonserialized_wac_snapshot,
        total_cogs_snapshot
      ) values (
        v_sale.id,
        v_line_number,
        v_product_id,
        v_variant_id,
        v_condition,
        v_product.name,
        case when v_variant_id is null then null else v_variant.label end,
        true,
        v_quantity,
        v_gross_unit_price,
        v_line_gross,
        v_allocated_discount,
        (v_line_gross - v_allocated_discount)::numeric(14,2),
        null,
        v_line_cogs
      )
      returning * into v_sale_line;

      for v_unit_id in
        select (u.value #>> '{}')::uuid
        from pg_catalog.jsonb_array_elements(v_line -> 'serialized_unit_ids') u(value)
        order by 1
      loop
        select su.*
          into v_unit
        from public.serialized_units su
        where su.id = v_unit_id;

        select ui.normalized_value
          into v_identifier
        from public.unit_identifiers ui
        where ui.unit_id = v_unit.id
        order by ui.identifier_type, ui.normalized_value
        limit 1;

        if v_identifier is null then
          raise exception 'SERIALIZED_UNIT_IDENTIFIER_REQUIRED' using errcode = 'P0001';
        end if;

        v_before_unit_revision := v_unit.lifecycle_revision;

        insert into public.sale_serialized_units (
          sale_id,
          sale_line_id,
          serialized_unit_id,
          acquisition_cost_snapshot,
          serialized_unit_identifier_snapshot,
          unit_revision_before,
          unit_revision_after
        ) values (
          v_sale.id,
          v_sale_line.id,
          v_unit.id,
          v_unit.acquisition_cost,
          v_identifier,
          v_before_unit_revision,
          v_before_unit_revision + 1
        )
        returning * into v_sale_serialized;

        update public.serialized_units
        set status = 'SOLD',
            lifecycle_revision = v_before_unit_revision + 1
        where id = v_unit.id
          and status = 'AVAILABLE'
          and lifecycle_revision = v_before_unit_revision
        returning * into v_unit;

        if not found then
          raise exception 'SERIALIZED_UNIT_UNAVAILABLE' using errcode = 'P0001';
        end if;

        insert into public.inventory_movements (
          product_id,
          variant_id,
          unit_id,
          movement,
          quantity,
          condition_before,
          condition_after,
          unit_cost,
          reference_type,
          reference_id,
          reason,
          performed_by,
          sale_id
        ) values (
          v_product_id,
          v_variant_id,
          v_unit.id,
          'SALE',
          -1,
          v_condition,
          v_condition,
          v_unit.acquisition_cost,
          'SALE',
          v_sale.id,
          'Sale checkout',
          v_actor,
          v_sale.id
        )
        returning * into v_movement;

        insert into public.serialized_unit_lifecycle_effects (
          movement,
          unit_id,
          movement_id,
          status_before,
          status_after,
          condition_before,
          condition_after,
          unit_revision_before,
          unit_revision_after,
          sale_id
        ) values (
          'SALE',
          v_unit.id,
          v_movement.id,
          'AVAILABLE',
          'SOLD',
          v_condition,
          v_condition,
          v_before_unit_revision,
          v_before_unit_revision + 1,
          v_sale.id
        )
        returning * into v_lifecycle_effect;

        perform public.procurement_audit(
          v_actor,
          'SALE_SERIALIZED_INVENTORY_EFFECT_RECORDED',
          'SERIALIZED_UNIT_LIFECYCLE_EFFECT',
          v_lifecycle_effect.id,
          null,
          pg_catalog.to_jsonb(v_lifecycle_effect),
          pg_catalog.jsonb_build_object(
            'sale_id', v_sale.id,
            'sale_line_id', v_sale_line.id,
            'inventory_movement_id', v_movement.id
          )
        );
      end loop;
    else
      select b.*
        into v_bucket
      from public.stock_buckets b
      where b.serialized = false
        and b.product_id = v_product_id
        and b.variant_id is not distinct from v_variant_id
        and b.condition = v_condition;

      if not found or v_bucket.quantity < v_quantity then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0001';
      end if;

      v_line_cogs := (v_bucket.weighted_average_cost * v_quantity)::numeric(14,2);

      insert into public.sale_lines (
        sale_id,
        line_number,
        product_id,
        variant_id,
        condition,
        product_name_snapshot,
        variant_label_snapshot,
        tracking_mode_snapshot,
        quantity,
        gross_unit_price,
        gross_subtotal,
        allocated_discount,
        net_revenue,
        nonserialized_wac_snapshot,
        total_cogs_snapshot
      ) values (
        v_sale.id,
        v_line_number,
        v_product_id,
        v_variant_id,
        v_condition,
        v_product.name,
        case when v_variant_id is null then null else v_variant.label end,
        false,
        v_quantity,
        v_gross_unit_price,
        v_line_gross,
        v_allocated_discount,
        (v_line_gross - v_allocated_discount)::numeric(14,2),
        v_bucket.weighted_average_cost,
        v_line_cogs
      )
      returning * into v_sale_line;

      v_before_quantity := v_bucket.quantity;
      v_before_wac := v_bucket.weighted_average_cost;
      v_before_revision := v_bucket.inventory_revision;

      update public.stock_buckets
      set quantity = v_before_quantity - v_quantity,
          inventory_revision = v_before_revision + 1
      where id = v_bucket.id
        and quantity = v_before_quantity
        and inventory_revision = v_before_revision
      returning * into v_bucket;

      if not found then
        raise exception 'INVENTORY_STATE_CHANGED' using errcode = 'P0001';
      end if;

      insert into public.inventory_bucket_effects (
        movement,
        stock_bucket_id,
        product_id,
        variant_id,
        condition,
        quantity_before,
        quantity_after,
        wac_before,
        wac_after,
        revision_before,
        revision_after,
        sale_id
      ) values (
        'SALE',
        v_bucket.id,
        v_product_id,
        v_variant_id,
        v_condition,
        v_before_quantity,
        v_bucket.quantity,
        v_before_wac,
        v_before_wac,
        v_before_revision,
        v_before_revision + 1,
        v_sale.id
      )
      returning * into v_bucket_effect;

      insert into public.inventory_movements (
        product_id,
        variant_id,
        stock_bucket_id,
        bucket_effect_id,
        movement,
        quantity,
        condition_before,
        condition_after,
        unit_cost,
        reference_type,
        reference_id,
        reason,
        performed_by,
        sale_id
      ) values (
        v_product_id,
        v_variant_id,
        v_bucket.id,
        v_bucket_effect.id,
        'SALE',
        -v_quantity,
        v_condition,
        v_condition,
        v_before_wac,
        'SALE',
        v_sale.id,
        'Sale checkout',
        v_actor,
        v_sale.id
      )
      returning * into v_movement;

      perform public.procurement_audit(
        v_actor,
        'SALE_BUCKET_INVENTORY_EFFECT_RECORDED',
        'INVENTORY_BUCKET_EFFECT',
        v_bucket_effect.id,
        null,
        pg_catalog.to_jsonb(v_bucket_effect),
        pg_catalog.jsonb_build_object(
          'sale_id', v_sale.id,
          'sale_line_id', v_sale_line.id,
          'inventory_movement_id', v_movement.id
        )
      );
    end if;

    v_total_cogs_written := v_total_cogs_written + v_line_cogs;
  end loop;

  if v_total_cogs_written is distinct from v_current_cogs then
    raise exception 'SALE_COGS_REVALIDATION_MISMATCH' using errcode = 'P0001';
  end if;

  for v_payment in
    select p.value
    from pg_catalog.jsonb_array_elements(v_base_snapshot -> 'payments') p(value)
  loop
    insert into public.sale_payments (
      sale_id,
      payment_kind,
      amount,
      method,
      paid_on,
      reference,
      notes,
      recorded_by
    ) values (
      v_sale.id,
      'CHECKOUT',
      (v_payment ->> 'amount')::numeric(14,2),
      upper(btrim(v_payment ->> 'method'))::public.supplier_payment_method,
      (v_payment ->> 'paid_on')::date,
      nullif(btrim(v_payment ->> 'reference'), ''),
      nullif(btrim(v_payment ->> 'notes'), ''),
      v_actor
    )
    returning * into v_payment_row;

    perform public.procurement_audit(
      v_actor,
      'SALE_CHECKOUT_PAYMENT_RECORDED',
      'SALE_PAYMENT',
      v_payment_row.id,
      null,
      pg_catalog.to_jsonb(v_payment_row),
      pg_catalog.jsonb_build_object('sale_id', v_sale.id)
    );
  end loop;

  v_result := pg_catalog.jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'sale_kind', v_sale.sale_kind::text,
    'gross_subtotal', v_sale.gross_subtotal,
    'discount_total', v_sale.discount_total,
    'final_total', v_sale.final_total,
    'active_payment_total', v_initial_payment_total,
    'outstanding_amount', case
      when v_sale.sale_kind = 'CREDIT' then v_outstanding
      else 0::numeric(14,2)
    end,
    'customer_id', v_sale.customer_id,
    'transaction_on', v_sale.transaction_on,
    'idempotent_replay', false
  );

  perform public.procurement_audit(
    v_actor,
    'SALE_FINALIZED',
    'SALE',
    v_sale.id,
    null,
    pg_catalog.jsonb_build_object(
      'sale_id', v_sale.id,
      'sale_number', v_sale.sale_number,
      'sale_kind', v_sale.sale_kind,
      'customer_id', v_sale.customer_id,
      'transaction_on', v_sale.transaction_on,
      'gross_subtotal', v_sale.gross_subtotal,
      'discount_total', v_sale.discount_total,
      'final_total', v_sale.final_total,
      'payment_total', v_initial_payment_total,
      'outstanding_amount', case
        when v_sale.sale_kind = 'CREDIT' then v_outstanding
        else 0::numeric(14,2)
      end
    ),
    pg_catalog.jsonb_build_object(
      'request_id', p_request_id,
      'discount_request_id', p_discount_request_id,
      'credit_request_id', p_credit_request_id
    )
  );

  perform public.sales_complete(
    p_request_id,
    'CHECKOUT_FINALIZATION',
    v_intent_fingerprint,
    v_actor,
    'SALE',
    v_sale.id,
    v_result
  );

  return v_result;
end
$$;

revoke all on function public.sales_finalize_checkout(
  uuid,
  public.sale_kind,
  uuid,
  date,
  text,
  jsonb,
  jsonb,
  uuid,
  numeric,
  uuid
) from public, anon, authenticated;

grant execute on function public.sales_finalize_checkout(
  uuid,
  public.sale_kind,
  uuid,
  date,
  text,
  jsonb,
  jsonb,
  uuid,
  numeric,
  uuid
) to authenticated;
