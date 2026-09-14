-- Phase 6 Migration 3 four-fail diagnostic: SELECT-only, one result set.
-- No DDL, DML, RPC invocation, temporary objects, or other mutation is performed.

with
privilege_targets(check_name, proname, signature) as (
  values
    ('inventory_submit_adjustment_request', 'inventory_submit_adjustment_request', 'public.inventory_submit_adjustment_request(uuid,uuid,uuid,public.product_condition,integer,text)'),
    ('inventory_reject_adjustment_request', 'inventory_reject_adjustment_request', 'public.inventory_reject_adjustment_request(uuid,text)'),
    ('staff_serialized_lookup', 'staff_serialized_lookup', 'public.staff_serialized_lookup(text)')
),
role_state as (
  select exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') as authenticated_exists
),
exact_privilege_functions as (
  select
    t.*,
    pg_catalog.to_regprocedure(t.signature) as exact_oid
  from privilege_targets t
),
function_acl_entries as (
  select
    f.exact_oid,
    coalesce(jsonb_agg(jsonb_build_object(
      'grantee', case when a.grantee = 0 then 'PUBLIC' else coalesce(grantee_role.rolname, a.grantee::text) end,
      'grantor', coalesce(grantor_role.rolname, a.grantor::text),
      'privilege_type', a.privilege_type,
      'is_grantable', a.is_grantable
    ) order by case when a.grantee = 0 then 'PUBLIC' else coalesce(grantee_role.rolname, a.grantee::text) end, a.privilege_type), '[]'::jsonb) as entries
  from exact_privilege_functions f
  left join pg_catalog.pg_proc p on p.oid = f.exact_oid
  left join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a on p.oid is not null
  left join pg_catalog.pg_roles grantee_role on grantee_role.oid = a.grantee
  left join pg_catalog.pg_roles grantor_role on grantor_role.oid = a.grantor
  group by f.exact_oid
),
privilege_diagnostics as (
  select
    f.check_name,
    f.proname,
    f.signature,
    f.exact_oid,
    p.oid,
    pg_catalog.pg_get_function_identity_arguments(p.oid) as exact_identity_arguments,
    owner_role.rolname::text as owner,
    p.proacl::text as proacl_raw,
    case when p.oid is null then null else pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') end as public_execute,
    case when p.oid is null then null else pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_execute,
    case when p.oid is null then null else pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') end as authenticated_execute,
    a.entries,
    r.authenticated_exists
  from exact_privilege_functions f
  cross join role_state r
  left join pg_catalog.pg_proc p on p.oid = f.exact_oid
  left join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
  left join function_acl_entries a on a.exact_oid = f.exact_oid
),
privilege_results as (
  select
    'EXACT_FUNCTION_PRIVILEGES'::text as section,
    d.check_name,
    case when d.oid is not null
              and d.authenticated_exists
              and d.authenticated_execute
              and not d.public_execute
              and not d.anon_execute then 'PASS' else 'FAIL' end as status,
    case when d.oid is not null
              and d.authenticated_exists
              and d.authenticated_execute
              and not d.public_execute
              and not d.anon_execute then 'VERIFIER_FALSE_POSITIVE'
         else 'GENUINE_LIVE_DEFECT' end as classification,
    jsonb_build_object(
      'requested_regprocedure', d.signature,
      'resolved_oid', d.exact_oid,
      'exact_identity', case when d.oid is null then null else format('public.%s(%s)', d.proname, d.exact_identity_arguments) end,
      'owner', d.owner,
      'proacl_raw', d.proacl_raw,
      'authenticated_role_exists', d.authenticated_exists,
      'effective_execute', jsonb_build_object('PUBLIC', d.public_execute, 'anon', d.anon_execute, 'authenticated', d.authenticated_execute),
      'acl_entries', d.entries
    ) as detail
  from privilege_diagnostics d
),
authenticated_role_result as (
  select
    'EXACT_FUNCTION_PRIVILEGES'::text as section,
    'authenticated role exists'::text as check_name,
    case when authenticated_exists then 'PASS' else 'FAIL' end as status,
    case when authenticated_exists then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end as classification,
    jsonb_build_object('role_exists', authenticated_exists) as detail
  from role_state
),
overload_results as (
  select
    'FUNCTION_OVERLOADS_INFO'::text as section,
    t.check_name,
    'INFO'::text as status,
    'CONFIRMED_CORRECT'::text as classification,
    jsonb_build_object(
      'requested_regprocedure', t.signature,
      'resolved_exact_oid', pg_catalog.to_regprocedure(t.signature),
      'same_proname_overloads', coalesce((
        select jsonb_agg(jsonb_build_object(
          'oid', p.oid,
          'identity', format('public.%s(%s)', p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)),
          'is_requested_exact_oid', p.oid = pg_catalog.to_regprocedure(t.signature)
        ) order by p.oid)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = t.proname
      ), '[]'::jsonb)
    ) as detail
  from privilege_targets t
),
reverse_return_function as (
  select
    pg_catalog.to_regprocedure('public.supplier_reverse_return(uuid,uuid,text)') as exact_oid
),
reverse_return_definition as (
  select
    r.exact_oid,
    lower(regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '\s+', ' ', 'g')) as definition
  from reverse_return_function r
  left join pg_catalog.pg_proc p on p.oid = r.exact_oid
),
reverse_return_checks(check_name, passed) as (
  select 'active refund receipt blocker exists', d.definition like '%reverse active refund receipts before reversing a supplier return%' from reverse_return_definition d
  union all select 'supplier-return bucket effects use product/variant/condition order', position('inventory_bucket_effects' in d.definition) > 0 and position('movement=''supplier_return''' in d.definition) > 0 and position('order by product_id,variant_id nulls first,condition' in d.definition) > 0 from reverse_return_definition d
  union all select 'current bucket revision/quantity/WAC snapshot safety exists', position('v_bucket.inventory_revision<>v_effect.revision_after' in d.definition) > 0 and position('v_bucket.quantity<>v_effect.quantity_after' in d.definition) > 0 and position('v_bucket.weighted_average_cost<>v_effect.wac_after' in d.definition) > 0 from reverse_return_definition d
  union all select 'serialized lines ordered by serialized_unit_id', position('serialized_unit_id is not null order by serialized_unit_id' in d.definition) > 0 from reverse_return_definition d
  union all select 'serialized unit locked FOR UPDATE', position('from public.serialized_units where id=v_line.serialized_unit_id for update' in d.definition) > 0 from reverse_return_definition d
  union all select 'locked unit requires RETURNED_TO_SUPPLIER', position('v_unit.status<>''returned_to_supplier''' in d.definition) > 0 from reverse_return_definition d
  union all select 'SUPPLIER_RETURN lifecycle effect/current revision check exists', position('serialized_unit_lifecycle_effects e' in d.definition) > 0 and position('e.movement=''supplier_return''' in d.definition) > 0 and position('e.unit_revision_after=v_unit.lifecycle_revision' in d.definition) > 0 and position('e.supplier_return_line_id=v_line.id' in d.definition) > 0 from reverse_return_definition d
  union all select 'update target sets status AVAILABLE', position('update public.serialized_units set status=''available''' in d.definition) > 0 from reverse_return_definition d
  union all select 'lifecycle_revision increments on restoration', position('lifecycle_revision=v_unit.lifecycle_revision+1' in d.definition) > 0 from reverse_return_definition d
  union all select 'SUPPLIER_RETURN_REVERSAL movement exists', position('insert into public.inventory_movements' in d.definition) > 0 and position('''supplier_return_reversal''' in d.definition) > 0 from reverse_return_definition d
  union all select 'lifecycle effect records RETURNED_TO_SUPPLIER to AVAILABLE', position('insert into public.serialized_unit_lifecycle_effects' in d.definition) > 0 and position('''supplier_return_reversal''' in d.definition) > 0 and position('''returned_to_supplier'',''available''' in d.definition) > 0 from reverse_return_definition d
  union all select 'assert_purchase_refund_receipts_safe is called', d.definition like '%public.assert_purchase_refund_receipts_safe(v_return.purchase_id)%' from reverse_return_definition d
),
reverse_return_results as (
  select
    'SUPPLIER_REVERSE_RETURN_DIAGNOSTIC'::text as section,
    c.check_name,
    case when coalesce(c.passed, false) then 'PASS' else 'FAIL' end as status,
    case when coalesce(c.passed, false) then 'CONFIRMED_CORRECT' else 'GENUINE_LIVE_DEFECT' end as classification,
    jsonb_build_object('exact_regprocedure', 'public.supplier_reverse_return(uuid,uuid,text)', 'resolved_oid', d.exact_oid, 'matched', coalesce(c.passed, false)) as detail
  from reverse_return_checks c
  cross join reverse_return_definition d
),
reverse_return_fragment_info as (
  select
    'SUPPLIER_REVERSE_RETURN_DIAGNOSTIC'::text as section,
    'normalized AVAILABLE transition fragment'::text as check_name,
    'INFO'::text as status,
    case when d.exact_oid is null then 'GENUINE_LIVE_DEFECT' else 'CONFIRMED_CORRECT' end as classification,
    jsonb_build_object(
      'exact_regprocedure', 'public.supplier_reverse_return(uuid,uuid,text)',
      'resolved_oid', d.exact_oid,
      'fragment', coalesce(substr(d.definition, nullif(position('update public.serialized_units set' in d.definition), 0), 420), '<missing AVAILABLE transition>')
    ) as detail
  from reverse_return_definition d
),
original_verifier_comparison as (
  select
    'ORIGINAL_VERIFIER_COMPARISON'::text as section,
    d.check_name,
    case when d.oid is not null and d.authenticated_exists and d.authenticated_execute and not d.public_execute and not d.anon_execute then 'PASS' else 'FAIL' end as status,
    case when d.oid is not null and d.authenticated_exists and d.authenticated_execute and not d.public_execute and not d.anon_execute then 'VERIFIER_FALSE_POSITIVE' else 'GENUINE_LIVE_DEFECT' end as classification,
    jsonb_build_object(
      'original_verifier_cause', 'approved_phase5_access_results joins function_acl, but function_acl is built only from function_catalog and excludes the three approved Phase 5 signatures; the joined ACL values are therefore NULL.',
      'targeted_diagnostic_basis', jsonb_build_object('exact_oid', d.oid, 'PUBLIC_execute', d.public_execute, 'anon_execute', d.anon_execute, 'authenticated_execute', d.authenticated_execute)
    ) as detail
  from privilege_diagnostics d
  union all
  select
    'ORIGINAL_VERIFIER_COMPARISON',
    'supplier_reverse_return available_target',
    case when exists (select 1 from reverse_return_checks where check_name = 'update target sets status AVAILABLE' and passed) then 'PASS' else 'FAIL' end,
    case when exists (select 1 from reverse_return_checks where check_name = 'update target sets status AVAILABLE' and passed) then 'VERIFIER_FALSE_POSITIVE' else 'GENUINE_LIVE_DEFECT' end,
    jsonb_build_object(
      'original_verifier_cause', 'The original verifier uses LIKE ''%status=.available.%''. LIKE treats the periods literally, so it does not match status=''AVAILABLE''; this diagnostic uses a whitespace-tolerant regular expression.',
      'targeted_diagnostic_basis', jsonb_build_object('available_update_detected', exists (select 1 from reverse_return_checks where check_name = 'update target sets status AVAILABLE' and passed))
    )
),
checks as (
  select * from privilege_results
  union all select * from authenticated_role_result
  union all select * from overload_results
  union all select * from reverse_return_results
  union all select * from reverse_return_fragment_info
  union all select * from original_verifier_comparison
),
final_results as (
  select section, check_name, status, classification, detail from checks
  union all
  select
    'FOUR_FAIL_DIAGNOSTIC_VERDICT',
    'overall',
    case when count(*) filter (where status = 'FAIL') = 0 then 'PASS' else 'FAIL' end,
    case when count(*) filter (where status = 'FAIL') = 0 then 'VERIFIER_FALSE_POSITIVE' else 'GENUINE_LIVE_DEFECT' end,
    jsonb_build_object(
      'pass_checks', count(*) filter (where status = 'PASS'),
      'fail_checks', count(*) filter (where status = 'FAIL'),
      'info_checks', count(*) filter (where status = 'INFO'),
      'failed_checks', coalesce(jsonb_agg(jsonb_build_object('section', section, 'check_name', check_name, 'classification', classification) order by section, check_name) filter (where status = 'FAIL'), '[]'::jsonb)
    )
  from checks
)
select section, check_name, status, classification, detail
from final_results
order by case when section = 'FOUR_FAIL_DIAGNOSTIC_VERDICT' then 2 else 1 end, section, check_name;
