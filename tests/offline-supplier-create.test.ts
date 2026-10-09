import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { assertSupplierCreateEligible, createSupplierCreatePayload, readPendingSupplierCreates, submitSupplierCreate } from "../src/lib/offline/supplier-create.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { EncryptedMutationSyncEngine, decryptEncryptedMutationPayload, enqueueEncryptedMutation } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const supplierId = "33333333-3333-4333-8333-333333333333";
let next = 200;
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

async function identity() {
  const crypto = createOfflineCryptoService(1);
  return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("supplier-create"))).vaultKey };
}
const payload = () => createSupplierCreatePayload({ businessName: "Acme Supplier", contactName: "Ayo Contact", phone: "08001111111", email: "ayo@example.test" }, supplierId);
async function queued(store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "SUPPLIER_CREATE", payload: payload() }, { createId: nextId, now: () => "2026-10-05T09:00:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("SUPPLIER_CREATE is Manager-only before queueing and has no Staff supplier UI", () => {
  assert.doesNotThrow(() => assertSupplierCreateEligible("MANAGER"));
  assert.throws(() => assertSupplierCreateEligible("STAFF"), /Only Managers/);
  assert.throws(() => assertSupplierCreateEligible("ADMIN"), /Only Managers/);
  const provider = readFileSync(new URL("../src/lib/offline/offline-auth-provider.tsx", import.meta.url), "utf8");
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  assert.match(provider, /assertSupplierCreateEligible\(unlocked\.role\)/);
  assert.match(fallback, /mode === "suppliers" && unlocked\.role !== "MANAGER"/);
});

test("supplier payload and pending projection are encrypted, scoped, and only decrypted while unlocked", async () => {
  const { store, currentIdentity, record } = await queued();
  assert.doesNotMatch(JSON.stringify(record), /Acme Supplier|Ayo Contact|08001111111|ayo@example\.test/);
  assert.deepEqual(await readPendingSupplierCreates(store, currentIdentity), [{ ...payload(), operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingSupplierCreates(store, { ...currentIdentity, deviceId: "44444444-4444-4444-8444-444444444444" }), []);
  const locked = await new EncryptedMutationSyncEngine(store, () => null, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), registeredOfflineMutationExecutors).synchronize();
  assert.equal(locked.locked, true);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "PENDING");
});

test("supplier, operation, and idempotency identities survive a transient retry", async () => {
  const { store, currentIdentity, record } = await queued();
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["SUPPLIER_CREATE", async () => ({ kind: "TRANSIENT" as const })]]), { now: () => "2026-10-05T09:00:00.000Z" }).synchronize();
  const retried = await store.getEncryptedMutation(record.operationId);
  assert.equal(retried?.operationId, record.operationId);
  assert.equal(retried?.idempotencyKey, record.idempotencyKey);
  assert.equal((await decryptEncryptedMutationPayload(currentIdentity, retried!) as { supplierId: string }).supplierId, supplierId);
});

test("network ambiguity commits at most once and a retry becomes APPLIED", async () => {
  const { store, currentIdentity, record } = await queued();
  const committed = new Map<string, string>();
  let calls = 0;
  const replay = async (operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: Parameters<typeof submitSupplierCreate>[0]["payload"] }) => submitSupplierCreate(operation, async (_url, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { idempotencyKey: string; supplierId: string };
    const result = committed.get(request.idempotencyKey) ?? request.supplierId;
    committed.set(request.idempotencyKey, result);
    if (calls === 1) throw new Error("response lost after commit");
    return new Response(JSON.stringify({ supplierId: result }), { status: 200 });
  });
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["SUPPLIER_CREATE", replay]]), { now: () => "2026-10-05T09:00:00.000Z" }).synchronize();
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["SUPPLIER_CREATE", replay]]), { now: () => "2026-10-05T09:01:00.000Z" }).synchronize();
  assert.equal(committed.size, 1);
  assert.equal(committed.get(record.idempotencyKey), supplierId);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});

test("validation, role loss, deactivation, and business conflicts become generic terminal outcomes", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "SUPPLIER_CREATE", payload: payload() };
  assert.deepEqual(await submitSupplierCreate(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 422 })), { kind: "REJECTED", reasonCode: "SUPPLIER_CREATE_REJECTED" });
  assert.deepEqual(await submitSupplierCreate(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 403 })), { kind: "REJECTED", reasonCode: "SUPPLIER_CREATE_REJECTED" });
  assert.deepEqual(await submitSupplierCreate(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 409 })), { kind: "CONFLICT", reasonCode: "SUPPLIER_CREATE_CONFLICT" });
  const { store, currentIdentity, record } = await queued();
  const result = await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: false }), registeredOfflineMutationExecutors, { now: () => "2026-10-05T09:00:00.000Z" }).synchronize();
  assert.equal(result.rejected, 1);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.statusCode, "AUTHORIZATION_REJECTED");
});

test("the source-only server boundary is Manager-only, durable, audited, and preserves existing duplicate semantics", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261005090000_phase6a_offline_supplier_create.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/offline/mutations/supplier-create/route.ts", import.meta.url), "utf8");
  assert.match(migration, /offline_supplier_create_operations/);
  assert.match(migration, /idempotency_key uuid not null unique/);
  assert.match(migration, /on conflict \(operation_id\) do nothing/);
  assert.match(migration, /for update/);
  assert.match(migration, /v_role is distinct from 'MANAGER'/);
  assert.match(migration, /perform public\.procurement_audit/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.doesNotMatch(migration, /unique\s*\(business_name\)|unique\s*\(phone\)|unique\s*\(email\)/i);
  assert.match(route, /profile\.role !== "MANAGER"/);
});

test("only the seven approved commands are registered; legacy outbox and service worker never receive supplier payloads", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE", "SALE_CHECKOUT"]);
  const database = readFileSync(new URL("../src/lib/offline/db.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(database.slice(0, database.indexOf("encryptedMutationOutbox")), /SUPPLIER_CREATE|Acme Supplier/i);
  assert.doesNotMatch(worker, /supplier-create|SUPPLIER_CREATE|outbox|mutation/i);
});

test("pending supplier UI stays distinct from authoritative snapshot and synchronization refreshes encrypted references", () => {
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  const provider = readFileSync(new URL("../src/lib/offline/offline-auth-provider.tsx", import.meta.url), "utf8");
  assert.match(fallback, /Authoritative cached record/);
  assert.match(fallback, /Pending synchronization/);
  assert.match(fallback, /Not yet confirmed by the server/);
  assert.match(fallback, /Add supplier offline/);
  assert.match(provider, /readPendingSupplierCreates/);
  assert.match(provider, /result\.applied > 0/);
  assert.match(provider, /refreshOfflineReadCache/);
});
