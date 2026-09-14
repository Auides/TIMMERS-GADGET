-- Phase 6 Migration 3 live behavioral verification.
-- All fixture rows are unique to this run and are discarded by the final ROLLBACK.

BEGIN;

create temporary table _m3_behavior_results (
  section text not null,
  check_name text not null,
  status text not null check (status in ('PASS', 'FAIL', 'INFO')),
  detail jsonb not null default '{}'::jsonb
) on commit drop;

do $$
declare
  v_admin uuid;
  v_tag text := 'M3BV-' || upper(replace(gen_random_uuid()::text, '-', ''));
  v_supplier public.suppliers;
  v_archived_supplier public.suppliers;
  v_historical_supplier public.suppliers;
  v_purchase jsonb;
  v_purchase_id uuid;
  v_hist_purchase jsonb;
  v_hist_purchase_id uuid;
  v_non_product uuid;
  v_non_variant uuid;
  v_serial_product uuid;
  v_non_item_1 uuid;
  v_serial_item uuid;
  v_serial_unit_1 uuid;
  v_serial_unit_2 uuid;
  v_payment_1 jsonb;
  v_payment_2 jsonb;
  v_payment_full jsonb;
  v_hist_payment jsonb;
  v_return_1 jsonb;
  v_return_2 jsonb;
  v_return_1_id uuid;
  v_return_2_id uuid;
  v_refund_1 jsonb;
  v_refund_2 jsonb;
  v_refund_1_id uuid;
  v_refund_2_id uuid;
  v_before_count bigint;
  v_after_count bigint;
  v_bucket public.stock_buckets;
  v_bucket_before_return public.stock_buckets;
  v_effect_count bigint;
  v_status text;
  v_open_non_product uuid;
  v_open_serial_product uuid;
  v_open_serial_unit uuid;
  v_open_result jsonb;
  v_adjust_product uuid;
  v_adjust_serial_product uuid;
  v_adjust_serial_unit uuid;
  v_adjust_result jsonb;
  v_adjust_request public.inventory_adjustment_requests;
  v_reverse_product uuid;
  v_reverse_serial_product uuid;
  v_reverse_purchase jsonb;
  v_reverse_purchase_id uuid;
  v_reverse_serial_unit uuid;
  v_block_return_product uuid;
  v_block_return_purchase jsonb;
  v_block_return_id uuid;
  v_block_payment_product uuid;
  v_block_payment_purchase jsonb;
  v_block_payment_id uuid;
  v_block_bucket_product uuid;
  v_block_bucket_purchase jsonb;
  v_block_bucket_id uuid;
  v_block_serial_product uuid;
  v_block_serial_purchase jsonb;
  v_block_serial_id uuid;
  v_result jsonb;
begin
  select id into v_admin
  from public.profiles
  where is_active and role = 'ADMIN'
  order by id
  limit 1;

  if v_admin is null then
    insert into _m3_behavior_results(section, check_name, status, detail)
    values ('SAFETY', 'active ADMIN profile available', 'FAIL', jsonb_build_object('reason', 'No active ADMIN profile; no fixture mutations were attempted.'));
  else
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    insert into _m3_behavior_results values
      ('SAFETY', 'active ADMIN profile simulated without profile mutation', 'PASS', jsonb_build_object('admin_profile_id', v_admin, 'fixture_tag', v_tag));

    -- Shared isolated catalogue fixtures for supplier, purchase, return, payment,
    -- refund, and receipt-idempotency coverage.
    insert into public.products(name, sku, serialized, created_by)
    values (v_tag || ' nonserialized', v_tag || '-NON', false, v_admin)
    returning id into v_non_product;
    insert into public.product_variants(product_id, label, sku)
    values (v_non_product, 'Verifier variant', v_tag || '-VAR')
    returning id into v_non_variant;
    insert into public.products(name, sku, serialized, created_by)
    values (v_tag || ' serialized', v_tag || '-SER', true, v_admin)
    returning id into v_serial_product;

    -- A. Supplier lifecycle.
    select * into v_supplier from public.supplier_create(v_tag || ' Supplier', 'Initial', '08000000001', null, null, 'verifier fixture');
    perform public.supplier_update(v_supplier.id, v_tag || ' Supplier Updated', 'Updated', '08000000002', null, null, 'updated');
    select * into v_supplier from public.suppliers where id = v_supplier.id;
    insert into _m3_behavior_results values
      ('A_SUPPLIER_LIFECYCLE', 'ADMIN create and update active supplier', case when v_supplier.business_name = v_tag || ' Supplier Updated' and v_supplier.contact_name = 'Updated' then 'PASS' else 'FAIL' end, jsonb_build_object('supplier_id', v_supplier.id));
    select * into v_archived_supplier from public.supplier_create(v_tag || ' Archived', 'Archived', null, null, null, null);
    perform public.supplier_archive(v_archived_supplier.id);
    begin
      perform public.supplier_update(v_archived_supplier.id, v_tag || ' Illegal Rename', null, null, null, null, null);
      insert into _m3_behavior_results values ('A_SUPPLIER_LIFECYCLE', 'archived supplier business name cannot change', 'FAIL', '{}'::jsonb);
    exception when others then
      insert into _m3_behavior_results values ('A_SUPPLIER_LIFECYCLE', 'archived supplier business name cannot change', 'PASS', jsonb_build_object('sqlstate', sqlstate));
    end;
    select * into v_archived_supplier from public.supplier_update_archived_contact(v_archived_supplier.id, 'Archived Updated', '08000000003', null, null, 'contact only');
    insert into _m3_behavior_results values
      ('A_SUPPLIER_LIFECYCLE', 'archived supplier contact update allowed', case when v_archived_supplier.contact_name = 'Archived Updated' then 'PASS' else 'FAIL' end, jsonb_build_object('supplier_id', v_archived_supplier.id));
    begin
      perform public.purchase_receive(gen_random_uuid(), v_archived_supplier.id, public.procurement_lagos_today(), null, null,
        jsonb_build_array(jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 1, 'unit_cost', 1)), '[]'::jsonb);
      insert into _m3_behavior_results values ('A_SUPPLIER_LIFECYCLE', 'archived supplier rejected for new purchase', 'FAIL', '{}'::jsonb);
    exception when others then
      insert into _m3_behavior_results values ('A_SUPPLIER_LIFECYCLE', 'archived supplier rejected for new purchase', 'PASS', jsonb_build_object('sqlstate', sqlstate));
    end;

    -- B. Mixed purchase receipt. The two nonserialized lines deliberately share
    -- one exact bucket but have different costs.
    v_purchase := public.purchase_receive(gen_random_uuid(), v_supplier.id, public.procurement_lagos_today(), v_tag || '-REF', 'mixed verifier receipt',
      jsonb_build_array(
        jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 2, 'unit_cost', 100, 'notes', 'line one'),
        jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 1, 'unit_cost', 200, 'notes', 'line two'),
        jsonb_build_object('product_id', v_serial_product, 'condition', 'NEW', 'quantity', 2, 'serialized_units', jsonb_build_array(
          jsonb_build_object('acquisition_cost', 300, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-S1'))),
          jsonb_build_object('acquisition_cost', 400, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-S2')))
        ))
      ), jsonb_build_array(jsonb_build_object('amount', 100, 'method', 'CASH', 'paid_on', public.procurement_lagos_today(), 'reference', v_tag || '-INIT')));
    v_purchase_id := (v_purchase ->> 'purchase_id')::uuid;
    select * into v_bucket from public.stock_buckets where product_id = v_non_product and variant_id = v_non_variant and condition = 'NEW';
    select id into v_non_item_1 from public.purchase_items where purchase_id = v_purchase_id and line_number = 1;
    select id into v_serial_item from public.purchase_items where purchase_id = v_purchase_id and line_number = 3;
    select id into v_serial_unit_1 from public.serialized_units where purchase_item_id = v_serial_item order by acquisition_cost limit 1;
    select id into v_serial_unit_2 from public.serialized_units where purchase_item_id = v_serial_item order by acquisition_cost desc limit 1;
    insert into _m3_behavior_results
    select 'B_MIXED_PURCHASE_RECEIPT', 'header total, snapshot, aggregate bucket WAC/revision, and separate lines',
      case when p.total = 1100 and p.supplier_name_snapshot = v_supplier.business_name and v_bucket.quantity = 3 and v_bucket.weighted_average_cost = 133.33 and v_bucket.inventory_revision = 1
                 and (select count(*) from public.purchase_items where purchase_id = v_purchase_id) = 3
                 and (select count(*) from public.inventory_bucket_effects where purchase_id = v_purchase_id and movement = 'PURCHASE') = 1 then 'PASS' else 'FAIL' end,
      jsonb_build_object('purchase_id', v_purchase_id, 'total', p.total, 'bucket_id', v_bucket.id, 'quantity', v_bucket.quantity, 'wac', v_bucket.weighted_average_cost, 'revision', v_bucket.inventory_revision)
    from public.purchases p where p.id = v_purchase_id;
    insert into _m3_behavior_results values
      ('B_MIXED_PURCHASE_RECEIPT', 'serialized units, identifiers, lifecycle effects, and initial payment persisted',
       case when (select count(*) from public.serialized_units where purchase_item_id = v_serial_item and status = 'AVAILABLE' and lifecycle_revision = 1) = 2
                   and (select count(*) from public.serialized_unit_lifecycle_effects where purchase_id = v_purchase_id and movement = 'PURCHASE' and unit_revision_before = 0 and unit_revision_after = 1) = 2
                   and (select count(*) from public.unit_identifiers i join public.serialized_units u on u.id = i.unit_id where u.purchase_item_id = v_serial_item and i.normalized_value like v_tag || '-S%') = 2
                   and (select count(*) from public.supplier_payments where purchase_id = v_purchase_id and amount = 100) = 1 then 'PASS' else 'FAIL' end,
       jsonb_build_object('purchase_id', v_purchase_id, 'serialized_item_id', v_serial_item));

    -- C/D. Receipt and payment idempotency, financial boundaries, historical archive settlement.
    select count(*) into v_before_count from public.purchases where supplier_id = v_supplier.id;
    v_result := public.purchase_receive((select r.request_id from public.procurement_operation_reservations r where r.completed_entity_id = v_purchase_id), v_supplier.id, public.procurement_lagos_today(), v_tag || '-REF', 'mixed verifier receipt',
      jsonb_build_array(
        jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 2, 'unit_cost', 100, 'notes', 'line one'),
        jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 1, 'unit_cost', 200, 'notes', 'line two'),
        jsonb_build_object('product_id', v_serial_product, 'condition', 'NEW', 'quantity', 2, 'serialized_units', jsonb_build_array(
          jsonb_build_object('acquisition_cost', 400.00, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-S2'))),
          jsonb_build_object('acquisition_cost', 300.00, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-S1')))
        ))
      ), jsonb_build_array(jsonb_build_object('amount', 100.00, 'method', 'CASH', 'paid_on', public.procurement_lagos_today(), 'reference', v_tag || '-INIT')));
    select count(*) into v_after_count from public.purchases where supplier_id = v_supplier.id;
    insert into _m3_behavior_results values ('C_IDEMPOTENCY', 'purchase receipt canonical replay is stored and nonduplicating', case when (v_result ->> 'purchase_id')::uuid = v_purchase_id and v_result ->> 'idempotent_replay' = 'false' and v_before_count = v_after_count then 'PASS' else 'FAIL' end, jsonb_build_object('replay_result', v_result));
    begin
      perform public.purchase_receive((select r.request_id from public.procurement_operation_reservations r where r.completed_entity_id = v_purchase_id), v_supplier.id, public.procurement_lagos_today(), v_tag || '-DIFFERENT', 'different', '[]'::jsonb, '[]'::jsonb);
      insert into _m3_behavior_results values ('C_IDEMPOTENCY', 'conflicting purchase request id rejected', 'FAIL', '{}'::jsonb);
    exception when others then insert into _m3_behavior_results values ('C_IDEMPOTENCY', 'conflicting purchase request id rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_payment_1 := public.supplier_record_payment(gen_random_uuid(), v_purchase_id, 200, 'CASH', public.procurement_lagos_today(), v_tag || '-PAY1', null);
    v_result := public.supplier_record_payment((select r.request_id from public.procurement_operation_reservations r where r.completed_entity_id = (v_payment_1 ->> 'supplier_payment_id')::uuid), v_purchase_id, 200.00, 'CASH', public.procurement_lagos_today(), v_tag || '-PAY1', null);
    insert into _m3_behavior_results values ('C_IDEMPOTENCY', 'numeric(14,2) payment replay is nonduplicating', case when (v_result ->> 'supplier_payment_id')::uuid = (v_payment_1 ->> 'supplier_payment_id')::uuid and (select count(*) from public.supplier_payments where purchase_id = v_purchase_id and amount = 200) = 1 then 'PASS' else 'FAIL' end, jsonb_build_object('replay_result', v_result));
    begin perform public.supplier_record_payment(gen_random_uuid(), v_purchase_id, 9999, 'CASH', public.procurement_lagos_today(), null, null); insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'overpayment rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'overpayment rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin perform public.supplier_record_payment(gen_random_uuid(), v_purchase_id, 1, 'CASH', public.procurement_lagos_today() + 1, null, null); insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'future payment date rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'future payment date rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_payment_full := public.supplier_record_payment(gen_random_uuid(), v_purchase_id, 800, 'CASH', public.procurement_lagos_today(), v_tag || '-PAYFULL', null);
    begin perform public.supplier_record_payment(gen_random_uuid(), v_purchase_id, 1, 'CASH', public.procurement_lagos_today(), null, null); insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'payment at zero remaining payable rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'payment at zero remaining payable rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    select * into v_historical_supplier from public.supplier_create(v_tag || ' Historical', null, null, null, null, null);
    v_hist_purchase := public.purchase_receive(gen_random_uuid(), v_historical_supplier.id, public.procurement_lagos_today(), null, null, jsonb_build_array(jsonb_build_object('product_id', v_non_product, 'variant_id', v_non_variant, 'condition', 'NEW', 'quantity', 1, 'unit_cost', 50)), '[]'::jsonb);
    v_hist_purchase_id := (v_hist_purchase ->> 'purchase_id')::uuid;
    perform public.supplier_archive(v_historical_supplier.id);
    v_hist_payment := public.supplier_record_payment(gen_random_uuid(), v_hist_purchase_id, 10, 'CASH', public.procurement_lagos_today(), null, null);
    insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'archived supplier historical settlement allowed', case when v_hist_payment ? 'supplier_payment_id' then 'PASS' else 'FAIL' end, jsonb_build_object('purchase_id', v_hist_purchase_id));
    perform public.supplier_reverse_payment(gen_random_uuid(), (v_hist_payment ->> 'supplier_payment_id')::uuid, 'verifier reversal');
    begin perform public.supplier_reverse_payment(gen_random_uuid(), (v_hist_payment ->> 'supplier_payment_id')::uuid, 'duplicate'); insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'duplicate payment reversal blocked', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'duplicate payment reversal blocked', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;

    -- E/F/G. Two ordered returns prove D60 allocation, then receipts/reversals.
    select * into v_bucket_before_return from public.stock_buckets where id = v_bucket.id;
    v_return_1 := public.supplier_finalize_return(gen_random_uuid(), v_purchase_id, public.procurement_lagos_today(), null, 'partial nonserialized return', jsonb_build_array(jsonb_build_object('purchase_item_id', v_non_item_1, 'quantity', 1)), '[]'::jsonb);
    v_return_1_id := (v_return_1 ->> 'supplier_return_id')::uuid;
    select * into v_bucket from public.stock_buckets where id = v_bucket.id;
    insert into _m3_behavior_results values ('E_NONSERIALIZED_RETURN', 'partial return preserves WAC and uses original line valuation/current-WAC movement',
      case when v_bucket.quantity = v_bucket_before_return.quantity - (select quantity from public.supplier_return_lines where supplier_return_id = v_return_1_id)
                 and v_bucket.weighted_average_cost = v_bucket_before_return.weighted_average_cost
                 and v_bucket.inventory_revision = v_bucket_before_return.inventory_revision + 1
                 and (select source_unit_cost from public.supplier_return_lines where supplier_return_id = v_return_1_id) = (select unit_cost from public.purchase_items where id = v_non_item_1)
                 and (select return_value from public.supplier_return_lines where supplier_return_id = v_return_1_id) = (select quantity * source_unit_cost from public.supplier_return_lines where supplier_return_id = v_return_1_id)
                 and (select quantity from public.inventory_movements where reference_type = 'SUPPLIER_RETURN_LINE' and reference_id = (select id from public.supplier_return_lines where supplier_return_id = v_return_1_id)) = -(select quantity from public.supplier_return_lines where supplier_return_id = v_return_1_id)
                 and (select unit_cost from public.inventory_movements where reference_type = 'SUPPLIER_RETURN_LINE' and reference_id = (select id from public.supplier_return_lines where supplier_return_id = v_return_1_id)) = v_bucket_before_return.weighted_average_cost
                 and exists (select 1 from public.inventory_bucket_effects e where e.supplier_return_id = v_return_1_id and e.movement = 'SUPPLIER_RETURN' and e.quantity_before = v_bucket_before_return.quantity and e.quantity_after = v_bucket.quantity and e.wac_before = v_bucket_before_return.weighted_average_cost and e.wac_after = v_bucket.weighted_average_cost and e.revision_before = v_bucket_before_return.inventory_revision and e.revision_after = v_bucket.inventory_revision) then 'PASS' else 'FAIL' end,
      jsonb_build_object('return_id', v_return_1_id, 'before_return', jsonb_build_object('bucket_quantity', v_bucket_before_return.quantity, 'wac', v_bucket_before_return.weighted_average_cost, 'revision', v_bucket_before_return.inventory_revision), 'after_return', jsonb_build_object('bucket_quantity', v_bucket.quantity, 'wac', v_bucket.weighted_average_cost, 'revision', v_bucket.inventory_revision)));
    begin perform public.supplier_finalize_return(gen_random_uuid(), v_purchase_id, public.procurement_lagos_today(), null, 'too much', jsonb_build_array(jsonb_build_object('purchase_item_id', v_non_item_1, 'quantity', 3)), '[]'::jsonb); insert into _m3_behavior_results values ('E_NONSERIALIZED_RETURN', 'return quantity above original line rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('E_NONSERIALIZED_RETURN', 'return quantity above original line rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_return_2 := public.supplier_finalize_return(gen_random_uuid(), v_purchase_id, public.procurement_lagos_today(), null, 'serialized return', jsonb_build_array(jsonb_build_object('purchase_item_id', v_serial_item, 'serialized_unit_id', v_serial_unit_1, 'quantity', 1)), '[]'::jsonb);
    v_return_2_id := (v_return_2 ->> 'supplier_return_id')::uuid;
    insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'AVAILABLE purchase-origin unit returned with acquisition valuation/lifecycle effect',
      case when (select status = 'RETURNED_TO_SUPPLIER' and lifecycle_revision = 2 from public.serialized_units where id = v_serial_unit_1)
                 and (select source_unit_cost = 300 from public.supplier_return_lines where supplier_return_id = v_return_2_id)
                 and exists (select 1 from public.serialized_unit_lifecycle_effects where supplier_return_id = v_return_2_id and movement = 'SUPPLIER_RETURN' and unit_revision_after = 2) then 'PASS' else 'FAIL' end,
      jsonb_build_object('return_id', v_return_2_id, 'unit_id', v_serial_unit_1));
    begin perform public.supplier_finalize_return(gen_random_uuid(), v_purchase_id, public.procurement_lagos_today(), null, 'duplicate serial', jsonb_build_array(jsonb_build_object('purchase_item_id', v_serial_item, 'serialized_unit_id', v_serial_unit_1, 'quantity', 1)), '[]'::jsonb); insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'second active return of same serialized unit blocked', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'second active return of same serialized unit blocked', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    insert into _m3_behavior_results values ('G_REFUND_D60', 'return_order allocation uses overpayment only after outstanding reduction',
      case when (select e.return_order = 1 and e.refund_entitlement = greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_after, 0), 0) - greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_before, 0), 0) and e.refund_status = 'REFUND_DUE' from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_1_id)
                 and (select e.return_order = 2 and e.refund_entitlement = greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_after, 0), 0) - greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_before, 0), 0) and e.refund_entitlement = 300 and e.refund_status = 'REFUND_DUE' from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_2_id) then 'PASS' else 'FAIL' end,
      jsonb_build_object('first_return_id', v_return_1_id, 'second_return_id', v_return_2_id, 'first_return_expected_entitlement', (select greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_after, 0), 0) - greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_before, 0), 0) from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_1_id), 'first_return_actual_entitlement', (select e.refund_entitlement from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_1_id), 'second_return_expected_entitlement', (select greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_after, 0), 0) - greatest(e.net_supplier_payments - greatest(e.original_total - e.cumulative_before, 0), 0) from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_2_id), 'second_return_actual_entitlement', (select e.refund_entitlement from public.supplier_return_refund_entitlements(v_purchase_id) e where e.supplier_return_id = v_return_2_id)));
    v_refund_1 := public.supplier_record_refund_receipt(gen_random_uuid(), v_return_2_id, 100, 'CASH', public.procurement_lagos_today(), v_tag || '-RR1', null);
    v_refund_1_id := (v_refund_1 ->> 'supplier_refund_receipt_id')::uuid;
    v_result := public.supplier_record_refund_receipt((select r.request_id from public.procurement_operation_reservations r where r.completed_entity_id = v_refund_1_id), v_return_2_id, 100.00, 'CASH', public.procurement_lagos_today(), v_tag || '-RR1', null);
    insert into _m3_behavior_results values ('G_REFUND_D60', 'partial receipt and numeric replay produce PARTIALLY_REFUNDED without duplication',
      case when (v_result ->> 'supplier_refund_receipt_id')::uuid = v_refund_1_id and (select refund_status = 'PARTIALLY_REFUNDED' from public.supplier_return_refund_entitlements(v_purchase_id) where supplier_return_id = v_return_2_id) then 'PASS' else 'FAIL' end, jsonb_build_object('replay_result', v_result));
    begin perform public.supplier_record_refund_receipt(gen_random_uuid(), v_return_2_id, 201, 'CASH', public.procurement_lagos_today(), null, null); insert into _m3_behavior_results values ('G_REFUND_D60', 'refund receipt above entitlement rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('G_REFUND_D60', 'refund receipt above entitlement rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_refund_2 := public.supplier_record_refund_receipt(gen_random_uuid(), v_return_2_id, 200, 'CASH', public.procurement_lagos_today(), v_tag || '-RR2', null);
    v_refund_2_id := (v_refund_2 ->> 'supplier_refund_receipt_id')::uuid;
    insert into _m3_behavior_results values ('G_REFUND_D60', 'D62 REFUNDED status reached without OVER_RECEIPTED', case when (select refund_status = 'REFUNDED' from public.supplier_return_refund_entitlements(v_purchase_id) where supplier_return_id = v_return_2_id) then 'PASS' else 'FAIL' end, jsonb_build_object('return_id', v_return_2_id));
    begin perform public.supplier_reverse_payment(gen_random_uuid(), (v_payment_full ->> 'supplier_payment_id')::uuid, 'would over-entitle active receipts'); insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'payment reversal cannot over-entitle active refund receipts', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('D_SUPPLIER_PAYMENTS', 'payment reversal cannot over-entitle active refund receipts', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin perform public.supplier_reverse_return(gen_random_uuid(), v_return_2_id, 'blocked by active receipt'); insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'active linked refund receipt blocks return reversal', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'active linked refund receipt blocks return reversal', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    perform public.supplier_reverse_refund_receipt(gen_random_uuid(), v_refund_1_id, 'verifier receipt reversal');
    insert into _m3_behavior_results values ('G_REFUND_D60', 'receipt reversal excludes receipt from active amount', case when (select refund_status = 'PARTIALLY_REFUNDED' from public.supplier_return_refund_entitlements(v_purchase_id) where supplier_return_id = v_return_2_id) then 'PASS' else 'FAIL' end, jsonb_build_object('receipt_id', v_refund_1_id));
    perform public.supplier_reverse_refund_receipt(gen_random_uuid(), v_refund_2_id, 'clear return reversal');
    perform public.supplier_reverse_return(gen_random_uuid(), v_return_2_id, 'verifier return reversal');
    insert into _m3_behavior_results values ('F_SERIALIZED_RETURN', 'serialized return reversal restores AVAILABLE and advances lifecycle',
      case when (select status = 'AVAILABLE' and lifecycle_revision = 3 from public.serialized_units where id = v_serial_unit_1)
                 and exists (select 1 from public.serialized_unit_lifecycle_effects where supplier_return_reversal_id is not null and unit_id = v_serial_unit_1 and movement = 'SUPPLIER_RETURN_REVERSAL') then 'PASS' else 'FAIL' end, jsonb_build_object('unit_id', v_serial_unit_1));

    -- H. Successful reversal plus the four independent blockers.
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' reverse non', v_tag || '-REVN', false, v_admin) returning id into v_reverse_product;
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' reverse serial', v_tag || '-REVS', true, v_admin) returning id into v_reverse_serial_product;
    v_reverse_purchase := public.purchase_receive(gen_random_uuid(), v_supplier.id, public.procurement_lagos_today(), null, null, jsonb_build_array(
      jsonb_build_object('product_id', v_reverse_product, 'condition', 'NEW', 'quantity', 1, 'unit_cost', 50),
      jsonb_build_object('product_id', v_reverse_serial_product, 'condition', 'NEW', 'quantity', 1, 'serialized_units', jsonb_build_array(jsonb_build_object('acquisition_cost', 60, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-REV-S')))))
    ), jsonb_build_array(jsonb_build_object('amount', 10, 'method', 'CASH', 'paid_on', public.procurement_lagos_today())));
    v_reverse_purchase_id := (v_reverse_purchase ->> 'purchase_id')::uuid;
    select u.id into v_reverse_serial_unit from public.serialized_units u join public.purchase_items pi on pi.id = u.purchase_item_id where pi.purchase_id = v_reverse_purchase_id;
    perform public.purchase_reverse(gen_random_uuid(), v_reverse_purchase_id, 'successful verifier reversal');
    insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'successful reversal restores bucket, links automatic payment reversals, and reverses serialized lifecycle',
      case when exists (select 1 from public.purchase_reversals where purchase_id = v_reverse_purchase_id)
                 and exists (select 1 from public.supplier_payment_reversals spr join public.supplier_payments sp on sp.id = spr.supplier_payment_id where sp.purchase_id = v_reverse_purchase_id and spr.purchase_reversal_id is not null)
                 and (select quantity = 0 and weighted_average_cost = 0 from public.stock_buckets where product_id = v_reverse_product and condition = 'NEW')
                 and (select status = 'PURCHASE_REVERSED' and lifecycle_revision = 2 from public.serialized_units where id = v_reverse_serial_unit) then 'PASS' else 'FAIL' end, jsonb_build_object('purchase_id', v_reverse_purchase_id));
    -- The principal purchase already has supplier-return history, including a reversed return.
    begin perform public.purchase_reverse(gen_random_uuid(), v_purchase_id, 'return history blocker'); insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'any supplier-return history permanently blocks purchase reversal', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'any supplier-return history permanently blocks purchase reversal', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_block_payment_purchase := public.purchase_receive(gen_random_uuid(), v_supplier.id, public.procurement_lagos_today(), null, null, jsonb_build_array(jsonb_build_object('product_id', v_reverse_product, 'condition', 'USED', 'quantity', 1, 'unit_cost', 20)), '[]'::jsonb);
    v_block_payment_id := (v_block_payment_purchase ->> 'purchase_id')::uuid;
    v_result := public.supplier_record_payment(gen_random_uuid(), v_block_payment_id, 5, 'CASH', public.procurement_lagos_today(), null, null);
    perform public.supplier_reverse_payment(gen_random_uuid(), (v_result ->> 'supplier_payment_id')::uuid, 'independent reversal');
    begin perform public.purchase_reverse(gen_random_uuid(), v_block_payment_id, 'payment reversal blocker'); insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'pre-existing independently reversed payment blocks purchase reversal', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'pre-existing independently reversed payment blocks purchase reversal', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_block_bucket_purchase := public.purchase_receive(gen_random_uuid(), v_supplier.id, public.procurement_lagos_today(), null, null, jsonb_build_array(jsonb_build_object('product_id', v_reverse_product, 'condition', 'REFURBISHED', 'quantity', 1, 'unit_cost', 20)), '[]'::jsonb);
    v_block_bucket_id := (v_block_bucket_purchase ->> 'purchase_id')::uuid;
    perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_reverse_product, null, null, 'REFURBISHED', 1, 25, 'later bucket movement');
    begin perform public.purchase_reverse(gen_random_uuid(), v_block_bucket_id, 'later bucket blocker'); insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'later nonserialized bucket movement blocks purchase reversal', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'later nonserialized bucket movement blocks purchase reversal', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' block serial', v_tag || '-BLS', true, v_admin) returning id into v_block_serial_product;
    v_block_serial_purchase := public.purchase_receive(gen_random_uuid(), v_supplier.id, public.procurement_lagos_today(), null, null, jsonb_build_array(jsonb_build_object('product_id', v_block_serial_product, 'condition', 'NEW', 'quantity', 1, 'serialized_units', jsonb_build_array(jsonb_build_object('acquisition_cost', 20, 'condition', 'NEW', 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-BLS1')))))), '[]'::jsonb);
    v_block_serial_id := (v_block_serial_purchase ->> 'purchase_id')::uuid;
    select u.id into v_serial_unit_2 from public.serialized_units u join public.purchase_items pi on pi.id = u.purchase_item_id where pi.purchase_id = v_block_serial_id;
    perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_block_serial_product, null, v_serial_unit_2, null, -1, null, 'later lifecycle movement');
    begin perform public.purchase_reverse(gen_random_uuid(), v_block_serial_id, 'later lifecycle blocker'); insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'later serialized lifecycle transition blocks purchase reversal', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('H_PURCHASE_REVERSAL', 'later serialized lifecycle transition blocks purchase reversal', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;

    -- I/J/K. Recreated Phase 5 opening-stock, adjustment, and trigger rules.
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' opening non', v_tag || '-OPN', false, v_admin) returning id into v_open_non_product;
    v_open_result := public.inventory_record_opening_stock(gen_random_uuid(), 'verifier opening non', jsonb_build_array(jsonb_build_object('product_id', v_open_non_product, 'condition', 'NEW', 'quantity', 2, 'acquisition_cost', 30)));
    select * into v_bucket from public.stock_buckets where product_id = v_open_non_product and condition = 'NEW';
    insert into _m3_behavior_results values ('I_OPENING_STOCK_REVISION', 'nonserialized opening stock advances revision and writes effect/movement link',
      case when v_bucket.quantity = 2 and v_bucket.inventory_revision = 1
                 and exists (select 1 from public.inventory_bucket_effects where opening_stock_batch_id = (v_open_result ->> 'opening_stock_batch_id')::uuid)
                 and exists (select 1 from public.inventory_movements m join public.opening_stock_lines l on l.id = m.reference_id where l.batch_id = (v_open_result ->> 'opening_stock_batch_id')::uuid and m.bucket_effect_id is not null) then 'PASS' else 'FAIL' end, jsonb_build_object('batch_id', v_open_result ->> 'opening_stock_batch_id'));
    select count(*) into v_before_count from public.inventory_bucket_effects where opening_stock_batch_id = (v_open_result ->> 'opening_stock_batch_id')::uuid;
    perform public.inventory_record_opening_stock((select request_id from public.opening_stock_batches where id = (v_open_result ->> 'opening_stock_batch_id')::uuid), 'verifier opening non', jsonb_build_array(jsonb_build_object('product_id', v_open_non_product, 'condition', 'NEW', 'quantity', 2, 'acquisition_cost', 30)));
    select count(*) into v_after_count from public.inventory_bucket_effects where opening_stock_batch_id = (v_open_result ->> 'opening_stock_batch_id')::uuid;
    insert into _m3_behavior_results values ('I_OPENING_STOCK_REVISION', 'opening stock replay is nonduplicating', case when v_before_count = v_after_count then 'PASS' else 'FAIL' end, jsonb_build_object('effects_before', v_before_count, 'effects_after', v_after_count));
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' opening serial', v_tag || '-OPS', true, v_admin) returning id into v_open_serial_product;
    v_result := public.inventory_record_opening_stock(gen_random_uuid(), 'verifier opening serial', jsonb_build_array(jsonb_build_object('product_id', v_open_serial_product, 'condition', 'NEW', 'quantity', 1, 'acquisition_cost', 40, 'identifiers', jsonb_build_array(jsonb_build_object('type', 'SERIAL', 'value', v_tag || '-OPS1')))));
    select u.id into v_open_serial_unit from public.serialized_units u join public.opening_stock_lines l on l.id = u.opening_stock_line_id where l.batch_id = (v_result ->> 'opening_stock_batch_id')::uuid;
    insert into _m3_behavior_results values ('I_OPENING_STOCK_REVISION', 'serialized opening stock creates AVAILABLE unit at lifecycle revision 1 with effect', case when (select lifecycle_revision = 1 and status = 'AVAILABLE' from public.serialized_units where id = v_open_serial_unit) and exists (select 1 from public.serialized_unit_lifecycle_effects where unit_id = v_open_serial_unit and movement = 'OPENING_STOCK' and unit_revision_before = 0 and unit_revision_after = 1) then 'PASS' else 'FAIL' end, jsonb_build_object('unit_id', v_open_serial_unit));
    insert into public.products(name, sku, serialized, created_by) values (v_tag || ' adjustment non', v_tag || '-ADN', false, v_admin) returning id into v_adjust_product;
    v_adjust_result := public.inventory_execute_adjustment(gen_random_uuid(), null, v_adjust_product, null, null, 'NEW', 2, 10, 'positive verifier adjustment');
    select * into v_bucket from public.stock_buckets where product_id = v_adjust_product and condition = 'NEW';
    perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_adjust_product, null, null, 'NEW', -2, null, 'zero verifier adjustment');
    insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'positive then negative nonserialized adjustments advance revisions and retain WAC at zero',
      case when v_bucket.inventory_revision = 1 and v_bucket.weighted_average_cost = 10
                 and (select quantity = 0 and weighted_average_cost = 10 and inventory_revision = 2 from public.stock_buckets where id = v_bucket.id)
                 and exists (select 1 from public.inventory_movements where reference_id = (v_adjust_result ->> 'adjustment_execution_id')::uuid and bucket_effect_id is not null) then 'PASS' else 'FAIL' end, jsonb_build_object('bucket_id', v_bucket.id));
    begin perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_adjust_product, null, null, 'NEW', -1, null, 'negative inventory'); insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'negative adjustment cannot create negative inventory', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'negative adjustment cannot create negative inventory', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_open_serial_product, null, v_open_serial_unit, 'NEW', -1, null, 'serialized condition must be null'); insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'serialized direct adjustment rejects non-null condition', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'serialized direct adjustment rejects non-null condition', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    v_adjust_result := public.inventory_execute_adjustment(gen_random_uuid(), null, v_open_serial_product, null, v_open_serial_unit, null, -1, null, 'serialized adjustment out');
    v_result := public.inventory_execute_adjustment((select request_id from public.inventory_adjustment_reservations where execution_id = (v_adjust_result ->> 'adjustment_execution_id')::uuid), null, v_open_serial_product, null, v_open_serial_unit, null, -1, null, 'serialized adjustment out');
    insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'AVAILABLE serialized unit adjusts out with lifecycle effect and idempotent replay',
      case when v_result ->> 'idempotent_replay' = 'true'
                 and (select status = 'ADJUSTED_OUT' and lifecycle_revision = 2 from public.serialized_units where id = v_open_serial_unit)
                 and exists (select 1 from public.serialized_unit_lifecycle_effects where unit_id = v_open_serial_unit and movement = 'ADJUSTMENT' and unit_revision_after = 2) then 'PASS' else 'FAIL' end,
      jsonb_build_object('unit_id', v_open_serial_unit, 'replay_result', v_result));
    perform public.inventory_execute_adjustment(gen_random_uuid(), null, v_adjust_product, null, null, 'NEW', 1, 10, 'stock for open adjustment request');
    select * into v_adjust_request from public.inventory_submit_adjustment_request(v_adjust_product, null, null, 'NEW', -1, 'resolve exactly once');
    v_result := public.inventory_execute_adjustment(gen_random_uuid(), v_adjust_request.id, null, null, null, null, null, null, null);
    insert into _m3_behavior_results values ('J_ADJUSTMENT_REVISION', 'linked OPEN adjustment request resolves exactly once',
      case when (select status = 'RESOLVED' from public.inventory_adjustment_requests where id = v_adjust_request.id)
                 and (v_result ->> 'adjustment_execution_id') is not null then 'PASS' else 'FAIL' end,
      jsonb_build_object('adjustment_request_id', v_adjust_request.id, 'execution_result', v_result));
    begin update public.stock_buckets set quantity = quantity + 1 where id = v_bucket.id; insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'bucket quantity change without revision advancement rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'bucket quantity change without revision advancement rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin update public.stock_buckets set inventory_revision = inventory_revision + 2 where id = v_bucket.id; insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'invalid bucket revision jump rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'invalid bucket revision jump rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin update public.serialized_units set status = 'SOLD' where id = v_serial_unit_2; insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'serialized lifecycle state change without revision advancement rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'serialized lifecycle state change without revision advancement rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    begin update public.serialized_units set lifecycle_revision = lifecycle_revision + 2 where id = v_serial_unit_2; insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'invalid serialized lifecycle revision jump rejected', 'FAIL', '{}'::jsonb); exception when others then insert into _m3_behavior_results values ('K_REVISION_TRIGGERS', 'invalid serialized lifecycle revision jump rejected', 'PASS', jsonb_build_object('sqlstate', sqlstate)); end;
    insert into _m3_behavior_results values ('L_ROLLBACK_SAFETY', 'fixture diagnostics before rollback', 'INFO', jsonb_build_object('fixture_tag', v_tag, 'fixture_products', (select count(*) from public.products where sku like v_tag || '%'), 'fixture_suppliers', (select count(*) from public.suppliers where business_name like v_tag || '%'), 'fixture_purchases', (select count(*) from public.purchases where supplier_name_snapshot like v_tag || '%')));
  end if;
end
$$;

with checks as (
  select section, check_name, status, detail from _m3_behavior_results
), final_results as (
  select section, check_name, status, detail from checks
  union all
  select 'MIGRATION_3_LIVE_BEHAVIORAL_VERDICT', 'overall',
    case when count(*) filter (where status = 'FAIL') = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('pass_checks', count(*) filter (where status = 'PASS'), 'fail_checks', count(*) filter (where status = 'FAIL'), 'info_checks', count(*) filter (where status = 'INFO'), 'failed_checks', coalesce(jsonb_agg(jsonb_build_object('section', section, 'check_name', check_name) order by section, check_name) filter (where status = 'FAIL'), '[]'::jsonb))
  from checks
)
select section, check_name, status, detail
from final_results
order by case when section = 'MIGRATION_3_LIVE_BEHAVIORAL_VERDICT' then 2 else 1 end, section, check_name;

ROLLBACK;
