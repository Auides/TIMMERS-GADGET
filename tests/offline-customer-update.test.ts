import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { assertCustomerUpdateEligible, createCustomerUpdatePayload, parseCustomerUpdatePayload, readCustomerUpdateReviews, readPendingCustomerUpdates, submitCustomerUpdate } from "../src/lib/offline/customer-update.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { EncryptedMutationSyncEngine, enqueueEncryptedMutation } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
const versionA = "2026-10-01T09:00:00.000Z";
const versionB = "2026-10-01T09:01:00.000Z";
let next = 100;
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
  return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("customer-update"))).vaultKey };
}
function payload(expectedVersion = versionA) {
  return createCustomerUpdatePayload({ customerId, fullName: "Ada Updated", phone: "08000000000", email: "ada@example.test", expectedVersion });
}
async function queued(store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>, expectedVersion = versionA) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "CUSTOMER_UPDATE", payload: payload(expectedVersion) }, { createId: nextId, now: () => "2026-10-02T09:00:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("CUSTOMER_UPDATE payload, including the authoritative version, is encrypted and only approved commands are registered", async () => {
  const { store, currentIdentity, record } = await queued();
  assert.doesNotMatch(JSON.stringify(record), /Ada Updated|08000000000|ada@example\.test|2026-10-01T09:00:00\.000Z/);
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE"]);
  assert.deepEqual(await readPendingCustomerUpdates(store, currentIdentity), [{ ...payload(), operationId: record.operationId, state: "PENDING" }]);
});

test("matching server version applies one update and retains the encrypted operation identity", async () => {
  const { store, currentIdentity, record } = await queued();
  let server = { fullName: "Ada Original", version: versionA };
  const replay = async (operation: { payload: Parameters<typeof submitCustomerUpdate>[0]["payload"] }) => {
    const update = parseCustomerUpdatePayload(operation.payload);
    if (server.version !== update.expectedVersion) return { kind: "CONFLICT" as const, reasonCode: "CUSTOMER_UPDATE_CONFLICT" };
    server = { fullName: update.fullName, version: versionB };
    return { kind: "APPLIED" as const };
  };
  const result = await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_UPDATE", replay]]), { now: () => versionA }).synchronize();
  assert.equal(result.applied, 1);
  assert.deepEqual(server, { fullName: "Ada Updated", version: versionB });
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
  assert.equal((await store.getEncryptedMutation(record.operationId))?.idempotencyKey, record.idempotencyKey);
});

test("a stale update becomes a terminal conflict and never overwrites newer server data", async () => {
  const { store, currentIdentity, record } = await queued();
  const server = { fullName: "Changed Online", version: versionB };
  const replay = async () => server.version === versionA ? { kind: "APPLIED" as const } : { kind: "CONFLICT" as const, reasonCode: "CUSTOMER_UPDATE_CONFLICT" };
  const engine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_UPDATE", replay]]), { now: () => versionB });
  const first = await engine.synchronize();
  const second = await engine.synchronize();
  assert.equal(first.conflicted, 1);
  assert.equal(second.processed, 0);
  assert.deepEqual(server, { fullName: "Changed Online", version: versionB });
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "CONFLICT");
  assert.deepEqual(await readCustomerUpdateReviews(store, currentIdentity), [{ customerId, operationId: record.operationId, state: "CONFLICT" }]);
});

test("a response lost after a committed update retries with the same operation and idempotency key", async () => {
  const { store, currentIdentity, record } = await queued();
  const committed = new Map<string, string>();
  let currentVersion = versionA;
  let calls = 0;
  const replay = async (operation: { operationId: string; idempotencyKey: string; payload: Parameters<typeof submitCustomerUpdate>[0]["payload"] }) => {
    calls += 1;
    const update = parseCustomerUpdatePayload(operation.payload);
    if (!committed.has(operation.idempotencyKey)) {
      if (currentVersion !== update.expectedVersion) return { kind: "CONFLICT" as const, reasonCode: "CUSTOMER_UPDATE_CONFLICT" };
      committed.set(operation.idempotencyKey, operation.operationId); currentVersion = versionB;
    }
    return calls === 1 ? { kind: "TRANSIENT" as const } : { kind: "APPLIED" as const };
  };
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_UPDATE", replay]]), { now: () => versionA }).synchronize();
  const retried = await store.getEncryptedMutation(record.operationId);
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_UPDATE", replay]]), { now: () => "2026-10-01T09:01:00.000Z" }).synchronize();
  assert.equal(committed.size, 1);
  assert.equal(retried?.operationId, record.operationId);
  assert.equal(retried?.idempotencyKey, record.idempotencyKey);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});

test("validation and current authorization failures are generic rejections, while a locked vault cannot replay", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "CUSTOMER_UPDATE", payload: payload() };
  assert.deepEqual(await submitCustomerUpdate(operation, async () => new Response(JSON.stringify({ error: "private database detail" }), { status: 422 })), { kind: "REJECTED", reasonCode: "CUSTOMER_UPDATE_REJECTED" });
  assert.deepEqual(await submitCustomerUpdate(operation, async () => new Response(JSON.stringify({ error: "private database detail" }), { status: 403 })), { kind: "REJECTED", reasonCode: "CUSTOMER_UPDATE_REJECTED" });
  const { store, record } = await queued();
  const locked = await new EncryptedMutationSyncEngine(store, () => null, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), registeredOfflineMutationExecutors).synchronize();
  assert.equal(locked.locked, true);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "PENDING");
  const activeIdentity = await identity();
  const unauthorized = await new EncryptedMutationSyncEngine(store, () => activeIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: false }), registeredOfflineMutationExecutors, { now: () => versionA }).synchronize();
  assert.equal(unauthorized.rejected, 1);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.statusCode, "AUTHORIZATION_REJECTED");
});

test("pending-created customers and open customer updates cannot form an unsafe dependency workflow", () => {
  assert.throws(() => assertCustomerUpdateEligible(customerId, [customerId], []), /pending creation/);
  assert.throws(() => assertCustomerUpdateEligible(customerId, [], [customerId]), /already has an offline update/);
  assert.doesNotThrow(() => assertCustomerUpdateEligible(customerId, [], []));
});

test("the snapshot carries the server version and the source-only RPC checks idempotency before stale comparison", () => {
  const readRoute = readFileSync(new URL("../src/app/api/offline/read-snapshot/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20261002090000_phase5_offline_customer_update.sql", import.meta.url), "utf8");
  const initial = readFileSync(new URL("../supabase/migrations/202608290001_initial_schema.sql", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(readRoute, /staff_customer_reference_snapshot_v2/);
  assert.match(readRoute, /customerVersion/);
  assert.match(initial, /customers_updated before update on public\.customers/);
  assert.match(migration, /offline_customer_update_operations/);
  assert.match(migration, /select o\.\* into v_existing[\s\S]*where o\.operation_id = p_operation_id[\s\S]*for update[\s\S]*if found then[\s\S]*return query select v_existing\.customer_id/);
  assert.match(migration, /v_customer\.updated_at is distinct from p_expected_customer_version/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.doesNotMatch(worker, /customer-update|CUSTOMER_UPDATE|outbox|mutation/i);
});
