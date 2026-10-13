# Controlled production release runbook — offline-v2

This runbook is deliberately non-executable preparation documentation. It authorizes no action by itself. Use it only in the approved release window, with an authorized operator, against Supabase project `wugmcqtyiknqobjqwhno` and Worker `timmers-gadget`.

## Stop conditions

Stop and declare **NO-GO** if the commit/branch changes, any quality gate fails, remote migration history differs unexpectedly, data preflight reveals a blocker, backup evidence is missing, the target identity cannot be proven, or the 1102 risk has not been resolved or formally accepted by the appropriate owner. Never repair data ad hoc in this window.

## Ordered release procedure

0. Begin a controlled release window. Name the release owner, database operator, application operator, rollback owner, and decision owner. Record the intended commit and the incumbent Worker version.
1. Verify release identity locally:
   ```text
   git branch --show-current
   git rev-parse HEAD
   git status --short
   ```
   Required: `recovery/offline-v2`, `c1d96718b3b0a4bdd3e5f63b0a47ec0f0426f9e4`, and no output from status.
2. Re-run the exact gates:
   ```text
   npm test
   npm run lint
   npm run build
   npm run build:vinext
   git diff --check
   ```
3. Independently verify the selected Supabase project is exactly `wugmcqtyiknqobjqwhno`. Do not relink this repository and do not use any other project.
4. Capture the database backup and its restoration evidence before change. Include schema, business data, migration history, and supported auth/profile state. Record location, timestamp, recovery owner, and restore-test result outside source control.
5. In Cloudflare, verify the authenticated account context, then record the current version of Worker `timmers-gadget`. Do not deploy yet.
6. Run the read-only migration-history and data procedure in [production-release-preflight.md](production-release-preflight.md). Record counts/outcomes, not sensitive raw data.
7. Resolve every blocker, and obtain an explicit authorized decision for any remaining risk. Keep **1102** visible as an unresolved reliability risk unless observability evidence closes it or the appropriate owner accepts it.
8. Apply the 14 migrations, once, in this exact chronological order through the approved Supabase production migration process:
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
9. Re-check remote migration history; inspect the introduced RPCs, grants/revokes, RLS, `quote_revision`/trigger, variant guards, and post-#13 legacy-inventory report. No migration gap or unexpected remote migration is acceptable.
10. Build exactly commit `c1d96718b3b0a4bdd3e5f63b0a47ec0f0426f9e4`; do not build uncommitted code.
11. Deploy only Worker `timmers-gadget` using the approved Vinext deployment configuration. Capture the new version ID and deployment timestamp. Do not change DNS, secrets, CPU limits, or unrelated Worker configuration.
12. Run the smoke checklist below against `https://timmers-gadget.timmersgadget.workers.dev/app` using approved non-sensitive test records.
13. Inspect Worker logs/observability after smoke tests, specifically for 1102, recording only safe operational metadata.
14. Make the GO decision only if all required checks pass. If application rollback is necessary before incompatible writes, restore the recorded prior Worker version. Do not attempt an unreviewed database rollback; favor forward repair, or use the tested backup-restoration incident process.

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
