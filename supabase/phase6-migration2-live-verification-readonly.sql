-- Phase 6 Migration 2 live verification: SELECT-only, one compact result set.
-- No DDL, DML, RPC invocation, temporary objects, or other mutation is performed.

with
relation_catalog as (
  select c.oid, c.relname::text as relname, c.relkind::text as relkind, c.relrowsecurity, c.reloptions, c.relacl, c.relowner
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
object_requirements(report_section, check_name, expected, relname, relkind) as (
  values
    ('MIGRATION_2_CORE_OBJECTS', 'purchase_reversals exists', 'table purchase_reversals', 'purchase_reversals', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_payments exists', 'table supplier_payments', 'supplier_payments', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_payment_reversals exists', 'table supplier_payment_reversals', 'supplier_payment_reversals', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_returns exists', 'table supplier_returns', 'supplier_returns', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_return_lines exists', 'table supplier_return_lines', 'supplier_return_lines', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_return_reversals exists', 'table supplier_return_reversals', 'supplier_return_reversals', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_refund_receipts exists', 'table supplier_refund_receipts', 'supplier_refund_receipts', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_refund_receipt_reversals exists', 'table supplier_refund_receipt_reversals', 'supplier_refund_receipt_reversals', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'inventory_bucket_effects exists', 'table inventory_bucket_effects', 'inventory_bucket_effects', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'serialized_unit_lifecycle_effects exists', 'table serialized_unit_lifecycle_effects', 'serialized_unit_lifecycle_effects', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'procurement_operation_reservations exists', 'table procurement_operation_reservations', 'procurement_operation_reservations', 'r'),
    ('MIGRATION_2_CORE_OBJECTS', 'purchase_financial_summary exists', 'view purchase_financial_summary', 'purchase_financial_summary', 'v'),
    ('MIGRATION_2_CORE_OBJECTS', 'purchase_number_seq exists', 'sequence purchase_number_seq', 'purchase_number_seq', 'S'),
    ('MIGRATION_2_CORE_OBJECTS', 'supplier_return_number_seq exists', 'sequence supplier_return_number_seq', 'supplier_return_number_seq', 'S')
),
object_results as (
  select
    r.report_section,
    r.check_name,
    case when c.oid is not null then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', r.expected, 'actual_definition', coalesce(c.relkind::text, '<missing>')) as details
  from object_requirements r
  left join relation_catalog c on c.relname = r.relname and c.relkind = r.relkind
),
column_requirements(table_name, column_name, should_exist, expected_not_null) as (
  values
    ('suppliers', 'active', true, true), ('suppliers', 'archived_at', true, false), ('suppliers', 'archived_by', true, false),
    ('purchases', 'received_on', true, true), ('purchases', 'supplier_reference', true, false),
    ('purchases', 'purchase_number', true, true), ('purchases', 'supplier_name_snapshot', true, true),
    ('purchases', 'notes', true, false), ('purchases', 'amount_paid', false, null::boolean), ('purchases', 'updated_at', false, null::boolean),
    ('purchase_items', 'line_number', true, true), ('purchase_items', 'condition', true, true),
    ('purchase_items', 'unit_cost', true, false), ('purchase_items', 'notes', true, false),
    ('stock_buckets', 'inventory_revision', true, true), ('serialized_units', 'lifecycle_revision', true, true),
    ('inventory_movements', 'bucket_effect_id', true, false)
),
column_results as (
  select
    'ALTERED_COLUMNS'::text as report_section,
    format('%s.%s', r.table_name, r.column_name) as check_name,
    case when r.should_exist = (a.attname is not null)
           and (not r.should_exist or r.expected_not_null is null or a.attnotnull = r.expected_not_null)
      then 'PASS' else 'FAIL' end as status,
    jsonb_build_object(
      'expected', case when r.should_exist then format('present; not_null=%s', r.expected_not_null) else 'absent' end,
      'actual_definition', case when a.attname is null then '<absent>' else format('%s %s; not_null=%s', format_type(a.atttypid, a.atttypmod), a.attname, a.attnotnull) end
    ) as details
  from column_requirements r
  left join relation_catalog c on c.relname = r.table_name and c.relkind in ('r', 'p')
  left join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname::text = r.column_name and a.attnum > 0 and not a.attisdropped
),
index_catalog as (
  select
    t.relname::text as table_name,
    i.relname::text as index_name,
    x.indisunique,
    array_remove(array_agg(a.attname::text order by k.ordinality), null)::text[] as key_columns,
    pg_catalog.pg_get_indexdef(i.oid) as definition
  from pg_catalog.pg_index x
  join pg_catalog.pg_class t on t.oid = x.indrelid
  join pg_catalog.pg_class i on i.oid = x.indexrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  left join lateral unnest(x.indkey::smallint[]) with ordinality as k(attnum, ordinality) on true
  left join pg_catalog.pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
  where n.nspname = 'public'
  group by t.relname, i.relname, x.indisunique, i.oid
),
check_catalog as (
  select
    t.relname::text as table_name,
    con.conname,
    lower(pg_catalog.pg_get_constraintdef(con.oid, true)) as normalized_definition,
    pg_catalog.pg_get_constraintdef(con.oid, true) as definition
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class t on t.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and con.contype = 'c'
),
unique_requirements(check_name, table_name, expected_columns) as (
  values
    ('purchases unique purchase_number', 'purchases', array['purchase_number']::text[]),
    ('purchase_items unique (purchase_id, line_number)', 'purchase_items', array['purchase_id', 'line_number']::text[]),
    ('supplier_returns unique return_number', 'supplier_returns', array['return_number']::text[]),
    ('supplier_returns unique (purchase_id, return_order)', 'supplier_returns', array['purchase_id', 'return_order']::text[]),
    ('one reversal per purchase', 'purchase_reversals', array['purchase_id']::text[]),
    ('one reversal per supplier payment', 'supplier_payment_reversals', array['supplier_payment_id']::text[]),
    ('one reversal per supplier return', 'supplier_return_reversals', array['supplier_return_id']::text[]),
    ('one reversal per supplier refund receipt', 'supplier_refund_receipt_reversals', array['supplier_refund_receipt_id']::text[]),
    ('inventory_bucket_effects unique (stock_bucket_id, revision_after)', 'inventory_bucket_effects', array['stock_bucket_id', 'revision_after']::text[]),
    ('serialized_unit_lifecycle_effects unique (unit_id, unit_revision_after)', 'serialized_unit_lifecycle_effects', array['unit_id', 'unit_revision_after']::text[])
),
unique_results as (
  select
    'IMPORTANT_CONSTRAINTS_INDEXES'::text as report_section,
    r.check_name,
    case when exists (
      select 1 from index_catalog i
      where i.table_name = r.table_name and i.indisunique and i.key_columns = r.expected_columns
    ) then 'PASS' else 'FAIL' end as status,
    jsonb_build_object(
      'expected', format('UNIQUE (%s)', array_to_string(r.expected_columns, ', ')),
      'actual_definition', coalesce((
        select string_agg(i.definition, E'\n') from index_catalog i
        where i.table_name = r.table_name and i.indisunique and i.key_columns = r.expected_columns
      ), '<missing>')
    ) as details
  from unique_requirements r
),
check_results as (
  select
    'IMPORTANT_CONSTRAINTS_INDEXES'::text,
    'suppliers archive-state CHECK'::text,
    case when exists (
      select 1 from check_catalog c
      where c.table_name = 'suppliers'
        and c.normalized_definition like '%active%'
        and c.normalized_definition like '%archived_at%'
        and c.normalized_definition like '%archived_by%'
    ) then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'CHECK couples active with archived_at and archived_by', 'actual_definition', coalesce((select string_agg(definition, E'\n') from check_catalog where table_name = 'suppliers'), '<missing>'))
  union all select
    'IMPORTANT_CONSTRAINTS_INDEXES', 'supplier_return_lines serialized quantity = 1 CHECK',
    case when exists (select 1 from check_catalog c where c.table_name = 'supplier_return_lines' and c.normalized_definition like '%serialized_unit_id%' and c.normalized_definition like '%quantity = 1%') then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'serialized_unit_id IS NULL OR quantity = 1', 'actual_definition', coalesce((select string_agg(definition, E'\n') from check_catalog where table_name = 'supplier_return_lines'), '<missing>'))
  union all select
    'IMPORTANT_CONSTRAINTS_INDEXES', 'supplier_return_lines return_value arithmetic CHECK',
    case when exists (select 1 from check_catalog c where c.table_name = 'supplier_return_lines' and c.normalized_definition like '%return_value%' and c.normalized_definition like '%quantity%' and c.normalized_definition like '%source_unit_cost%') then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'return_value = quantity * source_unit_cost', 'actual_definition', coalesce((select string_agg(definition, E'\n') from check_catalog where table_name = 'supplier_return_lines'), '<missing>'))
  union all select
    'IMPORTANT_CONSTRAINTS_INDEXES', 'inventory bucket quantity-direction CHECK',
    case when exists (select 1 from check_catalog c where c.table_name = 'inventory_bucket_effects' and c.normalized_definition like '%opening_stock%' and c.normalized_definition like '%purchase_reversal%' and c.normalized_definition like '%supplier_return_reversal%' and c.normalized_definition like '%quantity_after%' and c.normalized_definition like '%quantity_before%') then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'typed quantity_after direction for opening, purchase, reversals, returns, adjustment', 'actual_definition', coalesce((select string_agg(definition, E'\n') from check_catalog where table_name = 'inventory_bucket_effects'), '<missing>'))
  union all select
    'IMPORTANT_CONSTRAINTS_INDEXES', 'supplier-return and supplier-return-reversal WAC-preservation CHECK',
    case when exists (select 1 from check_catalog c where c.table_name = 'inventory_bucket_effects' and c.normalized_definition like '%supplier_return%' and c.normalized_definition like '%wac_after = wac_before%') then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'SUPPLIER_RETURN and SUPPLIER_RETURN_REVERSAL retain WAC', 'actual_definition', coalesce((select string_agg(definition, E'\n') from check_catalog where table_name = 'inventory_bucket_effects'), '<missing>'))
),
trigger_catalog as (
  select t.tgname::text as tgname, c.relname::text as table_name, p.proname::text as function_name, t.tgenabled::text as tgenabled
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public' and not t.tgisinternal
),
trigger_requirements(trigger_name, table_name) as (
  values
    ('no_delete_suppliers', 'suppliers'), ('validate_supplier_payment_reversal', 'supplier_payment_reversals'),
    ('validate_supplier_return_line', 'supplier_return_lines'), ('validate_inventory_bucket_effect_identity', 'inventory_bucket_effects'),
    ('validate_serialized_lifecycle_effect', 'serialized_unit_lifecycle_effects'), ('immutable_purchases', 'purchases'),
    ('immutable_purchase_items', 'purchase_items'), ('immutable_purchase_reversals', 'purchase_reversals'),
    ('immutable_supplier_payments', 'supplier_payments'), ('immutable_supplier_payment_reversals', 'supplier_payment_reversals'),
    ('immutable_supplier_returns', 'supplier_returns'), ('immutable_supplier_return_lines', 'supplier_return_lines'),
    ('immutable_supplier_return_reversals', 'supplier_return_reversals'), ('immutable_supplier_refund_receipts', 'supplier_refund_receipts'),
    ('immutable_supplier_refund_receipt_reversals', 'supplier_refund_receipt_reversals'), ('immutable_inventory_bucket_effects', 'inventory_bucket_effects'),
    ('immutable_serialized_unit_lifecycle_effects', 'serialized_unit_lifecycle_effects'), ('immutable_audit_logs', 'audit_logs')
),
trigger_results as (
  select
    'TRIGGERS'::text as report_section,
    r.trigger_name as check_name,
    case when exists (select 1 from trigger_catalog t where t.tgname = r.trigger_name and t.table_name = r.table_name and t.tgenabled <> 'D') then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', format('active trigger on %s', r.table_name), 'actual_definition', coalesce((select jsonb_agg(jsonb_build_object('table', t.table_name, 'function', t.function_name, 'enabled', t.tgenabled)) from trigger_catalog t where t.tgname = r.trigger_name), '[]'::jsonb)) as details
  from trigger_requirements r
  union all
  select
    'TRIGGERS',
    'revision-enforcement triggers inactive',
    case when count(*) filter (where tgenabled <> 'D') = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'zero active triggers invoking revision-enforcement functions until Migration 3', 'actual_definition', coalesce(jsonb_agg(jsonb_build_object('trigger', tgname, 'table', table_name, 'function', function_name, 'enabled', tgenabled)) filter (where tgenabled <> 'D'), '[]'::jsonb))
  from trigger_catalog
  where function_name in ('enforce_stock_bucket_revision', 'enforce_serialized_lifecycle_revision')
),
function_requirements(function_name, security_definer_required) as (
  values
    ('validate_serialized_purchase_origin', true), ('validate_inventory_movement', true), ('validate_inventory_bucket_effect_identity', true),
    ('validate_serialized_lifecycle_effect', true), ('validate_supplier_payment_reversal', true), ('validate_supplier_return_line', true),
    ('enforce_stock_bucket_revision', false), ('enforce_serialized_lifecycle_revision', false),
    ('forbid_supplier_delete', false), ('forbid_procurement_history_mutation', false)
),
function_catalog as (
  select p.oid, p.proname::text as proname, p.prosecdef, coalesce(array_to_string(p.proconfig, E'\n'), '') as configuration, p.proacl, p.proowner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
function_results as (
  select
    'FUNCTION_SECURITY'::text as report_section,
    r.function_name as check_name,
    case when f.oid is not null
              and (not r.security_definer_required or f.prosecdef)
              and f.configuration like '%search_path=pg_catalog, pg_temp%'
              and not exists (
                select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) acl
                left join pg_catalog.pg_roles role_row on role_row.oid = acl.grantee
        where acl.privilege_type = 'EXECUTE' and (acl.grantee = 0 or role_row.rolname::text in ('anon', 'authenticated'))
              )
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object(
      'expected', format('security_definer_required=%s; search_path pg_catalog, pg_temp; no PUBLIC/anon/authenticated EXECUTE', r.security_definer_required),
      'actual_definition', coalesce(jsonb_build_object('security_definer', f.prosecdef, 'configuration', f.configuration), '{}'::jsonb)
    ) as details
  from function_requirements r
  left join function_catalog f on f.proname = r.function_name
),
phase6_tables(table_name) as (
  values ('purchase_reversals'), ('supplier_payments'), ('supplier_payment_reversals'), ('supplier_returns'), ('supplier_return_lines'),
         ('supplier_return_reversals'), ('supplier_refund_receipts'), ('supplier_refund_receipt_reversals'), ('inventory_bucket_effects'),
         ('serialized_unit_lifecycle_effects'), ('procurement_operation_reservations')
),
rls_results as (
  select
    'RLS_PRIVILEGES'::text as report_section,
    r.table_name as check_name,
    case when c.oid is not null and c.relrowsecurity and not exists (
      select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      left join pg_catalog.pg_roles role_row on role_row.oid = acl.grantee
      where acl.privilege_type in ('INSERT', 'UPDATE', 'DELETE') and (acl.grantee = 0 or role_row.rolname::text in ('anon', 'authenticated'))
    ) then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'RLS enabled; no direct browser INSERT/UPDATE/DELETE', 'actual_definition', jsonb_build_object('rls_enabled', coalesce(c.relrowsecurity, false))) as details
  from phase6_tables r
  left join relation_catalog c on c.relname = r.table_name and c.relkind = 'r'
),
policy_catalog as (
  select c.relname::text as table_name, p.polname::text as polname, p.polcmd::text as polcmd, coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') as using_expression
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
policy_requirements(table_name, policy_name) as (
  values
    ('purchase_reversals', 'management read purchase reversals'), ('supplier_payments', 'management read supplier payments'),
    ('supplier_payment_reversals', 'management read supplier payment reversals'), ('supplier_returns', 'management read supplier returns'),
    ('supplier_return_lines', 'management read supplier return lines'), ('supplier_return_reversals', 'management read supplier return reversals'),
    ('supplier_refund_receipts', 'management read supplier refund receipts'), ('supplier_refund_receipt_reversals', 'management read supplier refund receipt reversals'),
    ('inventory_bucket_effects', 'management read inventory bucket effects'), ('serialized_unit_lifecycle_effects', 'management read serialized lifecycle effects')
),
policy_results as (
  select
    'RLS_PRIVILEGES'::text as report_section,
    r.policy_name as check_name,
    case when exists (select 1 from policy_catalog p where p.table_name = r.table_name and p.polname = r.policy_name and p.polcmd = 'r') then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', format('management SELECT policy on %s', r.table_name), 'actual_definition', coalesce((select jsonb_agg(jsonb_build_object('command', p.polcmd, 'using', p.using_expression)) from policy_catalog p where p.table_name = r.table_name and p.polname = r.policy_name), '[]'::jsonb)) as details
  from policy_requirements r
  union all
  select
    'RLS_PRIVILEGES',
    'procurement_operation_reservations has no browser SELECT policy',
    case when not exists (select 1 from policy_catalog where table_name = 'procurement_operation_reservations' and polcmd in ('r', '*')) then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'no SELECT/ALL policy', 'actual_definition', coalesce((select jsonb_agg(jsonb_build_object('policy', polname, 'command', polcmd, 'using', using_expression)) from policy_catalog where table_name = 'procurement_operation_reservations'), '[]'::jsonb))
  union all
  select
    'RLS_PRIVILEGES',
    'management procurement policies do not admit STAFF',
    case when not exists (select 1 from policy_catalog where table_name in (select table_name from policy_requirements) and polcmd in ('r', '*') and (lower(using_expression) like '%staff%' or lower(trim(using_expression)) in ('true', '(true)'))) then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'no permissive STAFF management procurement SELECT policy', 'actual_definition', coalesce((select jsonb_agg(jsonb_build_object('table', table_name, 'policy', polname, 'using', using_expression)) from policy_catalog where table_name in (select table_name from policy_requirements) and polcmd in ('r', '*')), '[]'::jsonb))
),
view_catalog as (
  select
    c.oid,
    coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true'] as security_invoker,
    pg_catalog.pg_get_viewdef(c.oid, true) as raw_definition,
    lower(regexp_replace(pg_catalog.pg_get_viewdef(c.oid, true), '\s+', ' ', 'g')) as normalized_definition,
    lower(regexp_replace(pg_catalog.pg_get_viewdef(c.oid, true), '[^a-zA-Z0-9_]+', ' ', 'g')) as semantic_tokens
  from relation_catalog c
  where c.relname = 'purchase_financial_summary' and c.relkind = 'v'
),
view_results as (
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION'::text,
    'raw pg_get_viewdef diagnostic'::text,
    case when exists (select 1 from view_catalog) then 'INFO' else 'FAIL' end,
    jsonb_build_object('expected', 'raw live pg_get_viewdef is returned for diagnostic review', 'actual_definition', coalesce((select raw_definition from view_catalog), '<missing view>'))
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'purchase_state: reversal => REVERSED',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'case when pr id is null then active else reversed end as purchase_state' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'purchase reversal produces purchase_state REVERSED', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'))
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'operational_revised_payable: reversal => 0',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'case when pr id is null then .* else 0 numeric [0-9]+ [0-9]+ end as operational_revised_payable' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'reversed purchase operational_revised_payable is 0', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'), 'note', 'INFO means inspect raw pg_get_viewdef; it is not a formatting-driven failure.')
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'amount_still_payable: reversal => 0',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'case when pr id is null then .* else 0 numeric [0-9]+ [0-9]+ end as amount_still_payable' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'reversed purchase amount_still_payable is 0', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'), 'note', 'INFO means inspect raw pg_get_viewdef; it is not a formatting-driven failure.')
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'payment_status: reversal => NOT_APPLICABLE',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'case when pr id is not null then not_applicable' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'reversed purchase payment_status is NOT_APPLICABLE', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'))
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'active payments exclude reversed supplier payments',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'supplier_payment_reversals spr.*spr id is null' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'active payments CTE excludes rows with supplier_payment_reversals', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'))
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'active returns exclude reversed supplier returns',
    case when not exists (select 1 from view_catalog) then 'FAIL'
         when (select semantic_tokens ~ 'supplier_return_reversals srr.*srr id is null' from view_catalog) then 'PASS'
         else 'INFO' end,
    jsonb_build_object('expected', 'active returns CTE excludes rows with supplier_return_reversals', 'actual_definition', coalesce((select normalized_definition from view_catalog), '<missing view>'))
  union all
  select
    'PURCHASE_FINANCIAL_SUMMARY_DEFINITION', 'security_invoker = true',
    case when coalesce((select security_invoker from view_catalog), false) then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'security_invoker=true', 'actual_definition', coalesce((select security_invoker::text from view_catalog), '<missing view>'))
),
data_results as (
  select 'LEGACY_LIVE_DATA_SAFETY'::text, 'row counts'::text, 'INFO'::text,
    jsonb_build_object('actual_definition', jsonb_build_object(
      'suppliers', (select count(*) from public.suppliers), 'purchases', (select count(*) from public.purchases),
      'purchase_items', (select count(*) from public.purchase_items), 'stock_buckets', (select count(*) from public.stock_buckets),
      'serialized_units', (select count(*) from public.serialized_units), 'inventory_movements', (select count(*) from public.inventory_movements),
      'inventory_bucket_effects', (select count(*) from public.inventory_bucket_effects), 'serialized_unit_lifecycle_effects', (select count(*) from public.serialized_unit_lifecycle_effects)
    ))
  union all select 'LEGACY_LIVE_DATA_SAFETY', 'nonnegative inventory/lifecycle revisions',
    case when (select count(*) from public.stock_buckets where inventory_revision < 0) = 0 and (select count(*) from public.serialized_units where lifecycle_revision < 0) = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'no negative revision values', 'actual_definition', jsonb_build_object('negative_inventory_revisions', (select count(*) from public.stock_buckets where inventory_revision < 0), 'negative_lifecycle_revisions', (select count(*) from public.serialized_units where lifecycle_revision < 0)))
  union all select 'LEGACY_LIVE_DATA_SAFETY', 'serialized origin XOR remains valid',
    case when (select count(*) from public.serialized_units where num_nonnulls(purchase_item_id, opening_stock_line_id) <> 1) = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'exactly one purchase/opening-stock origin per serialized unit', 'actual_definition', jsonb_build_object('invalid_row_count', (select count(*) from public.serialized_units where num_nonnulls(purchase_item_id, opening_stock_line_id) <> 1)))
  union all select 'LEGACY_LIVE_DATA_SAFETY', 'inventory movements with bucket_effect_id', 'INFO',
    jsonb_build_object('expected', 'observational only; read-only SQL cannot determine intentional post-Migration-2 creation', 'actual_definition', jsonb_build_object('count', (select count(*) from public.inventory_movements where bucket_effect_id is not null)))
),
phase5_rpc_requirements(function_name) as (
  values ('inventory_record_opening_stock'), ('inventory_submit_adjustment_request'), ('inventory_reject_adjustment_request'), ('inventory_execute_adjustment')
),
phase5_results as (
  select
    'PHASE_5_COMPATIBILITY_STATE'::text,
    r.function_name,
    case when exists (select 1 from function_catalog f where f.proname = r.function_name) then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'existing Phase 5 operational RPC remains deployed', 'actual_definition', case when exists (select 1 from function_catalog f where f.proname = r.function_name) then 'present' else '<missing>' end)
  from phase5_rpc_requirements r
),
checks as (
  select * from object_results
  union all select * from column_results
  union all select * from unique_results
  union all select * from check_results
  union all select * from trigger_results
  union all select * from function_results
  union all select * from rls_results
  union all select * from policy_results
  union all select * from view_results
  union all select * from data_results
  union all select * from phase5_results
),
final_results as (
  select report_section, check_name, status, details from checks
  union all
  select
    'MIGRATION_2_LIVE_VERDICT',
    'overall',
    case
      when count(*) filter (where status = 'FAIL') > 0 then 'FAIL'
      when count(*) filter (where status = 'INFO' and check_name <> 'raw pg_get_viewdef diagnostic') > 0 then 'INFO'
      else 'PASS'
    end,
    jsonb_build_object(
      'pass_checks', count(*) filter (where status = 'PASS'),
      'fail_checks', count(*) filter (where status = 'FAIL'),
      'info_checks', count(*) filter (where status = 'INFO'),
      'failed_checks', coalesce(jsonb_agg(jsonb_build_object('section', report_section, 'check', check_name) order by report_section, check_name) filter (where status = 'FAIL'), '[]'::jsonb),
      'info_checks_requiring_review', coalesce(jsonb_agg(jsonb_build_object('section', report_section, 'check', check_name) order by report_section, check_name) filter (where status = 'INFO' and check_name <> 'raw pg_get_viewdef diagnostic'), '[]'::jsonb)
    )
  from checks
)
select report_section, check_name, status, details
from final_results
order by case when report_section = 'MIGRATION_2_LIVE_VERDICT' then 2 else 1 end, report_section, check_name;
