import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { assertSupplierUpdateEligible, createSupplierUpdatePayload, readPendingSupplierUpdates, readSupplierUpdateReviews, submitSupplierUpdate } from "../src/lib/offline/supplier-update.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { EncryptedMutationSyncEngine, decryptEncryptedMutationPayload, enqueueEncryptedMutation } from "../src/lib/offline/mutation-transport.ts";
import type { MutationExecutor } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const supplierId = "33333333-3333-4333-8333-333333333333";
let next = 300;
const nextId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;

class MemoryStore implements EncryptedMutationStore {
  readonly records = new Map<string, EncryptedMutationEnvelope>();
  readonly conflicts = new Map<string, EncryptedMutationConflict>();
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async getEncryptedMutation(operationId: string) { return this.records.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async listEncryptedMutations(user: string, device: string) { return [...this.records.values()].filter((record) => record.userId === user && record.deviceId === device); }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { this.conflicts.set(conflict.operationId, conflict); }
  async listEncryptedMutationConflicts(user: string, device: string) { return [...this.conflicts.values()].filter((record) => record.userId === user && record.deviceId === device); }
}

async function identity() { const crypto = createOfflineCryptoService(1); return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("supplier-update"))).vaultKey }; }
const payload = () => createSupplierUpdatePayload({ supplierId, businessName: "Acme Supplier", contactName: "Ayo Contact", phone: "08001111111", email: "ayo@example.test", expectedVersion: "2026-10-05T09:00:00.000Z" });
async function queued(store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "SUPPLIER_UPDATE", payload: payload() }, { createId: nextId, now: () => "2026-10-05T09:30:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("SUPPLIER_UPDATE remains fourth in the six-command registered set", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE"]);
  const provider = readFileSync(new URL("../src/lib/offline/offline-auth-provider.tsx", import.meta.url), "utf8");
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  assert.match(provider, /assertSupplierCreateEligible\(unlocked\.role\)/);
  assert.match(fallback, /mode === "suppliers" && unlocked\.role !== "MANAGER"/);
});

test("supplier update payload is encrypted, user/device-scoped, and carries only the server snapshot token", async () => {
  const { store, currentIdentity, record } = await queued();
  assert.doesNotMatch(JSON.stringify(record), /Acme Supplier|Ayo Contact|08001111111|ayo@example\.test|2026-10-05T09:00:00/);
  assert.deepEqual(await readPendingSupplierUpdates(store, currentIdentity), [{ ...payload(), operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingSupplierUpdates(store, { ...currentIdentity, deviceId: "44444444-4444-4444-8444-444444444444" }), []);
  assert.equal((await decryptEncryptedMutationPayload(currentIdentity, record) as { expectedVersion: string }).expectedVersion, payload().expectedVersion);
});

test("a pending supplier create or PENDING/SYNCING/CONFLICT update blocks another edit", () => {
  assert.throws(() => assertSupplierUpdateEligible(supplierId, [supplierId], []), /pending creation/);
  assert.throws(() => assertSupplierUpdateEligible(supplierId, [], [supplierId]), /already has an offline update/);
  assert.doesNotThrow(() => assertSupplierUpdateEligible(supplierId, [], []));
});

test("review projection treats conflict state as open while retaining encrypted pending proposals", async () => {
  const { store, currentIdentity, record } = await queued();
  await store.updateEncryptedMutation({ ...(await store.getEncryptedMutation(record.operationId))!, state: "CONFLICT" });
  assert.deepEqual(await readPendingSupplierUpdates(store, currentIdentity), []);
  assert.deepEqual(await readSupplierUpdateReviews(store, currentIdentity), [{ supplierId, operationId: record.operationId, state: "CONFLICT" }]);
});

test("network ambiguity can commit once and retry to APPLIED without a false conflict", async () => {
  const { store, currentIdentity, record } = await queued();
  const committed = new Set<string>(); let calls = 0;
  const replay: MutationExecutor = async (operation) => submitSupplierUpdate(operation, async (_url, init) => {
    calls += 1; const request = JSON.parse(String(init?.body)) as { idempotencyKey: string };
    committed.add(request.idempotencyKey); if (calls === 1) throw new Error("response lost after commit");
    return new Response(JSON.stringify({ supplierId }), { status: 200 });
  });
  const authorization = async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true });
  let syncNow = "2026-10-05T09:30:00.000Z";
const syncDependencies = { now: () => syncNow };

await new EncryptedMutationSyncEngine(
  store,
  () => currentIdentity,
  authorization,
  new Map([["SUPPLIER_UPDATE", replay]]),
  syncDependencies,
).synchronize();

syncNow = "2026-10-05T09:30:11.000Z";

await new EncryptedMutationSyncEngine(
  store,
  () => currentIdentity,
  authorization,
  new Map([["SUPPLIER_UPDATE", replay]]),
  syncDependencies,
).synchronize();
  assert.equal(committed.size, 1); assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});

test("safe terminal and transient supplier-update outcomes never expose database detail", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "SUPPLIER_UPDATE", payload: payload() };
  assert.deepEqual(await submitSupplierUpdate(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 409 })), { kind: "CONFLICT", reasonCode: "SUPPLIER_UPDATE_CONFLICT" });
  assert.deepEqual(await submitSupplierUpdate(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 422 })), { kind: "REJECTED", reasonCode: "SUPPLIER_UPDATE_REJECTED" });
  assert.deepEqual(await submitSupplierUpdate(operation, async () => new Response("", { status: 503 })), { kind: "TRANSIENT", statusCode: "SUPPLIER_UPDATE_TRANSIENT" });
});

test("source-only server update is manager-only, versioned, idempotent before stale comparison, and audited", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261005100000_phase6b_offline_supplier_update.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/offline/mutations/supplier-update/route.ts", import.meta.url), "utf8");
  assert.match(migration, /offline_supplier_update_operations/);
  assert.match(migration, /expected_supplier_version timestamptz not null/);
  assert.match(migration, /v_role is distinct from 'MANAGER'/);
  assert.match(migration, /where o\.operation_id = p_operation_id\s+for update[\s\S]*v_supplier\.updated_at is distinct from p_expected_supplier_version/);
  assert.match(migration, /on conflict do nothing/);
  assert.match(migration, /perform public\.procurement_audit/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(route, /profile\.role !== "MANAGER"/);
  assert.match(route, /p_expected_supplier_version/);
});

test("server preserves active/archive semantics and does not add duplicate supplier identity rules", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261005100000_phase6b_offline_supplier_update.sql", import.meta.url), "utf8");
  assert.match(migration, /if not v_supplier\.active and v_business_name is distinct from v_supplier\.business_name/);
  assert.match(migration, /case when s\.active then v_business_name else s\.business_name end/);
  assert.doesNotMatch(migration, /unique\s*\(business_name\)|unique\s*\(phone\)|unique\s*\(email\)/i);
});

test("supplier UI keeps authoritative cache distinct from proposed edit and does not use the legacy outbox", () => {
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  const database = readFileSync(new URL("../src/lib/offline/db.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(fallback, /Authoritative cached record/);
  assert.match(fallback, /Proposed offline edit/);
  assert.match(fallback, /Needs review after reconnect/);
  assert.match(fallback, /editing is unavailable until it is confirmed/);
  assert.doesNotMatch(database.slice(0, database.indexOf("encryptedMutationOutbox")), /SUPPLIER_UPDATE/i);
  assert.doesNotMatch(worker, /supplier-update|SUPPLIER_UPDATE|outbox|mutation/i);
});
