# Production release preflight — offline-v2

## Release identity

| Item | Required value | Status on 2026-10-13 |
| --- | --- | --- |
| Application commit | `c1d96718b3b0a4bdd3e5f63b0a47ec0f0426f9e4` | verified locally |
| Branch | `recovery/offline-v2` | verified locally |
| Supabase project ref | `wugmcqtyiknqobjqwhno` | release-day verification required |
| Worker | `timmers-gadget` | source configuration verified |
| Application URL | `https://timmers-gadget.timmersgadget.workers.dev/app` | smoke-test target |

This document is a preparation artifact, not permission to migrate or deploy. The release is **NO-GO** until the release-day read-only checks, backup confirmation, and formal decision on the unresolved Cloudflare 1102 risk are complete.

## Pending migration order and source dependency audit

The repository contains the following 14 source-only migrations after the existing sales baseline. Apply them only in this exact filename order. A later `CREATE OR REPLACE` is an intentional replacement, not a reason to omit its predecessor.

| # | Migration | Objects / dependencies | Replacement / security | Verdict |
| ---: | --- | --- | --- | --- |
| 1 | `20260930082955_staff_serialized_inventory_snapshot.sql` | `staff_serialized_inventory_snapshot`; depends on serialized units, identifiers, catalogue prices, products, variants, and active-profile guard | SECURITY DEFINER; restricted to authenticated after PUBLIC/anon revoke; explicit `public, pg_temp` path | WARNING — older but explicit path; no source blocker |
| 2 | `20260930163023_phase4_offline_customer_supplier_reference_snapshots.sql` | staff customer and manager supplier reference snapshots; depends on customers, suppliers, profiles/roles | SECURITY DEFINER; revoke/grant; explicit `public, pg_temp` path | WARNING — older but explicit path; superseded snapshot consumers use v2 functions below |
| 3 | `20261001090000_phase5_offline_customer_create.sql` | customer-create reservation table and `offline_customer_create` | actor/request/fingerprint idempotency; RLS, table revoke, SECURITY DEFINER `pg_catalog, pg_temp` | SAFE |
| 4 | `20261002090000_phase5_offline_customer_update.sql` | customer-update reservation table, `offline_customer_update`, `staff_customer_reference_snapshot_v2` | supersedes the customer reference endpoint for update-capable clients; RLS/revoke/grant and hardened path | SAFE |
| 5 | `20261005090000_phase6a_offline_supplier_create.sql` | supplier-create reservation table and manager-only create RPC | depends on supplier/profile model; RLS/revoke/grant and hardened path | SAFE |
| 6 | `20261005100000_phase6b_offline_supplier_update.sql` | supplier-update reservation table, update RPC, `manager_supplier_reference_snapshot_v2` | supersedes supplier reference endpoint for update-capable clients; RLS/revoke/grant and hardened path | SAFE |
| 7 | `20261006100000_phase6c_offline_purchase_receive.sql` | initial nonserialized `offline_purchase_receive` wrapper | depends on procurement reservation/finalization boundary; validates only and delegates authoritative receipt | SAFE; intentionally replaced by #8 and #9 |
| 8 | `20261006110000_phase6cc_offline_serialized_purchase_receive.sql` | replacement receipt wrapper adding serialized lines | depends on #7 and serialized procurement schema | SAFE; intentionally replaced by #9 |
| 9 | `20261006122959_phase6cd_offline_purchase_receive_payments.sql` | replacement receipt wrapper adding initial payments | depends on #8 and payment-capable procurement workflow | SAFE — final receipt wrapper |
| 10 | `20261007152918_phase7a_offline_inventory_adjustment_request.sql` | adjustment-request reservation table and request RPC | depends on adjustment-request context and product/condition model; RLS/revoke/grant, hardened path | SAFE |
| 11 | `20261008091725_phase7ac_offline_adjustment_request_reconciliation.sql` | read-only adjustment-request status snapshot | depends on #10 operation table and request workflow; hardened SECURITY DEFINER path | SAFE |
| 12 | `20261009080116_phase7bb_provisional_offline_cash_checkout.sql` | `catalogue_prices.quote_revision`, quote trigger, catalogue snapshot, sale reservation table, initial cash checkout RPC | depends on the Phase 7 finalizer and sales/inventory effect model; price revision is checked server-side; RLS/revoke/grant | SAFE; checkout RPC intentionally replaced by #14 |
| 13 | `20261010140321_phase7_variant_inventory_checkout_alignment.sql` | variant-target assertion/trigger guards, variant-pricing switch, safe serialized lookup and legacy-inventory report | depends on products, variants, prices, buckets, serialized units, opening-stock and purchase items; hardened SECURITY DEFINER paths | SAFE; existing invalid legacy rows are not rewritten |
| 14 | `20261012110000_phase7bc_serialized_provisional_offline_checkout.sql` | safe sellable-serialized snapshot and final `offline_sales_checkout` replacement | requires #12 reservation/quote model, #13 variant rules, and Phase 7 checkout finalizer; handles mixed carts atomically | SAFE — final checkout RPC |

Static source result: filename chronology is safe; no later migration is required before an earlier one executes. All new operation tables are RLS-enabled and direct browser table access is revoked. Newer SECURITY DEFINER functions explicitly use `pg_catalog, pg_temp`, authenticate/authorize within the function, and revoke default PUBLIC/anon access before granting `authenticated` where appropriate. The two early, read-only snapshot functions are explicit but use `public, pg_temp`; do not rewrite applied migration history during this release.

## Data compatibility — release-day, read-only only

No production data was read during preparation. Therefore every data finding is **UNKNOWN**, not proof of health or corruption. Before applying migrations, an authorized operator must run the following in a read-only SQL session against **only** `wugmcqtyiknqobjqwhno`. Keep any row-level output private; record counts and opaque IDs only in the release record.

```sql
begin read only;

-- Duplicate serialized identifiers must be absent. (Expected count: 0.)
select normalized_value, identifier_type, count(*) as duplicate_count
from public.unit_identifiers
group by normalized_value, identifier_type
having count(*) > 1;

-- Variant must belong to the unit's product. (Expected count: 0.)
select u.id as unit_id
from public.serialized_units u
left join public.product_variants v on v.id = u.variant_id
where u.variant_id is not null
  and (v.id is null or v.product_id is distinct from u.product_id);

-- A product with active variants must not retain active base prices. (Expected count: 0.)
select cp.id as catalogue_price_id
from public.catalogue_prices cp
where cp.active and cp.variant_id is null
  and exists (
    select 1 from public.product_variants pv
    where pv.product_id = cp.product_id and pv.active
  );

-- Available serialized stock may not use an inactive/mismatched variant. (Expected count: 0.)
select u.id as unit_id
from public.serialized_units u
left join public.product_variants v on v.id = u.variant_id
where u.status = 'AVAILABLE' and u.variant_id is not null
  and (v.id is null or not v.active or v.product_id is distinct from u.product_id);

-- Variant-less live inventory for a product in active variant mode. (Expected count: 0 or an approved remediation plan.)
select 'STOCK_BUCKET'::text as kind, b.id
from public.stock_buckets b
where b.variant_id is null and b.quantity > 0
  and exists (select 1 from public.product_variants pv where pv.product_id = b.product_id and pv.active)
union all
select 'SERIALIZED_UNIT'::text, u.id
from public.serialized_units u
where u.variant_id is null and u.status = 'AVAILABLE'
  and exists (select 1 from public.product_variants pv where pv.product_id = u.product_id and pv.active);

-- A price must have a product and, if variant-specific, the exact product's variant. (Expected count: 0.)
select cp.id as catalogue_price_id
from public.catalogue_prices cp
left join public.products p on p.id = cp.product_id
left join public.product_variants v on v.id = cp.variant_id
where p.id is null
   or (cp.variant_id is not null and (v.id is null or v.product_id is distinct from cp.product_id));

-- Profile authorization values must be present and active state must be explicit. (Expected count: 0.)
select id
from public.profiles
where role is null or is_active is null;

-- Inventory source rows already carrying a variant must be product-consistent. (Expected count: 0.)
select b.id as stock_bucket_id
from public.stock_buckets b
left join public.product_variants v on v.id = b.variant_id
where b.variant_id is not null
  and (v.id is null or v.product_id is distinct from b.product_id);

-- Existing procurement replay identities must be unique. (Expected count: 0.)
select request_id, count(*) as duplicate_count
from public.procurement_operation_reservations
group by request_id
having count(*) > 1;

commit;
```

Also run the Manager/Admin-only `public.catalogue_variant_mode_legacy_inventory_report()` **after** migration #13 and before enabling affected operational workflows. It is a report, not a repair. Review identifier, role/status, and pre-existing operation/idempotency anomalies with the approved operational owner; do not improvise a data repair in the release window.

Immediately after migration #14, verify the unique reservation identities on the newly created customer, supplier, adjustment, and sale operation tables through the catalog and confirm that no unexpected rows were introduced during the migration window. The new tables are empty on first application; their primary/unique keys are the duplicate-write barrier. Any duplicate request/operation identity is a **BLOCKER**.

Classification rule: any duplicate identifier, broken foreign relationship, malformed authorization record, or data condition that prevents a required guard from being applied is a **BLOCKER**. Variant-mode legacy inventory is at least a **WARNING** and requires an approved handling plan before affected sale/receipt activity. Zero rows for all queries is **SAFE**.

## Production migration history — required evidence

Preparation could not authenticate the read-only Supabase CLI: the attempt to list migrations for the explicit project ref failed while initialising its login role with `LegacyDbConfigLoginRoleNetworkError: TransportError`. No SQL was run. On release day, in an authorized environment, run:

```text
npx supabase migration list --linked --project-ref wugmcqtyiknqobjqwhno
```

Capture the project identity and compare remote history to the repository sequence. It must prove that the historical baseline is present, none of the 14 pending migrations were unexpectedly applied, and there are no remote-only migrations or gaps. If the command would relink the repository, stop; do not use it. An authenticated operator may instead use the Supabase dashboard's migration-history view for the same project.

## Security and offline-boundary verdict

Static repository review is **PASS WITH RELEASE-DAY VERIFICATION**:

- No tracked `.env`, `.env.local`, or `.dev.vars` file was found; the tracked-source secret scan found only the README warning about `service_role`, not a credential.
- Browser-facing source does not expose a service-role key. Offline encrypted V4 envelopes retain user/device-bound AES-GCM AAD, and sensitive mutation metadata does not contain plaintext IMEI.
- The service worker does not cache authenticated `/app` HTML or authenticated Supabase responses, and it does not replay business mutations. Snapshot responses are `no-store`.
- Staff snapshots project selling/catalogue information but not acquisition cost, WAC, COGS, or supplier financial fields. The checkout-safe serialized snapshot remains cost-safe. ADMIN remains offline-ineligible.
- Replay goes through server authority. Offline command RPCs bind actor, operation/request identity, and canonical fingerprint; completed results are returned before mutable-state revalidation.
- The final checkout RPC delegates to the authoritative sales finalizer. Its reservation is checked first, preventing duplicate sale/payment/COGS/effect/SOLD transition; the finalizer provides atomic mixed serialized/nonserialized failure semantics.

Release-day verification must include function EXECUTE privileges, RLS/policy inspection, and a response-header check for `Cache-Control: no-store` on authenticated snapshot endpoints. Do not treat this static review as a substitute for production configuration evidence.

## Cloudflare target and 1102 status

The tracked `wrangler.jsonc` targets Worker `timmers-gadget`, with the Vinext output handler and `nodejs_compat`; `package.json` defines the approved deployment command as `npm run deploy:vinext`. This is a source configuration **PASS**, but the production account/version could not be verified.

Read-only Cloudflare inspection was unavailable: `npx wrangler deployments list --name timmers-gadget` required `CLOUDFLARE_API_TOKEN` in the noninteractive session. No token was printed or changed. On release day, an authorized operator must run `npx wrangler whoami`, capture the incumbent Worker version, inspect Workers observability/logs for error 1102, and record only timestamp, route/method, outcome, CPU/wall/memory signal, Ray/request ID, and recurring route pattern. Never record cookies, authentication material, identifiers, personal data, costs, or raw mutation payloads.

**1102 is an UNRESOLVED PRODUCTION RELIABILITY RISK.** No source change is justified without observability evidence. It is not an accepted risk unless the authorized product/operations owner explicitly records that decision.

## Backup and rollback readiness

**Status: BLOCKED pending release-day evidence.** Before migration, capture and verify a restorable database backup containing schema, business data, migration history, and relevant supported auth/profile state. Record backup time, retention location, restoration owner, and a non-production restore verification result. Do not store secrets in this repository.

For application rollback, record the current Worker version ID before deployment, deploy only the exact approved release, and retain the ability to restore that prior Worker version. For database rollback, do not promise down migrations: once live transactions use the new schema, schema rollback can be unsafe. Prefer a narrowly reviewed forward repair; reserve backup restoration for a controlled incident/outage process.

## Release manifest

Delivered: encrypted offline foundation and vault/session security; encrypted catalogue/inventory cache; customer/supplier offline references; encrypted mutation transport; customer create/update; manager supplier create/update; purchase receiving (including serialized receiving and initial payments); adjustment requests/status reconciliation; provisional nonserialized CASH checkout; variant-priority catalogue/inventory model; serialized opening-stock/IMEI model; sellable serialized checkout boundary; serialized and mixed provisional offline CASH checkout.

Deferred: offline discounts, credit, POS, bank-transfer, OTHER and split payments; refunds; unimplemented returns/reversals; pre-replay serialized PURCHASE_RECEIVE-to-sale identity bridge; and Admin offline business cache/mutations.

See [production-release-runbook.md](production-release-runbook.md) for the controlled execution order and smoke plan.
