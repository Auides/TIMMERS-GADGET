-- TIMMERS GADGET Phase 6 legacy-data preflight.
-- READ-ONLY: this script contains one final SELECT result set only.

with
schema_columns as (
  select coalesce(jsonb_agg(jsonb_build_object('table_name', table_name, 'ordinal_position', ordinal_position, 'column_name', column_name, 'data_type', data_type, 'udt_name', udt_name, 'is_nullable', is_nullable) order by table_name, ordinal_position), '[]'::jsonb) as rows
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('suppliers', 'purchases', 'purchase_items', 'products', 'serialized_units', 'opening_stock_lines', 'inventory_movements', 'stock_buckets')
),
row_counts as (
  select
    (select count(*) from public.suppliers) as suppliers,
    (select count(*) from public.purchases) as purchases,
    (select count(*) from public.purchase_items) as purchase_items,
    (select count(*) from public.serialized_units) as serialized_units,
    (select count(*) from public.serialized_units where purchase_item_id is not null) as serialized_purchase_origin_units,
    (select count(*) from public.serialized_units where opening_stock_line_id is not null) as serialized_opening_stock_origin_units,
    (select count(distinct supplier_id) from public.purchases) as suppliers_referenced_by_purchases,
    (select count(*) from public.inventory_movements) as inventory_movements,
    (select count(*) from public.stock_buckets) as stock_buckets,
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'suppliers' and column_name in ('active', 'is_active', 'status')) as supplier_state_field_exists,
    coalesce((select jsonb_agg(column_name order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'suppliers' and column_name in ('active', 'is_active', 'status')), '[]'::jsonb) as supplier_state_fields
),
nonzero_amount_paid_rows as (
  select p.id as purchase_id, p.reference, p.purchased_on, p.total, p.amount_paid
  from public.purchases p
  where p.amount_paid <> 0
),
nonzero_amount_paid_summary as (
  select count(*) as affected_count,
    coalesce(jsonb_agg(jsonb_build_object('purchase_id', purchase_id, 'reference', reference, 'purchased_on', purchased_on, 'total', total, 'amount_paid', amount_paid) order by purchased_on, purchase_id), '[]'::jsonb) as rows
  from nonzero_amount_paid_rows
),
purchase_item_units as (
  select pi.id as purchase_item_id, pi.purchase_id, pi.product_id, pi.variant_id, pi.quantity,
    p.serialized as product_serialized, count(su.id) as linked_serialized_unit_count,
    count(distinct su.condition) as distinct_linked_condition_count,
    min(su.condition::text) as single_linked_condition
  from public.purchase_items pi
  left join public.products p on p.id = pi.product_id
  left join public.serialized_units su on su.purchase_item_id = pi.id
  group by pi.id, pi.purchase_id, pi.product_id, pi.variant_id, pi.quantity, p.serialized
),
classified_purchase_items as (
  select *, case
    when product_serialized is false then 'NONSERIAL_NO_AUTHORITATIVE_CONDITION'
    when product_serialized is true and distinct_linked_condition_count > 1 then 'MIXED_CONDITION'
    when product_serialized is true and linked_serialized_unit_count < quantity then 'INCOMPLETE_SERIALIZED_LINKAGE'
    when product_serialized is true and linked_serialized_unit_count = quantity and distinct_linked_condition_count = 1 then 'PROVABLE_SERIALIZED_CONDITION'
    else 'NOT_PROVABLE'
  end as condition_provenance
  from purchase_item_units
),
condition_provenance_summary as (
  select count(*) as total_purchase_items,
    count(*) filter (where condition_provenance = 'PROVABLE_SERIALIZED_CONDITION') as provable_count,
    count(*) filter (where condition_provenance <> 'PROVABLE_SERIALIZED_CONDITION') as nonprovable_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'purchase_item_id', purchase_item_id, 'purchase_id', purchase_id, 'product_id', product_id,
      'variant_id', variant_id, 'quantity', quantity,
      'authoritative_product_serialized', product_serialized,
      'linked_serialized_unit_count', linked_serialized_unit_count,
      'distinct_linked_condition_count', distinct_linked_condition_count,
      'condition_provenance', condition_provenance,
      'proven_condition', case when condition_provenance = 'PROVABLE_SERIALIZED_CONDITION' then single_linked_condition else null end
    ) order by purchase_id, purchase_item_id), '[]'::jsonb) as rows
  from classified_purchase_items
),
supplier_snapshot_candidates as (
  select table_name, column_name, data_type, udt_name
  from information_schema.columns
  where table_schema = 'public' and table_name <> 'suppliers'
    and (column_name ilike '%supplier%name%' or column_name ilike '%supplier_snapshot%'
      or column_name ilike '%supplier%business%' or column_name ilike '%business%name%'
      or table_name ilike '%supplier%name%snapshot%' or table_name ilike '%purchase%snapshot%')
),
supplier_snapshot_summary as (
  select count(*) as candidate_count,
    coalesce(jsonb_agg(jsonb_build_object('table_name', table_name, 'column_name', column_name, 'data_type', data_type, 'udt_name', udt_name) order by table_name, column_name), '[]'::jsonb) as candidates
  from supplier_snapshot_candidates
),
origin_xor_rows as (
  select su.id as serialized_unit_id, su.product_id, su.variant_id, su.purchase_item_id, su.opening_stock_line_id
  from public.serialized_units su
  where not ((su.purchase_item_id is not null) <> (su.opening_stock_line_id is not null))
),
origin_xor_summary as (
  select count(*) as violation_count,
    coalesce(jsonb_agg(jsonb_build_object('serialized_unit_id', serialized_unit_id, 'product_id', product_id, 'variant_id', variant_id, 'purchase_item_id', purchase_item_id, 'opening_stock_line_id', opening_stock_line_id) order by serialized_unit_id), '[]'::jsonb) as rows
  from origin_xor_rows
),
purchase_link_counts as (
  select purchase_item_id, count(*) as linked_unit_count
  from public.serialized_units
  where purchase_item_id is not null
  group by purchase_item_id
),
purchase_origin_check as (
  select su.id as serialized_unit_id, su.product_id as unit_product_id, su.variant_id as unit_variant_id,
    su.purchase_item_id, su.opening_stock_line_id, su.acquisition_cost as unit_acquisition_cost,
    pi.purchase_id, pi.product_id as purchase_item_product_id, pi.variant_id as purchase_item_variant_id,
    pi.quantity as purchase_item_quantity, pi.unit_cost as purchase_item_unit_cost,
    coalesce(plc.linked_unit_count, 0) as linked_unit_count,
    p.serialized as authoritative_product_serialized,
    array_remove(array[
      case when not ((su.purchase_item_id is not null) <> (su.opening_stock_line_id is not null)) then 'ORIGIN_XOR_VIOLATION' end,
      case when pi.id is null then 'PURCHASE_ITEM_MISSING' end,
      case when pi.id is not null and su.product_id is distinct from pi.product_id then 'PRODUCT_MISMATCH' end,
      case when pi.id is not null and su.variant_id is distinct from pi.variant_id then 'VARIANT_MISMATCH' end,
      case when p.serialized is distinct from true then 'PRODUCT_NOT_SERIALIZED_OR_MISSING' end,
      case when pi.id is not null and su.acquisition_cost is distinct from pi.unit_cost then 'ACQUISITION_COST_MISMATCH' end,
      case when pi.id is not null and coalesce(plc.linked_unit_count, 0) > pi.quantity then 'LINKED_UNIT_COUNT_EXCEEDS_PURCHASE_ITEM_QUANTITY' end
    ]::text[], null::text) as violations
  from public.serialized_units su
  left join public.purchase_items pi on pi.id = su.purchase_item_id
  left join purchase_link_counts plc on plc.purchase_item_id = su.purchase_item_id
  left join public.products p on p.id = su.product_id
  where su.purchase_item_id is not null
),
purchase_origin_summary as (
  select count(*) as violation_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'serialized_unit_id', serialized_unit_id, 'unit_product_id', unit_product_id,
      'unit_variant_id', unit_variant_id, 'purchase_item_id', purchase_item_id,
      'purchase_id', purchase_id, 'purchase_item_product_id', purchase_item_product_id,
      'purchase_item_variant_id', purchase_item_variant_id, 'purchase_item_quantity', purchase_item_quantity,
      'linked_unit_count', linked_unit_count, 'authoritative_product_serialized', authoritative_product_serialized,
      'unit_acquisition_cost', unit_acquisition_cost, 'purchase_item_unit_cost', purchase_item_unit_cost,
      'violations', violations
    ) order by purchase_item_id, serialized_unit_id) filter (where cardinality(violations) > 0), '[]'::jsonb) as rows
  from purchase_origin_check
),
opening_line_link_counts as (
  select opening_stock_line_id, count(*) as linked_unit_count
  from public.serialized_units
  where opening_stock_line_id is not null
  group by opening_stock_line_id
),
opening_origin_check as (
  select su.id as serialized_unit_id, su.product_id as unit_product_id, su.variant_id as unit_variant_id,
    su.purchase_item_id, su.opening_stock_line_id, su.condition as unit_condition,
    su.acquisition_cost as unit_acquisition_cost, su.warranty_start as unit_warranty_start,
    su.warranty_expiry as unit_warranty_expiry, osl.product_id as opening_line_product_id,
    osl.variant_id as opening_line_variant_id, osl.serialized as opening_line_serialized,
    osl.condition as opening_line_condition, osl.quantity as opening_line_quantity,
    osl.unit_cost as opening_line_unit_cost, osl.warranty_start as opening_line_warranty_start,
    osl.warranty_expiry as opening_line_warranty_expiry,
    coalesce(ollc.linked_unit_count, 0) as linked_unit_count,
    p.serialized as authoritative_product_serialized,
    array_remove(array[
      case when not ((su.purchase_item_id is not null) <> (su.opening_stock_line_id is not null)) then 'ORIGIN_XOR_VIOLATION' end,
      case when osl.id is null then 'OPENING_STOCK_LINE_MISSING' end,
      case when osl.id is not null and su.product_id is distinct from osl.product_id then 'PRODUCT_MISMATCH' end,
      case when osl.id is not null and su.variant_id is distinct from osl.variant_id then 'VARIANT_MISMATCH' end,
      case when p.serialized is distinct from true then 'PRODUCT_NOT_SERIALIZED_OR_MISSING' end,
      case when osl.id is not null and osl.serialized is distinct from true then 'OPENING_STOCK_LINE_NOT_SERIALIZED' end,
      case when osl.id is not null and su.acquisition_cost is distinct from osl.unit_cost then 'ACQUISITION_COST_MISMATCH' end,
      case when osl.id is not null and su.condition is distinct from osl.condition then 'CONDITION_MISMATCH' end,
      case when osl.id is not null and su.warranty_start is distinct from osl.warranty_start then 'WARRANTY_START_MISMATCH' end,
      case when osl.id is not null and su.warranty_expiry is distinct from osl.warranty_expiry then 'WARRANTY_EXPIRY_MISMATCH' end,
      case when osl.id is not null and coalesce(ollc.linked_unit_count, 0) > osl.quantity then 'LINKED_UNIT_COUNT_EXCEEDS_OPENING_LINE_QUANTITY' end
    ]::text[], null::text) as violations
  from public.serialized_units su
  left join public.opening_stock_lines osl on osl.id = su.opening_stock_line_id
  left join opening_line_link_counts ollc on ollc.opening_stock_line_id = su.opening_stock_line_id
  left join public.products p on p.id = su.product_id
  where su.opening_stock_line_id is not null
),
opening_origin_summary as (
  select count(*) filter (where cardinality(violations) > 0) as violation_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'serialized_unit_id', serialized_unit_id, 'unit_product_id', unit_product_id,
      'unit_variant_id', unit_variant_id, 'opening_stock_line_id', opening_stock_line_id,
      'opening_line_product_id', opening_line_product_id, 'opening_line_variant_id', opening_line_variant_id,
      'opening_line_serialized', opening_line_serialized, 'opening_line_quantity', opening_line_quantity,
      'linked_unit_count', linked_unit_count, 'authoritative_product_serialized', authoritative_product_serialized,
      'unit_condition', unit_condition, 'opening_line_condition', opening_line_condition,
      'unit_acquisition_cost', unit_acquisition_cost, 'opening_line_unit_cost', opening_line_unit_cost,
      'unit_warranty_start', unit_warranty_start, 'opening_line_warranty_start', opening_line_warranty_start,
      'unit_warranty_expiry', unit_warranty_expiry, 'opening_line_warranty_expiry', opening_line_warranty_expiry,
      'violations', violations
    ) order by opening_stock_line_id, serialized_unit_id) filter (where cardinality(violations) > 0), '[]'::jsonb) as rows
  from opening_origin_check
),
invalid_purchase_dates as (
  select p.id as purchase_id, p.reference, p.purchased_on,
    (current_timestamp at time zone 'Africa/Lagos')::date as lagos_business_date,
    case when p.purchased_on is null then 'NULL_PURCHASE_DATE' else 'FUTURE_PURCHASE_DATE' end as issue
  from public.purchases p
  where p.purchased_on is null or p.purchased_on > (current_timestamp at time zone 'Africa/Lagos')::date
),
purchase_date_summary as (
  select count(*) as invalid_count,
    coalesce(jsonb_agg(jsonb_build_object('purchase_id', purchase_id, 'reference', reference, 'purchased_on', purchased_on, 'lagos_business_date', lagos_business_date, 'issue', issue) order by purchased_on nulls first, purchase_id), '[]'::jsonb) as rows
  from invalid_purchase_dates
),
legacy_purchase_totals as (
  select p.id as purchase_id, p.reference, p.total,
    coalesce(sum(pi.quantity * pi.unit_cost), 0)::numeric(14,2) as legacy_items_total
  from public.purchases p
  left join public.purchase_items pi on pi.purchase_id = p.id
  group by p.id, p.reference, p.total
),
purchase_total_summary as (
  select count(*) filter (where total = legacy_items_total) as exact_match_count,
    count(*) filter (where total is distinct from legacy_items_total) as mismatch_count,
    coalesce(jsonb_agg(jsonb_build_object('purchase_id', purchase_id, 'reference', reference, 'purchase_total', total, 'legacy_items_total', legacy_items_total, 'difference', total - legacy_items_total) order by purchase_id) filter (where total is distinct from legacy_items_total), '[]'::jsonb) as mismatches
  from legacy_purchase_totals
),
reference_state as (
  select count(*) filter (where reference is null) as null_references,
    count(*) filter (where reference is not null and btrim(reference) = '') as blank_or_whitespace_references,
    count(*) filter (where reference is not null and btrim(reference) <> '') as populated_references
  from public.purchases
),
reference_duplicates as (
  select reference, count(*) as occurrence_count
  from public.purchases
  where reference is not null
  group by reference
  having count(*) > 1
),
reference_summary as (
  select rs.null_references, rs.blank_or_whitespace_references, rs.populated_references,
    count(rd.reference) as duplicate_reference_count,
    coalesce(jsonb_agg(jsonb_build_object('reference', rd.reference, 'occurrence_count', rd.occurrence_count) order by rd.reference) filter (where rd.reference is not null), '[]'::jsonb) as duplicates
  from reference_state rs
  left join reference_duplicates rd on true
  group by rs.null_references, rs.blank_or_whitespace_references, rs.populated_references
),
purchase_number_columns as (
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'purchases'
    and column_name in ('purchase_number', 'internal_purchase_number', 'system_purchase_number')
),
purchase_number_summary as (
  select count(*) as existing_internal_purchase_number_column_count,
    coalesce(jsonb_agg(column_name order by column_name), '[]'::jsonb) as existing_internal_purchase_number_columns
  from purchase_number_columns
),
line_number_columns as (
  select column_name, data_type, udt_name, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'purchase_items'
    and column_name in ('id', 'purchase_id', 'created_at')
),
line_number_column_summary as (
  select coalesce(jsonb_agg(jsonb_build_object('column_name', column_name, 'data_type', data_type, 'udt_name', udt_name, 'is_nullable', is_nullable, 'column_default', column_default) order by column_name), '[]'::jsonb) as rows
  from line_number_columns
),
line_number_row_summary as (
  select count(*) as purchase_item_rows,
    count(*) filter (where id is not null and purchase_id is not null and created_at is not null) as rows_with_id_purchase_id_created_at,
    count(*) filter (where created_at is null) as rows_missing_created_at
  from public.purchase_items
)
select report_section, status, details
from (
  select 1 as sort_order, 'SCHEMA_VERIFICATION'::text as report_section, 'INFO'::text as status,
    jsonb_build_object('relevant_public_columns', sc.rows) as details
  from schema_columns sc

  union all

  select 2, 'CURRENT_ROW_COUNTS', case when rc.purchases = 0 then 'NOT_APPLICABLE' else 'INFO' end,
    jsonb_build_object('suppliers', rc.suppliers, 'purchases', rc.purchases, 'purchase_items', rc.purchase_items,
      'serialized_units', rc.serialized_units, 'serialized_purchase_origin_units', rc.serialized_purchase_origin_units,
      'serialized_opening_stock_origin_units', rc.serialized_opening_stock_origin_units,
      'suppliers_referenced_by_purchases', rc.suppliers_referenced_by_purchases,
      'inventory_movements', rc.inventory_movements, 'stock_buckets', rc.stock_buckets,
      'supplier_state_field_exists', rc.supplier_state_field_exists, 'supplier_state_fields', rc.supplier_state_fields)
  from row_counts rc

  union all

  select 3, 'NONZERO_AMOUNT_PAID', case when naps.affected_count = 0 then 'PASS' else 'BLOCKER' end,
    jsonb_build_object('affected_count', naps.affected_count, 'purchases', naps.rows,
      'rule', 'No payment method or payment date may be invented for legacy non-zero amount_paid rows.')
  from nonzero_amount_paid_summary naps

  union all

  select 4, 'PURCHASE_ITEM_CONDITION_PROVENANCE', case
      when cps.total_purchase_items = 0 then 'NOT_APPLICABLE'
      when cps.nonprovable_count > 0 then 'BLOCKER'
      else 'PASS'
    end,
    jsonb_build_object('total_purchase_items', cps.total_purchase_items, 'provable_count', cps.provable_count,
      'nonprovable_count', cps.nonprovable_count, 'purchase_items', cps.rows,
      'authoritative_tracking_mode_field', 'products.serialized')
  from condition_provenance_summary cps

  union all

  select 5, 'HISTORICAL_SUPPLIER_NAME_EVIDENCE', case
      when rc.purchases = 0 then 'NOT_APPLICABLE'
      when sss.candidate_count = 0 then 'BLOCKER'
      else 'REVIEW_REQUIRED'
    end,
    jsonb_build_object('purchase_count', rc.purchases, 'named_schema_candidate_count', sss.candidate_count,
      'named_schema_candidates', sss.candidates,
      'note', 'Current suppliers.business_name is deliberately excluded and is not historical supplier-name evidence. A candidate column is not proof of an immutable purchase-time snapshot.')
  from row_counts rc cross join supplier_snapshot_summary sss

  union all

  select 6, 'SERIALIZED_ACQUISITION_ORIGIN_XOR', case
      when rc.serialized_units = 0 then 'NOT_APPLICABLE'
      when oxs.violation_count = 0 then 'PASS'
      else 'BLOCKER'
    end,
    jsonb_build_object('serialized_unit_count', rc.serialized_units, 'violation_count', oxs.violation_count, 'violations', oxs.rows)
  from row_counts rc cross join origin_xor_summary oxs

  union all

  select 7, 'SERIALIZED_PURCHASE_ORIGIN_INTEGRITY', case
      when rc.serialized_purchase_origin_units = 0 then 'NOT_APPLICABLE'
      when pos.violation_count = 0 then 'PASS'
      else 'BLOCKER'
    end,
    jsonb_build_object('serialized_purchase_origin_unit_count', rc.serialized_purchase_origin_units,
      'violation_count', pos.violation_count, 'violations', pos.rows)
  from row_counts rc cross join purchase_origin_summary pos

  union all

  select 8, 'OPENING_STOCK_ORIGIN_INTEGRITY', case
      when rc.serialized_opening_stock_origin_units = 0 then 'NOT_APPLICABLE'
      when oos.violation_count = 0 then 'PASS'
      else 'BLOCKER'
    end,
    jsonb_build_object('serialized_opening_stock_origin_unit_count', rc.serialized_opening_stock_origin_units,
      'violation_count', oos.violation_count, 'violations', oos.rows)
  from row_counts rc cross join opening_origin_summary oos

  union all

  select 9, 'LEGACY_PURCHASE_DATES', case when pds.invalid_count = 0 then 'PASS' else 'BLOCKER' end,
    jsonb_build_object('invalid_or_future_date_count', pds.invalid_count,
      'africa_lagos_business_date', (current_timestamp at time zone 'Africa/Lagos')::date,
      'purchases', pds.rows)
  from purchase_date_summary pds

  union all

  select 10, 'LEGACY_PURCHASE_TOTAL_CONSISTENCY', case
      when rc.purchases = 0 then 'NOT_APPLICABLE'
      when pts.mismatch_count = 0 then 'PASS'
      else 'BLOCKER'
    end,
    jsonb_build_object('legacy_formula', 'SUM(purchase_items.quantity * purchase_items.unit_cost)',
      'exact_match_count', pts.exact_match_count, 'mismatch_count', pts.mismatch_count,
      'mismatches', pts.mismatches)
  from row_counts rc cross join purchase_total_summary pts

  union all

  select 11, 'PURCHASE_REFERENCE_FIELD', 'INFO',
    jsonb_build_object('null_references', rs.null_references,
      'blank_or_whitespace_references', rs.blank_or_whitespace_references,
      'populated_references', rs.populated_references,
      'duplicate_reference_count', rs.duplicate_reference_count, 'duplicates', rs.duplicates)
  from reference_summary rs

  union all

  select 12, 'PURCHASE_NUMBER_BACKFILL_FEASIBILITY', 'INFO',
    jsonb_build_object('purchase_rows_requiring_numbers', rc.purchases,
      'existing_internal_purchase_number_column_exists', pns.existing_internal_purchase_number_column_count > 0,
      'existing_internal_purchase_number_columns', pns.existing_internal_purchase_number_columns,
      'existing_reference_column_exists', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'purchases' and column_name = 'reference'
      ),
      'note', 'A new internal number must not overwrite existing supplier reference documentation.')
  from row_counts rc cross join purchase_number_summary pns

  union all

  select 13, 'LINE_NUMBER_BACKFILL_FEASIBILITY', case
      when lnrs.purchase_item_rows = 0 then 'NOT_APPLICABLE'
      when lnrs.rows_missing_created_at = 0 and lnrs.rows_with_id_purchase_id_created_at = lnrs.purchase_item_rows then 'PASS'
      else 'REVIEW_REQUIRED'
    end,
    jsonb_build_object('required_schema_columns', lncs.rows, 'purchase_item_rows', lnrs.purchase_item_rows,
      'rows_with_id_purchase_id_created_at', lnrs.rows_with_id_purchase_id_created_at,
      'rows_missing_created_at', lnrs.rows_missing_created_at,
      'deterministic_technical_order', 'row_number() over (partition by purchase_id order by created_at, id)',
      'note', 'This numbering is technical/display metadata only and does not claim historical business ordering.')
  from line_number_column_summary lncs cross join line_number_row_summary lnrs
) as report
order by sort_order;
