# Production release preflight — offline-v2

## Release identity

| Item | Required value | Status on 2026-10-15 |
| --- | --- | --- |
| Application commit | `0c465ec946bffc70aeec06f0af2cc70bc64061ee` | verified locally; authenticated Worker CPU reduction |
| Branch | `recovery/offline-v2` | verified locally |
| Supabase project ref | `wugmcqtyiknqobjqwhno` | release-day verification required |
| Worker | `timmers-gadget` | source configuration verified |
| Application URL | `https://timmers-gadget.timmersgadget.workers.dev/app` | smoke-test target |

This document is a preparation artifact, not permission to migrate or deploy. The release is **NO-GO — pending controlled migration/release canary execution** and the remaining release-day checks. The database backup gate is now satisfied; the Cloudflare canary remains required and must not be marked PASS until it completes successfully.

## Validated local baseline

The release candidate completed the local quality gate with **160 project tests** and **111 offline tests** passing. `npm run lint`, `npm run build`, `npm run build:vinext`, and `git diff --check` also passed. The offline mutation registry remains exactly **seven** commands. These are local-source results, not production evidence.

## Pending migration order and source dependency audit

The repository contains the following 16 source-only migrations after the existing sales baseline. Apply them only in this exact filename order. A later `CREATE OR REPLACE` is an intentional replacement, not a reason to omit its predecessor.

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
| 15 | `20261013123309_phase7bd_serialized_unit_integrity_preflight.sql` | Manager/Admin-gated serialized-unit integrity report | source-only, unapplied, read-only diagnostic; no automatic cleanup or merge | SAFE preflight evidence; persisted report remains unapplied |
| 16 | `20261013213939_phase7be_grouped_serialized_unit_lookups.sql` | versioned grouped generic/sellable lookup and both serialized snapshot projections | source-only, unapplied; hardened SECURITY DEFINER `pg_catalog, pg_temp`; authenticated-only grants; preserves v1 signatures for migration-first compatibility | SAFE source repair; production application rollout must use v2 callers |

Static source result: filename chronology is safe; no later migration is required before an earlier one executes. All new operation tables are RLS-enabled and direct browser table access is revoked. Newer SECURITY DEFINER functions explicitly use `pg_catalog, pg_temp`, authenticate/authorize within the function, and revoke default PUBLIC/anon access before granting `authenticated` where appropriate. Migration #16 uses versioned grouped read projections rather than rewriting incumbent RPC signatures. The two early, read-only snapshot functions are explicit but use `public, pg_temp`; do not rewrite applied migration history during this release.

## Serialized-unit source finding and release preflight

Current authoritative source behavior is one physical serialized unit with many identifiers attached to that same unit: `U1` may have one IMEI1, one IMEI2, and one serial. The authoritative opening-stock and purchase-receipt SQL inserts the unit once, then loops over identifiers for that unit; it does not intentionally create one physical unit per identifier.

The approved production read-only preflight confirmed **10 physical serialized units** and **18 identifier rows**: 3 units have 1 identifier, 6 have 2 identifiers, and 1 has 3 identifiers. The observed repeated lookup results are therefore **lookup-cardinality presentation defects, not duplicate physical-unit data**. Migration #16 creates grouped v2 read projections that return one unit record with an ordered nested `identifiers` collection before any generic-lookup limit is applied.

The release candidate adds normalized identifier validation, per-unit identifier-type uniqueness, per-unit identifier-value uniqueness, receipt-wide normalized identifier-value uniqueness, and earlier safe rejection in opening stock and offline `PURCHASE_RECEIVE`. It adds no business mutation or automatic cleanup.

**Serialized unit integrity is a release blocker until an authorized read-only preflight classifies every finding.** Before applying migrations, run an approved source-equivalent read-only inspection against the existing tables that determines:

- duplicate normalized identifier values;
- multiple identifier rows of the same type attached to a unit;
- orphaned or inconsistent identifier rows;
- probable duplicate physical serialized units and inconsistent serialized physical counts;
- suspicious creation/request provenance where the historical schema provides it; and
- checkout/search duplication caused by data rather than source code.

Classify zero findings as **SAFE**, investigable ambiguity as **WARNING**, and duplicate/inconsistent data that can invalidate an invariant or guard as **BLOCKER**. Do not merge or delete any row automatically; cleanup needs separate explicit approval.

Migration #15 persists a restricted, read-only integrity report for post-application verification; it is not a business mutation and performs no cleanup. It cannot substitute for the required pre-migration source-equivalent query because the function does not exist in production until #15 is applied. The approved pre-migration review has now run with the recorded zero-count results below.

### Confirmed production integrity preflight results

All of the following approved read-only checks returned **0**: duplicate opening-stock groups; units without identifiers; purchase overage; ambiguous origins; active variant plus active base price; variant-less stock buckets in variant mode; variant-less serialized units in variant mode; variant/product mismatches; available units on inactive products; available units on inactive variants; active prices on inactive variants; stock-bucket variant mismatch; active prices on inactive products; active variants without active price; unsupported roles; active profiles without auth users; negative stock buckets; serialized units on nonserialized products; and orphaned catalogue prices.

## Data compatibility — release-day, read-only only

The initial preparation did not read production data. The subsequently approved read-only preflight produced the zero-count results recorded above and the 10-unit/18-identifier distribution. Before applying migrations, an authorized operator must preserve that evidence or rerun the following in a read-only SQL session against **only** `wugmcqtyiknqobjqwhno`. Keep any row-level output private; record counts and opaque IDs only in the release record.

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

Classification rule: any duplicate identifier, duplicate identifier type on one unit, orphan/inconsistent identifier relationship, probable duplicate physical unit, broken foreign relationship, malformed authorization record, or data condition that prevents a required guard from being applied is a **BLOCKER**. Variant-mode legacy inventory and provenance ambiguity are at least a **WARNING** and require an approved handling plan before affected sale/receipt activity. Zero rows for all queries is **SAFE**.

## Production migration history — required evidence

Preparation could not authenticate the read-only Supabase CLI: the attempt to list migrations for the explicit project ref failed while initialising its login role with `LegacyDbConfigLoginRoleNetworkError: TransportError`. No SQL was run. On release day, in an authorized environment, run:

```text
npx supabase migration list --linked --project-ref wugmcqtyiknqobjqwhno
```

Capture the project identity and compare remote history to the repository sequence. It must prove that the historical baseline is present, none of the 16 pending migrations were unexpectedly applied, and there are no remote-only migrations or gaps. If the command would relink the repository, stop; do not use it. An authenticated operator may instead use the Supabase dashboard's migration-history view for the same project.

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

The tracked `wrangler.jsonc` targets Worker `timmers-gadget`, with the Vinext output handler and `nodejs_compat`; `package.json` defines the approved deployment command as `npm run deploy:vinext`.

Production evidence identifies current Worker `timmers-gadget`, version `f3ce35d6-7836-48ae-b9e5-9c439eab80d2`, serving 100% of traffic. The deployment page reported median CPU time of **28.94 ms**. Workers observability recorded **322** confirmed `Worker exceeded CPU time limit.` events in the preceding seven days:

| Route | Confirmed CPU-limit events |
| --- | ---: |
| `/app/catalogue` | 86 |
| `/app/inventory` | 74 |
| `/app` | 35 |
| `/app/catalogue/REDACTED` | 33 |
| `/app/inventory/adjustments` | 26 |
| `/app/suppliers` | 17 |
| `/app/sales/new` | 15 |
| `/app/purchases` | 14 |
| `/app/inventory/opening-stock` | 12 |
| `/app/sales` | 7 |
| `/app/catalogue/new` | 2 |
| `/app/inventory/serialized` | 1 |
| **Total** | **322** |

Source investigation confirmed that protected requests previously resolved authentication/profile state in the proxy, `/app` layout, and route page. The repair in `src/lib/auth.ts` keeps proxy authorization unchanged while allowing the layout and page to share one request-scoped React `cache()` resolution. It introduces no cross-request or persistent authentication cache. Duplicate auth/profile work is **CONFIRMED**; its contribution to CPU pressure is **SUPPORTED**; it is **NOT PROVEN** to be the sole cause of production 1102 events.

**Cloudflare gate: CANARY REQUIRED. Do not mark this gate PASS.** Once every other release blocker is cleared, perform a controlled canary and compare CPU time, CPU-limit/1102 events, error rate, and request behavior for `/app`, `/app/catalogue`, `/app/inventory`, `/app/purchases`, `/app/inventory/adjustments`, `/app/suppliers`, and `/app/sales/new`. Record safe operational metadata only; never record credentials, cookies, identifiers, personal data, costs, or raw mutation payloads.

## Backup and rollback readiness

**Backup gate: PASS — verified manual logical backup available.** A manual logical PostgreSQL backup of production project `wugmcqtyiknqobjqwhno` was validated on **2026-10-15 10:57:59 +01:00**. It represents application RC `0c465ec946bffc70aeec06f0af2cc70bc64061ee`, documentation HEAD `53e12f1dce494c716dd7d1716de2b4dc438e1f0f`, and production migration baseline `20260915054500`.

The backup is retained outside the repository at `C:\TIMMERS-BACKUPS\pre-release-20261015-000639`. It contains sensitive production and Auth data and must remain securely retained; it was not staged, committed, or uploaded. `manifest.txt` exists and records the backup metadata and hashes.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `roles.sql` | 7,679 | `AFFB4BB4B6CA66BC6885E20D0D7992083FB2FFE5BF6EA361D4C66577E5126E7D` |
| `schema.sql` | 487,401 | `9311DCA6B13E33490B3B8C00D7EEDB1B1B50F798F9F12A2B38971063FC30D29C` |
| `data.sql` | 142,035 | `384313AEEE9E67AE80A9AA0486B0B293EA79F505DD8E3FA0E88089299AD76F0F` |
| `history_schema.sql` | 1,294 | `191E416D53D93CA6849A120E5D0D16489125819038C18B8DDFB7EFE8FC1DB15F` |
| `history_data.sql` | 412,875 | `57E5DBA88BDE02445026876735139F0D213DD1BE50FA235AB06E24A2690BEB7C` |
| `auth_data.sql` | 27,651 | `9EEBDDDC987A4E9E9EE79AC7F87DE28EF6CA6D5225BE1731B641B9B20E94EB4A` |

Production evidence at backup time: 4 Auth users, 0 Storage buckets, and 0 Storage objects. No project migration creates or alters custom objects in the managed `auth` or `storage` schemas; project migrations reference `auth.users` and `auth.uid()` only as expected.

Backup handling confirmation: the repository remained clean; the production DB URI was removed from the clipboard and PowerShell environment after backup; no restore was executed; no migration was applied; no production mutation SQL was executed; nothing was pushed; and nothing was deployed.

### Restore readiness

**RESTORE DRILL NOT PERFORMED.** No destructive restore drill is claimed.

If recovery is required, the controlled logical-restore strategy is to:

1. Provision or prepare a controlled target database/project.
2. Restore required roles where appropriate.
3. Restore the application schema.
4. Restore public business data.
5. Restore Supabase migration-history schema/data as required.
6. Restore Auth data carefully into a compatible Supabase-managed `auth` schema.
7. Validate application, profile, and Auth relationships.
8. Reconfigure external project-specific settings when restoring into a new project.
9. Treat Worker rollback and database recovery as separate actions; Worker rollback is not database rollback.

After live writes, preferred incident response remains forward repair where safe; otherwise use controlled logical restore/recovery. Do not promise down migrations as a database rollback mechanism.

## Release manifest

Delivered: encrypted offline foundation and vault/session security; encrypted catalogue/inventory cache; customer/supplier offline references; encrypted mutation transport; customer create/update; manager supplier create/update; purchase receiving (including serialized receiving and initial payments); adjustment requests/status reconciliation; provisional nonserialized CASH checkout; variant-priority catalogue/inventory model; serialized opening-stock/IMEI model; sellable serialized checkout boundary; serialized and mixed provisional offline CASH checkout; serialized identifier input hardening; the one-physical-unit/multiple-identifiers invariant; early duplicate normalized identifier rejection; a serialized-integrity release preflight; and grouped v2 serialized lookup/snapshot projections that preserve one physical-unit card with all identifiers.

Deferred: offline discounts, credit, POS, bank-transfer, OTHER and split payments; refunds; unimplemented returns/reversals; pre-replay serialized PURCHASE_RECEIVE-to-sale identity bridge; and Admin offline business cache/mutations.

See [production-release-runbook.md](production-release-runbook.md) for the controlled execution order and smoke plan.
