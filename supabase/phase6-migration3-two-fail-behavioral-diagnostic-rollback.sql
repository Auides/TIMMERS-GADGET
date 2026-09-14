-- Phase 6 Migration 3: isolated, rollback-only diagnosis of the two failed
-- behavioral-verifier assertions.  This file makes no persistent changes.

BEGIN;

create temporary table _m3_two_fail_diagnostic_results (
  section text not null,
  check_name text not null,
  status text not null check (status in ('PASS', 'FAIL', 'INFO')),
  classification text not null check (classification in ('CONFIRMED_CORRECT', 'VERIFIER_FALSE_POSITIVE', 'GENUINE_LIVE_DEFECT')),
  detail jsonb not null
) on commit drop;

do $$
declare
  v_admin uuid;
  v_tag text := 'M3TF-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_error text;

  v_e_supplier public.suppliers;
  v_e_product uuid;
  v_e_opening jsonb;
  v_e_purchase jsonb;
  v_e_purchase_id uuid;
  v_e_return jsonb;
  v_e_return_id uuid;
  v_e_bucket_before public.stock_buckets;
  v_e_bucket_after public.stock_buckets;
  v_e_item public.purchase_items;
  v_e_return_line public.supplier_return_lines;
  v_e_movement public.inventory_movements;
  v_e_effect public.inventory_bucket_effects;
  v_e_financial_before jsonb;

  v_g_supplier public.suppliers;
  v_g_product uuid;
  v_g_purchase jsonb;
  v_g_purchase_id uuid;
  v_g_item public.purchase_items;
  v_g_return_1 jsonb;
  v_g_return_2 jsonb;
  v_g_return_1_id uuid;
  v_g_return_2_id uuid;
  v_g_total numeric(14,2);
  v_g_payments numeric(14,2);
  v_g_d60_1 record;
  v_g_d60_2 record;
  v_g_expected_1 numeric(14,2);
  v_g_expected_2 numeric(14,2);
begin
  select p.id into v_admin
  from public.profiles p
  where p.is_active and p.role = 'ADMIN'
  order by p.id
  limit 1;

  if v_admin is null then
    insert into _m3_two_fail_diagnostic_results values (
      'SAFETY', 'active ADMIN profile available for isolated fixture auth context', 'FAIL', 'GENUINE_LIVE_DEFECT',
      jsonb_build_object('reason', 'No active ADMIN profile; no fixtures were created.')
    );
  else
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    begin
      -- E: establish a known exact bucket before the purchase, then return
      -- part of one explicit receipt line.  Opening stock: 2 @ 40; receipt:
      -- 3 @ 100.  Receipt WAC is therefore ((2 * 40) + (3 * 100)) / 5 = 76.
      insert into public.products(name, sku, serialized, created_by)
      values (v_tag || ' E nonserialized', v_tag || '-E-NON', false, v_admin)
      returning id into v_e_product;
      select * into v_e_supplier
      from public.supplier_create(v_tag || ' E Supplier', null, null, null, null, 'isolated D27 diagnostic');
      v_e_opening := public.inventory_record_opening_stock(
        gen_random_uuid(), 'isolated D27 opening state',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_e_product, 'condition', 'NEW', 'quantity', 2, 'acquisition_cost', 40
        ))
      );
      v_e_purchase := public.purchase_receive(
        gen_random_uuid(), v_e_supplier.id, public.procurement_lagos_today(), v_tag || '-E-PO', 'isolated D27 receipt',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_e_product, 'condition', 'NEW', 'quantity', 3, 'unit_cost', 100
        )),
        jsonb_build_array(jsonb_build_object(
          'amount', 300, 'method', 'CASH', 'paid_on', public.procurement_lagos_today(), 'reference', v_tag || '-E-PAY'
        ))
      );
      v_e_purchase_id := (v_e_purchase ->> 'purchase_id')::uuid;
      select * into v_e_bucket_before
      from public.stock_buckets sb
      where sb.product_id = v_e_product and sb.variant_id is null and sb.condition = 'NEW';
      select * into v_e_item
      from public.purchase_items pi
      where pi.purchase_id = v_e_purchase_id and pi.line_number = 1;
      select jsonb_build_object(
        'purchase_total', p.total,
        'active_net_supplier_payments', coalesce((
          select sum(sp.amount) from public.supplier_payments sp
          left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
          where sp.purchase_id = p.id and spr.id is null
        ), 0),
        'active_return_value', 0,
        'remaining_payable', p.total - coalesce((
          select sum(sp.amount) from public.supplier_payments sp
          left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
          where sp.purchase_id = p.id and spr.id is null
        ), 0)
      ) into v_e_financial_before
      from public.purchases p
      where p.id = v_e_purchase_id;

      v_e_return := public.supplier_finalize_return(
        gen_random_uuid(), v_e_purchase_id, public.procurement_lagos_today(), v_tag || '-E-RTN', 'isolated D27 partial return',
        jsonb_build_array(jsonb_build_object('purchase_item_id', v_e_item.id, 'quantity', 1)),
        '[]'::jsonb
      );
      v_e_return_id := (v_e_return ->> 'supplier_return_id')::uuid;
      select * into v_e_bucket_after from public.stock_buckets sb where sb.id = v_e_bucket_before.id;
      select * into v_e_return_line from public.supplier_return_lines srl where srl.supplier_return_id = v_e_return_id;
      select * into v_e_movement from public.inventory_movements im
      where im.reference_type = 'SUPPLIER_RETURN_LINE' and im.reference_id = v_e_return_line.id;
      select * into v_e_effect from public.inventory_bucket_effects ibe
      where ibe.supplier_return_id = v_e_return_id and ibe.movement = 'SUPPLIER_RETURN';

      insert into _m3_two_fail_diagnostic_results values (
        'E_NONSERIALIZED_RETURN', 'D27 isolated expected versus actual bucket, valuation, movement, and revision evidence',
        case when v_e_bucket_after.quantity = v_e_bucket_before.quantity - v_e_return_line.quantity
                    and v_e_bucket_after.weighted_average_cost = v_e_bucket_before.weighted_average_cost
                    and v_e_return_line.source_unit_cost = v_e_item.unit_cost
                    and v_e_return_line.return_value = v_e_return_line.quantity * v_e_item.unit_cost
                    and v_e_movement.quantity = -v_e_return_line.quantity
                    and v_e_movement.unit_cost = v_e_bucket_before.weighted_average_cost
                    and v_e_effect.quantity_before = v_e_bucket_before.quantity
                    and v_e_effect.quantity_after = v_e_bucket_after.quantity
                    and v_e_effect.wac_before = v_e_bucket_before.weighted_average_cost
                    and v_e_effect.wac_after = v_e_bucket_after.weighted_average_cost
                    and v_e_bucket_after.inventory_revision = v_e_bucket_before.inventory_revision + 1
                    and v_e_effect.revision_before = v_e_bucket_before.inventory_revision
                    and v_e_effect.revision_after = v_e_bucket_after.inventory_revision
             then 'PASS' else 'FAIL' end,
        case when v_e_bucket_after.quantity = v_e_bucket_before.quantity - v_e_return_line.quantity
                    and v_e_bucket_after.weighted_average_cost = v_e_bucket_before.weighted_average_cost
                    and v_e_return_line.source_unit_cost = v_e_item.unit_cost
                    and v_e_movement.unit_cost = v_e_bucket_before.weighted_average_cost
                    and v_e_bucket_after.inventory_revision = v_e_bucket_before.inventory_revision + 1
             then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end,
        jsonb_build_object(
          'before', jsonb_build_object('bucket_quantity', v_e_bucket_before.quantity, 'bucket_wac', v_e_bucket_before.weighted_average_cost, 'bucket_revision', v_e_bucket_before.inventory_revision, 'purchase_line_quantity', v_e_item.quantity, 'purchase_line_unit_cost', v_e_item.unit_cost, 'supplier_payment_and_purchase_financial_state', v_e_financial_before),
          'expected', jsonb_build_object('bucket_quantity', v_e_bucket_before.quantity - 1, 'bucket_wac', v_e_bucket_before.weighted_average_cost, 'bucket_revision', v_e_bucket_before.inventory_revision + 1, 'return_line_quantity', 1, 'return_line_source_unit_cost', v_e_item.unit_cost, 'return_value', v_e_item.unit_cost, 'movement_quantity', -1, 'movement_unit_cost', v_e_bucket_before.weighted_average_cost),
          'actual', jsonb_build_object('bucket_quantity', v_e_bucket_after.quantity, 'bucket_wac', v_e_bucket_after.weighted_average_cost, 'bucket_revision', v_e_bucket_after.inventory_revision, 'return_line_quantity', v_e_return_line.quantity, 'return_line_source_unit_cost', v_e_return_line.source_unit_cost, 'return_value', v_e_return_line.return_value, 'movement_quantity', v_e_movement.quantity, 'movement_unit_cost', v_e_movement.unit_cost, 'effect_quantity_before', v_e_effect.quantity_before, 'effect_quantity_after', v_e_effect.quantity_after, 'effect_wac_before', v_e_effect.wac_before, 'effect_wac_after', v_e_effect.wac_after, 'effect_revision_before', v_e_effect.revision_before, 'effect_revision_after', v_e_effect.revision_after),
          'return_id', v_e_return_id
        )
      );

      -- G: total 1,000, payment 600, returns 300 then 400.  The first
      -- return only reduces payable; the second creates a 300 refund due.
      insert into public.products(name, sku, serialized, created_by)
      values (v_tag || ' G nonserialized', v_tag || '-G-NON', false, v_admin)
      returning id into v_g_product;
      select * into v_g_supplier
      from public.supplier_create(v_tag || ' G Supplier', null, null, null, null, 'isolated D60 diagnostic');
      v_g_purchase := public.purchase_receive(
        gen_random_uuid(), v_g_supplier.id, public.procurement_lagos_today(), v_tag || '-G-PO', 'isolated D60 receipt',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_g_product, 'condition', 'NEW', 'quantity', 10, 'unit_cost', 100
        )),
        jsonb_build_array(jsonb_build_object(
          'amount', 600, 'method', 'CASH', 'paid_on', public.procurement_lagos_today(), 'reference', v_tag || '-G-PAY'
        ))
      );
      v_g_purchase_id := (v_g_purchase ->> 'purchase_id')::uuid;
      select * into v_g_item from public.purchase_items pi where pi.purchase_id = v_g_purchase_id and pi.line_number = 1;
      v_g_return_1 := public.supplier_finalize_return(
        gen_random_uuid(), v_g_purchase_id, public.procurement_lagos_today(), v_tag || '-G-R1', 'isolated D60 first return',
        jsonb_build_array(jsonb_build_object('purchase_item_id', v_g_item.id, 'quantity', 3)), '[]'::jsonb
      );
      v_g_return_1_id := (v_g_return_1 ->> 'supplier_return_id')::uuid;
      v_g_return_2 := public.supplier_finalize_return(
        gen_random_uuid(), v_g_purchase_id, public.procurement_lagos_today(), v_tag || '-G-R2', 'isolated D60 second return',
        jsonb_build_array(jsonb_build_object('purchase_item_id', v_g_item.id, 'quantity', 4)), '[]'::jsonb
      );
      v_g_return_2_id := (v_g_return_2 ->> 'supplier_return_id')::uuid;
      select p.total into v_g_total from public.purchases p where p.id = v_g_purchase_id;
      select coalesce(sum(sp.amount), 0)::numeric(14,2) into v_g_payments
      from public.supplier_payments sp
      left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
      where sp.purchase_id = v_g_purchase_id and spr.id is null;
      select * into v_g_d60_1 from public.supplier_return_refund_entitlements(v_g_purchase_id) e where e.supplier_return_id = v_g_return_1_id;
      select * into v_g_d60_2 from public.supplier_return_refund_entitlements(v_g_purchase_id) e where e.supplier_return_id = v_g_return_2_id;
      v_g_expected_1 := greatest(v_g_payments - greatest(v_g_total - v_g_d60_1.cumulative_after, 0), 0)
        - greatest(v_g_payments - greatest(v_g_total - v_g_d60_1.cumulative_before, 0), 0);
      v_g_expected_2 := greatest(v_g_payments - greatest(v_g_total - v_g_d60_2.cumulative_after, 0), 0)
        - greatest(v_g_payments - greatest(v_g_total - v_g_d60_2.cumulative_before, 0), 0);

      insert into _m3_two_fail_diagnostic_results values (
        'G_REFUND_D60', 'D60 first return reduces payable before any refund becomes due',
        case when v_g_d60_1.return_order = 1
                    and v_g_d60_1.original_total = v_g_total
                    and v_g_d60_1.net_supplier_payments = v_g_payments
                    and v_g_d60_1.refund_entitlement = v_g_expected_1
                    and v_g_d60_1.refund_entitlement = 0
                    and v_g_d60_1.active_refund_receipts = 0
                    and v_g_d60_1.remaining_refund_due = 0
                    and v_g_d60_1.refund_status = 'NO_REFUND_DUE'
             then 'PASS' else 'FAIL' end,
        case when v_g_d60_1.return_order = 1 and v_g_d60_1.refund_entitlement = v_g_expected_1 then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end,
        jsonb_build_object(
          'purchase_total', v_g_total, 'active_net_supplier_payments', v_g_payments,
          'return_order', v_g_d60_1.return_order, 'cumulative_active_return_before', v_g_d60_1.cumulative_before,
          'return_value', v_g_d60_1.cumulative_after - v_g_d60_1.cumulative_before,
          'outstanding_payable_before_return', v_g_total - v_g_d60_1.cumulative_before,
          'expected_incremental_refund_entitlement', v_g_expected_1,
          'actual_refund_entitlement', v_g_d60_1.refund_entitlement,
          'active_refund_receipts', v_g_d60_1.active_refund_receipts,
          'remaining_refund_due', v_g_d60_1.remaining_refund_due,
          'refund_status', v_g_d60_1.refund_status,
          'formula', 'max(payments - max(total - cumulative_after, 0), 0) - max(payments - max(total - cumulative_before, 0), 0)'
        )
      );
      insert into _m3_two_fail_diagnostic_results values (
        'G_REFUND_D60', 'D60 second return allocates only post-obligation overpayment in immutable return_order',
        case when v_g_d60_2.return_order = 2
                    and v_g_d60_2.original_total = v_g_total
                    and v_g_d60_2.net_supplier_payments = v_g_payments
                    and v_g_d60_2.refund_entitlement = v_g_expected_2
                    and v_g_d60_2.refund_entitlement = 300
                    and v_g_d60_2.active_refund_receipts = 0
                    and v_g_d60_2.remaining_refund_due = 300
                    and v_g_d60_2.refund_status = 'REFUND_DUE'
             then 'PASS' else 'FAIL' end,
        case when v_g_d60_2.return_order = 2 and v_g_d60_2.refund_entitlement = v_g_expected_2 then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end,
        jsonb_build_object(
          'purchase_total', v_g_total, 'active_net_supplier_payments', v_g_payments,
          'return_order', v_g_d60_2.return_order, 'cumulative_active_return_before', v_g_d60_2.cumulative_before,
          'return_value', v_g_d60_2.cumulative_after - v_g_d60_2.cumulative_before,
          'outstanding_payable_before_return', v_g_total - v_g_d60_2.cumulative_before,
          'expected_incremental_refund_entitlement', v_g_expected_2,
          'actual_refund_entitlement', v_g_d60_2.refund_entitlement,
          'active_refund_receipts', v_g_d60_2.active_refund_receipts,
          'remaining_refund_due', v_g_d60_2.remaining_refund_due,
          'refund_status', v_g_d60_2.refund_status,
          'formula', 'max(payments - max(total - cumulative_after, 0), 0) - max(payments - max(total - cumulative_before, 0), 0)'
        )
      );
    exception when others then
      get stacked diagnostics v_error = message_text;
      insert into _m3_two_fail_diagnostic_results values (
        'DIAGNOSTIC_RUNTIME', 'isolated fixture diagnostic completed without unresolved runtime error', 'FAIL', 'GENUINE_LIVE_DEFECT',
        jsonb_build_object('sqlstate', sqlstate, 'message', v_error, 'fixture_tag', v_tag)
      );
    end;
  end if;

  -- C: the original verifier is inspected only; it is intentionally unchanged.
  insert into _m3_two_fail_diagnostic_results values (
    'C_ORIGINAL_VERIFIER_COMPARISON', 'E_NONSERIALIZED_RETURN original assertion omitted its own same-bucket historical receipt', 'INFO', 'VERIFIER_FALSE_POSITIVE',
    jsonb_build_object(
      'original_fixture', jsonb_build_object('mixed_receipt_bucket_after', jsonb_build_object('quantity', 3, 'wac', 133.33), 'historical_receipt_before_return', jsonb_build_object('same_product_variant_condition_quantity', 1, 'unit_cost', 50)),
      'original_assertion', 'bucket.quantity = 2 AND bucket.weighted_average_cost = 133.33 AND source_unit_cost = 100 AND movement.unit_cost = 133.33',
      'approved_D27_expectation', 'Return subtracts from the current exact bucket, preserves its current WAC, values the return at original purchase-line cost, and snapshots current bucket WAC on the movement.',
      'reason_failed', 'The historical receipt changes the shared bucket from quantity 3/WAC 133.33 to quantity 4/WAC 112.50 before the return. The partial return therefore correctly yields quantity 3/WAC 112.50, not quantity 2/WAC 133.33.'
    )
  );
  insert into _m3_two_fail_diagnostic_results values (
    'C_ORIGINAL_VERIFIER_COMPARISON', 'G_REFUND_D60 original first-return expectation conflicts with D60 after full payment', 'INFO', 'VERIFIER_FALSE_POSITIVE',
    jsonb_build_object(
      'original_fixture', jsonb_build_object('purchase_total', 1100, 'net_supplier_payments', 1100, 'first_return_value', 100, 'second_return_value', 300),
      'original_assertion', 'first return NO_REFUND_DUE AND second return refund_entitlement = 300 / REFUND_DUE',
      'approved_D60_expectation', 'Each return first reduces the purchase obligation; any resulting payment excess is that return''s incremental refund entitlement in return_order.',
      'reason_failed', 'After the first 100 return, payments 1100 exceed the post-return obligation 1000 by 100, so the first entitlement is 100 (not NO_REFUND_DUE). The second return then incrementally entitles 300.'
    )
  );
end
$$;

with verdict as (
  select case when exists (select 1 from _m3_two_fail_diagnostic_results where status = 'FAIL') then 'FAIL' else 'PASS' end as status
), all_results as (
  select 1 as sort_order, r.section, r.check_name, r.status, r.classification, r.detail
  from _m3_two_fail_diagnostic_results r
  union all
  select 2, 'VERDICT', 'TWO_FAIL_BEHAVIORAL_DIAGNOSTIC_VERDICT', v.status,
    case when v.status = 'PASS' then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end,
    jsonb_build_object('failure_count', (select count(*) from _m3_two_fail_diagnostic_results where status = 'FAIL'))
  from verdict v
)
select section, check_name, status, classification, detail
from all_results
order by sort_order, section, check_name;

ROLLBACK;
