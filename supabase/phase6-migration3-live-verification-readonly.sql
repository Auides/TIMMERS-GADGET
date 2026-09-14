-- Phase 6 Migration 3 live structural verification: SELECT-only, one result set.
-- No DDL, DML, RPC invocation, temporary objects, or other mutation is performed.

with
function_specs(section, check_name, signature, security_definer_expected, access_kind) as (
  values
    ('ENTRY_RPC_PRESENCE', 'supplier_create', 'public.supplier_create(text,text,text,text,text,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_update', 'public.supplier_update(uuid,text,text,text,text,text,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_update_archived_contact', 'public.supplier_update_archived_contact(uuid,text,text,text,text,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_archive', 'public.supplier_archive(uuid)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'purchase_receive', 'public.purchase_receive(uuid,uuid,date,text,text,jsonb,jsonb)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_record_payment', 'public.supplier_record_payment(uuid,uuid,numeric,public.supplier_payment_method,date,text,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_finalize_return', 'public.supplier_finalize_return(uuid,uuid,date,text,text,jsonb,jsonb)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_record_refund_receipt', 'public.supplier_record_refund_receipt(uuid,uuid,numeric,public.supplier_payment_method,date,text,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'purchase_reverse', 'public.purchase_reverse(uuid,uuid,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_reverse_payment', 'public.supplier_reverse_payment(uuid,uuid,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_reverse_return', 'public.supplier_reverse_return(uuid,uuid,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'supplier_reverse_refund_receipt', 'public.supplier_reverse_refund_receipt(uuid,uuid,text)', true, 'entry'),
    ('ENTRY_RPC_PRESENCE', 'inventory_record_opening_stock', 'public.inventory_record_opening_stock(uuid,text,jsonb)', true, 'phase5_entry'),
    ('ENTRY_RPC_PRESENCE', 'inventory_execute_adjustment', 'public.inventory_execute_adjustment(uuid,uuid,uuid,uuid,uuid,public.product_condition,integer,numeric,text)', true, 'phase5_entry'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_lagos_today', 'public.procurement_lagos_today()', false, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_optional_text', 'public.procurement_optional_text(text)', false, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_fingerprint', 'public.procurement_fingerprint(jsonb)', false, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'canonical_procurement_identifiers', 'public.canonical_procurement_identifiers(jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'canonical_purchase_receive_payload', 'public.canonical_purchase_receive_payload(uuid,date,text,text,jsonb,jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'canonical_supplier_return_payload', 'public.canonical_supplier_return_payload(uuid,date,text,text,jsonb,jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'canonical_opening_stock_payload', 'public.canonical_opening_stock_payload(text,jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'require_procurement_authority', 'public.require_procurement_authority(boolean)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_reserve', 'public.procurement_reserve(uuid,public.procurement_operation_kind,text,uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_complete', 'public.procurement_complete(uuid,text,uuid,jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_audit', 'public.procurement_audit(uuid,text,text,uuid,jsonb,jsonb,jsonb)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_purchase_audit_evidence', 'public.procurement_purchase_audit_evidence(uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_supplier_return_audit_evidence', 'public.procurement_supplier_return_audit_evidence(uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_purchase_financial_evidence', 'public.procurement_purchase_financial_evidence(uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'procurement_purchase_reversal_audit_evidence', 'public.procurement_purchase_reversal_audit_evidence(uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'supplier_return_refund_entitlements', 'public.supplier_return_refund_entitlements(uuid)', true, 'internal'),
    ('INTERNAL_HELPER_PRESENCE', 'assert_purchase_refund_receipts_safe', 'public.assert_purchase_refund_receipts_safe(uuid)', true, 'internal')
),
function_catalog as (
  select
    s.*,
    p.oid,
    p.prosecdef,
    coalesce(array_to_string(p.proconfig, E'\n'), '') as configuration,
    lower(regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '\s+', ' ', 'g')) as definition
  from function_specs s
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(s.signature)
),
function_acl as (
  select
    f.oid,
    coalesce(bool_or(a.privilege_type = 'EXECUTE' and a.grantee = 0), false) as public_execute,
    coalesce(bool_or(a.privilege_type = 'EXECUTE' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'anon')), false) as anon_execute,
    coalesce(bool_or(a.privilege_type = 'EXECUTE' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'authenticated')), false) as authenticated_execute
  from function_catalog f
  left join lateral pg_catalog.aclexplode(coalesce((select p.proacl from pg_catalog.pg_proc p where p.oid = f.oid), pg_catalog.acldefault('f', (select p.proowner from pg_catalog.pg_proc p where p.oid = f.oid)))) a on true
  where f.oid is not null
  group by f.oid
),
function_presence_results as (
  select
    f.section,
    f.check_name,
    case when f.oid is not null then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected_signature', f.signature, 'actual', case when f.oid is null then '<missing>' else pg_catalog.pg_get_function_identity_arguments(f.oid) end) as detail
  from function_catalog f
),
function_security_results as (
  select
    'SECURITY_DEFINER_HARDENING'::text as section,
    f.check_name,
    case when f.oid is not null
              and f.prosecdef = f.security_definer_expected
              and f.configuration = 'search_path=pg_catalog, pg_temp'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object(
      'expected_security_definer', f.security_definer_expected,
      'expected_search_path', 'pg_catalog, pg_temp',
      'actual_security_definer', f.prosecdef,
      'actual_configuration', nullif(f.configuration, '')
    ) as detail
  from function_catalog f
),
function_privilege_results as (
  select
    case when f.access_kind = 'internal' then 'FUNCTION_EXECUTE_PRIVILEGES_INTERNAL' else 'FUNCTION_EXECUTE_PRIVILEGES_RPC' end as section,
    f.check_name,
    case when f.oid is null then 'FAIL'
         when f.access_kind = 'internal'
           and not coalesce(a.public_execute, false)
           and not coalesce(a.anon_execute, false)
           and not coalesce(a.authenticated_execute, false) then 'PASS'
         when f.access_kind in ('entry', 'phase5_entry')
           and coalesce(a.authenticated_execute, false)
           and not coalesce(a.public_execute, false)
           and not coalesce(a.anon_execute, false) then 'PASS'
         else 'FAIL' end as status,
    jsonb_build_object(
      'expected', case when f.access_kind = 'internal' then 'PUBLIC/anon/authenticated: no EXECUTE' else 'authenticated: EXECUTE; PUBLIC/anon: no EXECUTE' end,
      'actual', jsonb_build_object('public_execute', coalesce(a.public_execute, false), 'anon_execute', coalesce(a.anon_execute, false), 'authenticated_execute', coalesce(a.authenticated_execute, false))
    ) as detail
  from function_catalog f
  left join function_acl a on a.oid = f.oid
),
approved_phase5_specs(check_name, signature) as (
  values
    ('inventory_submit_adjustment_request', 'public.inventory_submit_adjustment_request(uuid,uuid,uuid,public.product_condition,integer,text)'),
    ('inventory_reject_adjustment_request', 'public.inventory_reject_adjustment_request(uuid,text)'),
    ('staff_serialized_lookup', 'public.staff_serialized_lookup(text)')
),
approved_phase5_catalog as (
  select s.check_name, s.signature, pg_catalog.to_regprocedure(s.signature) as oid
  from approved_phase5_specs s
),
approved_phase5_access_results as (
  select
    'FUNCTION_EXECUTE_PRIVILEGES_RPC'::text as section,
    s.check_name,
    case when s.oid is not null
              and pg_catalog.has_function_privilege('authenticated', s.oid, 'EXECUTE')
              and not coalesce(a.public_execute, false)
              and not coalesce(a.anon_execute, false) then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'authenticated: EXECUTE; PUBLIC/anon: no EXECUTE', 'actual', jsonb_build_object('exact_regprocedure', s.signature, 'resolved_identity', s.oid::regprocedure::text, 'present', s.oid is not null, 'public_execute', coalesce(a.public_execute, false), 'anon_execute', coalesce(a.anon_execute, false), 'authenticated_execute', case when s.oid is not null then pg_catalog.has_function_privilege('authenticated', s.oid, 'EXECUTE') else false end)) as detail
  from approved_phase5_catalog s
  left join pg_catalog.pg_proc p on p.oid = s.oid
  left join lateral (
    select
      coalesce(bool_or(x.privilege_type = 'EXECUTE' and x.grantee = 0), false) as public_execute,
      coalesce(bool_or(x.privilege_type = 'EXECUTE' and x.grantee = (select oid from pg_catalog.pg_roles where rolname = 'anon')), false) as anon_execute
    from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) x
  ) a on s.oid is not null
),
trigger_catalog as (
  select
    t.oid,
    c.relname::text as table_name,
    t.tgfoid,
    t.tgenabled,
    t.tgtype,
    array(
      select a.attname::text
      from unnest(t.tgattr::smallint[]) with ordinality k(attnum, ordinality)
      join pg_catalog.pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum
      order by k.ordinality
    ) as update_columns
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
trigger_requirements(check_name, table_name, function_signature, expected_columns) as (
  values
    ('stock bucket revision enforcement', 'stock_buckets', 'public.enforce_stock_bucket_revision()', array['quantity', 'weighted_average_cost', 'inventory_revision']::text[]),
    ('serialized lifecycle revision enforcement', 'serialized_units', 'public.enforce_serialized_lifecycle_revision()', array['status', 'condition', 'lifecycle_revision']::text[])
),
trigger_results as (
  select
    'REVISION_TRIGGERS_ACTIVE'::text as section,
    r.check_name,
    case when count(*) filter (
      where t.tgenabled <> 'D'
        and t.tgfoid = pg_catalog.to_regprocedure(r.function_signature)
        and (t.tgtype & 2) = 2
        and (t.tgtype & 16) = 16
        and t.update_columns = r.expected_columns
    ) = 1 then 'PASS' else 'FAIL' end as status,
    jsonb_build_object(
      'expected', jsonb_build_object('active_count', 1, 'table', r.table_name, 'function', r.function_signature, 'timing', 'BEFORE UPDATE', 'columns', r.expected_columns),
      'actual_active_count', count(*) filter (where t.tgenabled <> 'D' and t.tgfoid = pg_catalog.to_regprocedure(r.function_signature) and t.table_name = r.table_name),
      'actual', coalesce(jsonb_agg(jsonb_build_object('enabled', t.tgenabled, 'before', (t.tgtype & 2) = 2, 'update', (t.tgtype & 16) = 16, 'columns', t.update_columns) order by t.oid) filter (where t.oid is not null), '[]'::jsonb)
    ) as detail
  from trigger_requirements r
  left join trigger_catalog t on t.table_name = r.table_name
  group by r.check_name, r.table_name, r.function_signature, r.expected_columns
),
phase5_replacement_results as (
  select
    'PHASE_5_RPC_REPLACEMENT_STATE'::text as section,
    'inventory_record_opening_stock structural replacement'::text as check_name,
    case when f.oid is not null
              and f.definition like '%inventory_revision%'
              and f.definition like '%insert into public.inventory_bucket_effects%'
              and f.definition like '%bucket_effect_id%'
              and f.definition like '%lifecycle_revision)%'
              and f.definition ~ 'lifecycle_revision\) values\(.*,1\)'
              and f.definition like '%insert into public.serialized_unit_lifecycle_effects%'
              and f.definition like '%opening_stock_batches%'
              and f.definition ~ 'from public\.products.*for update'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'revision/effects/idempotency retained; new serialized units lifecycle_revision=1; product validation FOR UPDATE', 'actual', jsonb_build_object('inventory_revision', f.definition like '%inventory_revision%', 'bucket_effects', f.definition like '%insert into public.inventory_bucket_effects%', 'bucket_effect_id', f.definition like '%bucket_effect_id%', 'serialized_lifecycle_revision_one', f.definition ~ 'lifecycle_revision\) values\(.*,1\)', 'serialized_lifecycle_effects', f.definition like '%insert into public.serialized_unit_lifecycle_effects%', 'opening_stock_idempotency', f.definition like '%opening_stock_batches%', 'product_for_update', f.definition ~ 'from public\.products.*for update')) as detail
  from function_catalog f where f.check_name = 'inventory_record_opening_stock'
  union all
  select
    'PHASE_5_RPC_REPLACEMENT_STATE',
    'inventory_execute_adjustment structural replacement',
    case when f.oid is not null
              and f.definition like '%inventory_revision%'
              and f.definition like '%insert into public.inventory_bucket_effects%'
              and f.definition like '%bucket_effect_id%'
              and f.definition ~ 'status = .adjusted_out.*lifecycle_revision = v_unit.lifecycle_revision \+ 1'
              and f.definition like '%insert into public.serialized_unit_lifecycle_effects%'
              and f.definition like '%inventory_adjustment_reservations%'
              and f.definition ~ 'from public\.products.*for update'
         then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'revision/effects/replay retained; serialized lifecycle increment; product validation FOR UPDATE', 'actual', jsonb_build_object('inventory_revision', f.definition like '%inventory_revision%', 'bucket_effects', f.definition like '%insert into public.inventory_bucket_effects%', 'bucket_effect_id', f.definition like '%bucket_effect_id%', 'serialized_lifecycle_increment', f.definition ~ 'status = .adjusted_out.*lifecycle_revision = v_unit.lifecycle_revision \+ 1', 'serialized_lifecycle_effects', f.definition like '%insert into public.serialized_unit_lifecycle_effects%', 'adjustment_replay', f.definition like '%inventory_adjustment_reservations%', 'product_for_update', f.definition ~ 'from public\.products.*for update'))
  from function_catalog f where f.check_name = 'inventory_execute_adjustment'
),
transactional_rpc_specs(check_name) as (
  values ('purchase_receive'), ('supplier_record_payment'), ('supplier_finalize_return'), ('supplier_record_refund_receipt'),
         ('purchase_reverse'), ('supplier_reverse_payment'), ('supplier_reverse_return'), ('supplier_reverse_refund_receipt')
),
idempotency_results as (
  select
    'PROCUREMENT_IDEMPOTENCY_STRUCTURE'::text as section,
    s.check_name,
    case when f.oid is not null
              and f.definition like '%public.procurement_reserve(%'
              and f.definition like '%public.procurement_complete(%'
              and f.definition ~ 'completed_at is not null then return'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'reserve + completed-result replay + complete', 'actual', jsonb_build_object('reserve', f.definition like '%public.procurement_reserve(%', 'completed_result_replay', f.definition ~ 'completed_at is not null then return', 'complete', f.definition like '%public.procurement_complete(%')) as detail
  from transactional_rpc_specs s
  left join function_catalog f on f.check_name = s.check_name
  union all
  select
    'PROCUREMENT_IDEMPOTENCY_STRUCTURE',
    'purchase_receive canonical payload before fingerprint',
    case when f.oid is not null and f.definition ~ 'procurement_fingerprint\( public\.canonical_purchase_receive_payload' then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'canonical_purchase_receive_payload feeds procurement_fingerprint', 'actual', f.definition ~ 'procurement_fingerprint\( public\.canonical_purchase_receive_payload')
  from function_catalog f where f.check_name = 'purchase_receive'
  union all
  select
    'PROCUREMENT_IDEMPOTENCY_STRUCTURE',
    'supplier_finalize_return canonical payload before fingerprint',
    case when f.oid is not null and f.definition ~ 'procurement_fingerprint\(public\.canonical_supplier_return_payload' then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'canonical_supplier_return_payload feeds procurement_fingerprint', 'actual', f.definition ~ 'procurement_fingerprint\(public\.canonical_supplier_return_payload')
  from function_catalog f where f.check_name = 'supplier_finalize_return'
  union all
  select
    'PROCUREMENT_IDEMPOTENCY_STRUCTURE',
    'settlement amount fingerprints normalize numeric(14,2)',
    case when count(*) filter (where f.definition like '%p_amount::numeric(14,2)%') = 2 then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'supplier payment and refund receipt fingerprint p_amount::numeric(14,2)', 'actual_matching_count', count(*) filter (where f.definition like '%p_amount::numeric(14,2)%'))
  from function_catalog f where f.check_name in ('supplier_record_payment', 'supplier_record_refund_receipt')
),
purchase_receive_results as (
  select
    'PURCHASE_RECEIPT_LOCK_ORDER'::text as section,
    'purchase_receive supplier/catalogue locks'::text as check_name,
    case when f.oid is not null
              and f.definition ~ 'from public\.suppliers where id = p_supplier_id for update'
              and f.definition ~ 'from public\.products p.*order by p\.id for update'
              and f.definition ~ 'from public\.product_variants v.*order by v\.product_id, v\.id for update'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'supplier FOR UPDATE; products id order FOR UPDATE; variants product_id/id order FOR UPDATE', 'actual', jsonb_build_object('supplier_for_update', f.definition ~ 'from public\.suppliers where id = p_supplier_id for update', 'products_for_update', f.definition ~ 'from public\.products p.*order by p\.id for update', 'variants_for_update', f.definition ~ 'from public\.product_variants v.*order by v\.product_id, v\.id for update')) as detail
  from function_catalog f where f.check_name = 'purchase_receive'
  union all
  select
    'PURCHASE_RECEIPT_LOCK_ORDER',
    'purchase_receive items, buckets, serialized units ordered',
    case when f.oid is not null
              and position('insert into public.purchase_items' in f.definition) < position('update public.stock_buckets' in f.definition)
              and position('update public.stock_buckets' in f.definition) < position('insert into public.serialized_units' in f.definition)
              and f.definition ~ 'group by pi\.product_id, pi\.variant_id, pi\.condition order by pi\.product_id, pi\.variant_id nulls first, pi\.condition'
              and f.definition ~ 'order by jsonb_build_object\( .acquisition_cost'
              and f.definition ~ 'order by \(upper\(btrim\(value ->> .type.\)\)::public\.identifier_type\)::text, public\.normalize_identifier_value'
              and f.definition like '%line_number, condition, notes)%'
         then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'items before buckets before units; business-key bucket order; canonical unit and identifier order; caller ordinality line_number', 'actual', jsonb_build_object('items_before_bucket_mutation', position('insert into public.purchase_items' in f.definition) < position('update public.stock_buckets' in f.definition), 'buckets_before_units', position('update public.stock_buckets' in f.definition) < position('insert into public.serialized_units' in f.definition), 'bucket_order', f.definition ~ 'group by pi\.product_id, pi\.variant_id, pi\.condition order by pi\.product_id, pi\.variant_id nulls first, pi\.condition', 'canonical_unit_order', f.definition ~ 'order by jsonb_build_object\( .acquisition_cost', 'identifier_type_value_order', f.definition ~ 'order by \(upper\(btrim\(value ->> .type.\)\)::public\.identifier_type\)::text, public\.normalize_identifier_value', 'caller_ordinality_line_number', f.definition like '%v_line.ordinality, v_condition%'))
  from function_catalog f where f.check_name = 'purchase_receive'
),
existing_purchase_lock_specs(check_name) as (
  values ('supplier_record_payment'), ('supplier_finalize_return'), ('supplier_record_refund_receipt'),
         ('supplier_reverse_payment'), ('supplier_reverse_return'), ('supplier_reverse_refund_receipt'), ('purchase_reverse')
),
existing_purchase_lock_results as (
  select
    'EXISTING_PURCHASE_LOCK_CONTRACT'::text as section,
    s.check_name,
    case when f.oid is not null
              and f.definition ~ 'from public\.suppliers.*for key share.*from public\.purchases.*for update'
              and f.definition not like '%v_supplier.active%'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'supplier lock before purchase FOR UPDATE; no active-supplier requirement for history', 'actual', jsonb_build_object('supplier_before_purchase', f.definition ~ 'from public\.suppliers.*for key share.*from public\.purchases.*for update', 'mentions_supplier_active', f.definition like '%v_supplier.active%')) as detail
  from existing_purchase_lock_specs s
  left join function_catalog f on f.check_name = s.check_name
),
purchase_reversal_results as (
  select
    'PURCHASE_REVERSAL_SAFETY'::text as section,
    'purchase_reverse D54/D38 and bucket snapshot safety'::text as check_name,
    case when f.oid is not null
              and f.definition ~ 'supplier_returns where purchase_id ?= ?v_purchase.id'
              and f.definition like '%supplier_payment_reversals%'
              and f.definition ~ 'inventory_bucket_effects.*movement=.purchase.*order by product_id,variant_id nulls first,condition'
              and f.definition like '%v_bucket.inventory_revision<>v_effect.revision_after%'
              and f.definition like '%v_bucket.quantity<>v_effect.quantity_after%'
              and f.definition like '%v_bucket.weighted_average_cost<>v_effect.wac_after%'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'D54/D38 blockers; deterministic bucket preflight; revision/quantity/WAC after-state equality', 'actual', jsonb_build_object('d54_return_history', f.definition ~ 'supplier_returns where purchase_id ?= ?v_purchase.id', 'd38_payment_reversal', f.definition like '%supplier_payment_reversals%', 'bucket_order', f.definition ~ 'inventory_bucket_effects.*movement=.purchase.*order by product_id,variant_id nulls first,condition', 'revision_after_check', f.definition like '%v_bucket.inventory_revision<>v_effect.revision_after%', 'quantity_after_check', f.definition like '%v_bucket.quantity<>v_effect.quantity_after%', 'wac_after_check', f.definition like '%v_bucket.weighted_average_cost<>v_effect.wac_after%')) as detail
  from function_catalog f where f.check_name = 'purchase_reverse'
  union all
  select
    'PURCHASE_REVERSAL_SAFETY',
    'purchase_reverse locked serialized lifecycle safety',
    case when f.oid is not null
              and f.definition ~ 'serialized_units u.*purchase_items pi.*order by u\.id for update'
              and f.definition ~ 'v_unit.status <> .available.'
              and f.definition ~ 'e.movement = .purchase.'
              and f.definition like '%e.unit_revision_after = v_unit.lifecycle_revision%'
              and f.definition ~ 'e.status_after = .available.'
              and position('order by u.id for update' in f.definition) < position('insert into public.purchase_reversals' in f.definition)
              and f.definition like '%purchase_reversal_id%'
              and f.definition ~ 'status ?= ?.purchase_reversed.'
         then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'UUID-ordered locked unit revalidation against PURCHASE receipt effect before reversal mutation; linked payment reversals; PURCHASE_REVERSED target', 'actual', jsonb_build_object('units_for_update_ordered', f.definition ~ 'serialized_units u.*purchase_items pi.*order by u\.id for update', 'available_recheck', f.definition ~ 'v_unit.status <> .available.', 'purchase_effect_recheck', f.definition ~ 'e.movement = .purchase.' and f.definition like '%e.unit_revision_after = v_unit.lifecycle_revision%' and f.definition ~ 'e.status_after = .available.', 'locks_before_reversal_insert', position('order by u.id for update' in f.definition) < position('insert into public.purchase_reversals' in f.definition), 'linked_payment_reversal', f.definition like '%purchase_reversal_id%', 'purchase_reversed_target', f.definition ~ 'status ?= ?.purchase_reversed.'))
  from function_catalog f where f.check_name = 'purchase_reverse'
),
supplier_return_results as (
  select
    'SUPPLIER_RETURN_SAFETY'::text as section,
    'supplier_finalize_return structural safety'::text as check_name,
    case when f.oid is not null
              and f.definition like '%coalesce(max(return_order),0)+1%'
              and f.definition like '%srl.purchase_item_id=v_item.id%'
              and f.definition like '%>v_item.quantity%'
              and f.definition like '%v_bucket.quantity<v_line.quantity%'
              and f.definition not like '%weighted_average_cost=v_before_wac%'
              and f.definition ~ 'order by u\.id for update'
              and f.definition ~ 'v_unit.status <> .available.'
              and f.definition like '%v_unit.purchase_item_id is distinct from v_item.id%'
              and f.definition like '%v_unit.acquisition_cost%'
              and f.definition not like '%v_unit.condition <> v_item.condition%'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'purchase-locked return ordering; source cap/bucket check; WAC unchanged; UUID serialized locks; exact origin; acquisition valuation; no condition equality restriction', 'actual', jsonb_build_object('return_order', f.definition like '%coalesce(max(return_order),0)+1%', 'original_line_cap', f.definition like '%srl.purchase_item_id=v_item.id%' and f.definition like '%>v_item.quantity%', 'bucket_quantity_check', f.definition like '%v_bucket.quantity<v_line.quantity%', 'wac_unchanged', f.definition not like '%weighted_average_cost=v_before_wac%', 'uuid_unit_lock', f.definition ~ 'order by u\.id for update', 'available_check', f.definition ~ 'v_unit.status <> .available.', 'exact_origin', f.definition like '%v_unit.purchase_item_id is distinct from v_item.id%', 'acquisition_cost', f.definition like '%v_unit.acquisition_cost%', 'no_condition_equality_restriction', f.definition not like '%v_unit.condition <> v_item.condition%')) as detail
  from function_catalog f where f.check_name = 'supplier_finalize_return'
  union all
  select
    'SUPPLIER_RETURN_SAFETY',
    'supplier_reverse_return structural safety',
    case when f.oid is not null
              and f.definition like '%reverse active refund receipts before reversing a supplier return%'
              and f.definition ~ 'movement=.supplier_return.*order by product_id,variant_id nulls first,condition'
              and f.definition like '%v_bucket.inventory_revision<>v_effect.revision_after%'
              and f.definition like '%order by serialized_unit_id%'
              and position('v_unit.status<>''returned_to_supplier''' in f.definition) > 0
              and position('update public.serialized_units set status=''available'',lifecycle_revision=v_unit.lifecycle_revision+1' in f.definition) > 0
              and position('values(''supplier_return_reversal'',v_unit.id,v_move,''returned_to_supplier'',''available''' in f.definition) > 0
              and f.definition like '%public.assert_purchase_refund_receipts_safe(v_return.purchase_id)%'
         then 'PASS' else 'FAIL' end,
    jsonb_build_object('expected', 'D56 active-receipt block; deterministic bucket snapshot safety; UUID serial order; RETURNED_TO_SUPPLIER -> AVAILABLE; global refund safety', 'actual', jsonb_build_object('d56_receipt_block', f.definition like '%reverse active refund receipts before reversing a supplier return%', 'bucket_order', f.definition ~ 'movement=.supplier_return.*order by product_id,variant_id nulls first,condition', 'bucket_snapshot_check', f.definition like '%v_bucket.inventory_revision<>v_effect.revision_after%', 'serialized_uuid_order', f.definition like '%order by serialized_unit_id%', 'returned_to_supplier_source', position('v_unit.status<>''returned_to_supplier''' in f.definition) > 0, 'available_target', position('update public.serialized_units set status=''available'',lifecycle_revision=v_unit.lifecycle_revision+1' in f.definition) > 0, 'lifecycle_effect_transition', position('values(''supplier_return_reversal'',v_unit.id,v_move,''returned_to_supplier'',''available''' in f.definition) > 0, 'refund_safety_helper', f.definition like '%public.assert_purchase_refund_receipts_safe(v_return.purchase_id)%'))
  from function_catalog f where f.check_name = 'supplier_reverse_return'
),
refund_results as (
  select
    'REFUND_ENTITLEMENT'::text as section,
    'immutable refund entitlement allocation and statuses'::text as check_name,
    case when f.oid is not null
              and f.definition like '%order by sr.return_order%'
              and f.definition like '%supplier_payment_reversals%'
              and f.definition like '%supplier_return_reversals%'
              and f.definition like '%supplier_refund_receipt_reversals%'
              and f.definition like '%no_refund_due%'
              and f.definition like '%refund_due%'
              and f.definition like '%partially_refunded%'
              and f.definition like '%refunded%'
              and f.definition not like '%over_receipted%'
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'return_order allocation; reversed rows excluded; four D62 statuses only; no OVER_RECEIPTED', 'actual', jsonb_build_object('return_order', f.definition like '%order by sr.return_order%', 'payment_reversals_excluded', f.definition like '%supplier_payment_reversals%', 'return_reversals_excluded', f.definition like '%supplier_return_reversals%', 'receipt_reversals_excluded', f.definition like '%supplier_refund_receipt_reversals%', 'no_over_receipted', f.definition not like '%over_receipted%')) as detail
  from function_catalog f where f.check_name = 'supplier_return_refund_entitlements'
),
relation_catalog as (
  select c.oid, c.relname::text as relname, c.relkind, c.relrowsecurity, c.reloptions, c.relacl, c.relowner
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
relation_acl as (
  select
    c.oid,
    coalesce(bool_or(a.privilege_type = 'SELECT' and a.grantee = 0), false) as public_select,
    coalesce(bool_or(a.privilege_type = 'SELECT' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'anon')), false) as anon_select,
    coalesce(bool_or(a.privilege_type = 'SELECT' and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'authenticated')), false) as authenticated_select,
    coalesce(bool_or(a.privilege_type in ('INSERT', 'UPDATE', 'DELETE') and a.grantee in (0, (select oid from pg_catalog.pg_roles where rolname = 'anon'), (select oid from pg_catalog.pg_roles where rolname = 'authenticated'))), false) as browser_write
  from relation_catalog c
  left join lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a on true
  group by c.oid
),
management_view_results as (
  select
    'MANAGEMENT_VIEW'::text as section,
    'supplier_return_financial_summary security and shape'::text as check_name,
    case when c.oid is not null
              and c.relkind = 'v'
              and coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
              and coalesce(a.authenticated_select, false)
              and not coalesce(a.public_select, false)
              and not coalesce(a.anon_select, false)
              and not exists (
                select 1 from relation_catalog base
                where base.relname in ('purchases', 'supplier_payments', 'supplier_payment_reversals', 'supplier_returns', 'supplier_return_reversals', 'supplier_refund_receipts', 'supplier_refund_receipt_reversals')
                  and (base.oid is null or not base.relrowsecurity)
              )
              and (select array_agg(x.attname::text order by x.attnum) from pg_catalog.pg_attribute x where x.attrelid = c.oid and x.attnum > 0 and not x.attisdropped)
                    @> array['supplier_return_id','purchase_id','return_number','return_order','return_value','original_purchase_total','net_supplier_payments','refund_entitlement','active_refund_receipts','remaining_refund_due','refund_status']::text[]
         then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'view; security_invoker=true; authenticated SELECT only; underlying management tables retain RLS; required columns', 'actual', jsonb_build_object('present', c.oid is not null, 'relkind', c.relkind::text, 'security_invoker', coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true'], 'public_select', coalesce(a.public_select, false), 'anon_select', coalesce(a.anon_select, false), 'authenticated_select', coalesce(a.authenticated_select, false), 'underlying_rls_enabled', not exists (select 1 from relation_catalog base where base.relname in ('purchases', 'supplier_payments', 'supplier_payment_reversals', 'supplier_returns', 'supplier_return_reversals', 'supplier_refund_receipts', 'supplier_refund_receipt_reversals') and (base.oid is null or not base.relrowsecurity)), 'columns', coalesce((select jsonb_agg(x.attname::text order by x.attnum) from pg_catalog.pg_attribute x where x.attrelid = c.oid and x.attnum > 0 and not x.attisdropped), '[]'::jsonb))) as detail
  from (select 1) seed
  left join relation_catalog c on c.relname = 'supplier_return_financial_summary'
  left join relation_acl a on a.oid = c.oid
),
direct_write_table_specs(check_name, table_name) as (
  values
    ('suppliers', 'suppliers'), ('purchases', 'purchases'), ('purchase_items', 'purchase_items'),
    ('supplier_payments', 'supplier_payments'), ('supplier_payment_reversals', 'supplier_payment_reversals'),
    ('supplier_returns', 'supplier_returns'), ('supplier_return_lines', 'supplier_return_lines'),
    ('supplier_return_reversals', 'supplier_return_reversals'), ('supplier_refund_receipts', 'supplier_refund_receipts'),
    ('supplier_refund_receipt_reversals', 'supplier_refund_receipt_reversals'), ('inventory_bucket_effects', 'inventory_bucket_effects'),
    ('serialized_unit_lifecycle_effects', 'serialized_unit_lifecycle_effects'), ('procurement_operation_reservations', 'procurement_operation_reservations')
),
staff_access_results as (
  select
    'STAFF_PROCUREMENT_ACCESS'::text as section,
    s.check_name,
    case when c.oid is not null and not coalesce(a.browser_write, false) then 'PASS' else 'FAIL' end as status,
    jsonb_build_object('expected', 'no direct PUBLIC/anon/authenticated INSERT, UPDATE, or DELETE grant', 'actual', jsonb_build_object('present', c.oid is not null, 'browser_write_grant', coalesce(a.browser_write, false))) as detail
  from direct_write_table_specs s
  left join relation_catalog c on c.relname = s.table_name and c.relkind in ('r', 'p')
  left join relation_acl a on a.oid = c.oid
),
checks as (
  select * from function_presence_results
  union all select * from function_security_results
  union all select * from function_privilege_results
  union all select * from approved_phase5_access_results
  union all select * from trigger_results
  union all select * from phase5_replacement_results
  union all select * from idempotency_results
  union all select * from purchase_receive_results
  union all select * from existing_purchase_lock_results
  union all select * from purchase_reversal_results
  union all select * from supplier_return_results
  union all select * from refund_results
  union all select * from management_view_results
  union all select * from staff_access_results
),
final_results as (
  select section, check_name, status, detail from checks
  union all
  select
    'MIGRATION_3_LIVE_STRUCTURAL_VERDICT',
    'overall',
    case when count(*) filter (where status = 'FAIL') = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'pass_checks', count(*) filter (where status = 'PASS'),
      'fail_checks', count(*) filter (where status = 'FAIL'),
      'info_checks', count(*) filter (where status = 'INFO'),
      'failed_checks', coalesce(jsonb_agg(jsonb_build_object('section', section, 'check_name', check_name) order by section, check_name) filter (where status = 'FAIL'), '[]'::jsonb)
    )
  from checks
)
select section, check_name, status, detail
from final_results
order by case when section = 'MIGRATION_3_LIVE_STRUCTURAL_VERDICT' then 2 else 1 end, section, check_name;
