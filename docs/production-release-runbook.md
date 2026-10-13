# Controlled production release runbook — offline-v2

This runbook is deliberately non-executable preparation documentation. It authorizes no action by itself. Use it only in the approved release window, with an authorized operator, against Supabase project `wugmcqtyiknqobjqwhno` and Worker `timmers-gadget`.

## Stop conditions

Stop and declare **NO-GO** if the commit/branch changes, any quality gate fails, remote migration history differs unexpectedly, data preflight reveals a blocker, backup evidence is missing, the target identity cannot be proven, or the 1102 risk has not been resolved or formally accepted by the appropriate owner. Never repair data ad hoc in this window.

## Ordered release procedure

1. Verify the exact release candidate locally:
   ```text
   git branch --show-current
   git rev-parse HEAD
   git status --short
   ```
   Required: `recovery/offline-v2`, `f3d6ee1a8caa43fdb9d8a80ac83bf16af9e273bf`, and no output from status.
2. Verify the repository is clean and the release owner, database operator, application operator, rollback owner, and decision owner are recorded for the controlled release window.
3. Re-run the exact gates:
   ```text
   npm test
   npm run lint
   npm run build
   npm run build:vinext
   git diff --check
   ```
4. Independently confirm the selected Supabase project is exactly `wugmcqtyiknqobjqwhno`. Do not relink this repository and do not use any other project.
5. Verify backup/restore readiness before change. Capture schema, business data, migration history, and supported auth/profile state; record location, timestamp, recovery owner, and non-production restore-test evidence outside source control.
6. In Cloudflare, verify the authenticated account context and record the current version of Worker `timmers-gadget`. Do not deploy yet.
7. Verify production migration history using the read-only procedure in [production-release-preflight.md](production-release-preflight.md). Record project identity and history outcome, not sensitive raw data.
8. Run the general read-only production data preflight in [production-release-preflight.md](production-release-preflight.md). Record counts/outcomes, not sensitive raw data.
9. Run the approved read-only serialized-unit integrity preflight described in [production-release-preflight.md](production-release-preflight.md). It must inspect duplicate identifiers, identifier types, orphan/inconsistent rows, probable physical-unit duplicates, physical counts, provenance, and data-caused search duplication.
10. Review duplicate and probable-duplicate findings. Classify each SAFE, WARNING, or BLOCKER. Do not merge/delete data automatically.
11. Resolve every BLOCKER before migration, and obtain an explicit authorized decision for any remaining risk. Keep **1102** visible as an unresolved reliability risk unless observability evidence closes it or the appropriate owner accepts it.
12. Apply the 15 migrations, once, in this exact chronological order through the approved Supabase production migration process:
   1. `20260930082955_staff_serialized_inventory_snapshot.sql`
   2. `20260930163023_phase4_offline_customer_supplier_reference_snapshots.sql`
   3. `20261001090000_phase5_offline_customer_create.sql`
   4. `20261002090000_phase5_offline_customer_update.sql`
   5. `20261005090000_phase6a_offline_supplier_create.sql`
   6. `20261005100000_phase6b_offline_supplier_update.sql`
   7. `20261006100000_phase6c_offline_purchase_receive.sql`
   8. `20261006110000_phase6cc_offline_serialized_purchase_receive.sql`
   9. `20261006122959_phase6cd_offline_purchase_receive_payments.sql`
   10. `20261007152918_phase7a_offline_inventory_adjustment_request.sql`
   11. `20261008091725_phase7ac_offline_adjustment_request_reconciliation.sql`
   12. `20261009080116_phase7bb_provisional_offline_cash_checkout.sql`
   13. `20261010140321_phase7_variant_inventory_checkout_alignment.sql`
   14. `20261012110000_phase7bc_serialized_provisional_offline_checkout.sql`
   15. `20261013123309_phase7bd_serialized_unit_integrity_preflight.sql`
13. Verify the post-migration RPCs, grants/revokes, schema constraints, RLS, `quote_revision`/trigger, variant guards, the post-#13 legacy-inventory report, and the persisted serialized-integrity report. No migration gap or unexpected remote migration is acceptable.
14. Build and deploy only exact commit `f3d6ee1a8caa43fdb9d8a80ac83bf16af9e273bf` using the approved Vinext Worker configuration. Capture the new version ID and deployment timestamp. Do not change DNS, secrets, CPU limits, or unrelated Worker configuration.
15. Run the smoke checklist below against `https://timmers-gadget.timmersgadget.workers.dev/app` using approved non-sensitive test records.
16. Inspect Worker logs/observability after smoke tests, specifically for 1102, recording only safe operational metadata.
17. Make the GO decision only if all required checks pass. If application rollback is necessary before incompatible writes, restore the recorded prior Worker version. Do not attempt an unreviewed database rollback; favor forward repair, or use the tested backup-restoration incident process.

## Production smoke checklist

### Authentication

- Admin, Manager, and Staff authenticate correctly; a deactivated user is rejected; logout invalidates the application session.

### Catalogue and inventory

- Base-price and variant-price catalogue paths work; variant switch deactivates active base price and leaves intended active variant price.
- Nonserialized and serialized inventory render correctly; variant selection, serialized opening stock, IMEI entry, and duplicate-identifier rejection behave safely.
- A Staff user cannot obtain acquisition cost, WAC, COGS, or supplier financial data.

### Purchase and online sale

- Test nonserialized, variant, and serialized receiving, including initial payment and resulting inventory.
- Test online nonserialized, exact serialized-unit, and mixed sales; CASH and already-supported online payment options; then verify stock decrement/SOLD state and sale receipt/history.

### Offline behavior

- PWA start-up, vault unlock, and encrypted cache work without plaintext exposure.
- Test customer create/update, Manager supplier create/update, purchase receive, and adjustment request replay.
- Test nonserialized, serialized, and mixed provisional CASH sales; verify same-device serialized reservation, reconnect/replay, conflict behavior, authoritative refresh, no false SOLD before replay, and no false confirmed sale before replay.
- Confirm the deferred payment/discount/credit/refund flows remain unavailable offline.

### Security and platform behavior

- Confirm Admin offline business cache remains unavailable.
- Confirm the service worker does not cache authenticated `/app` HTML.
- Watch for 1102 throughout, then inspect logs immediately afterward.

## Release record minimum

Record the release window, responsible operators, commit, test outputs, project identity, remote migration history before/after, data-preflight counts, backup identifier and restore proof, incumbent/new Worker versions, smoke results, observability/1102 finding, GO/NO-GO decision, and any rollback action. Keep credentials, tokens, cookies, IMEIs, customer PII, acquisition costs, and raw mutation payloads out of the record.
