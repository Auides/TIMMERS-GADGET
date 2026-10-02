import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { createCustomerCreatePayload, readPendingCustomerCreates, submitCustomerCreate } from "../src/lib/offline/customer-create.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { EncryptedMutationSyncEngine, decryptEncryptedMutationPayload, enqueueEncryptedMutation } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
let next = 0;
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
  return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("customer-create"))).vaultKey };
}
const payload = () => createCustomerCreatePayload({ fullName: "Ada Customer", phone: "08000000000", email: "ada@example.test" }, customerId);
async function queued(store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "CUSTOMER_CREATE", payload: payload() }, { createId: nextId, now: () => "2026-10-01T09:00:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("CUSTOMER_CREATE payload and pending projection remain encrypted at rest", async () => {
  const { store, currentIdentity, record } = await queued();
  assert.doesNotMatch(JSON.stringify(record), /Ada Customer|08000000000|ada@example\.test/);
  const pending = await readPendingCustomerCreates(store, currentIdentity);
  assert.deepEqual(pending, [{ ...payload(), operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingCustomerCreates(store, { ...currentIdentity, deviceId: "44444444-4444-4444-8444-444444444444" }), []);
});

test("customer, operation, and idempotency identities survive a transient retry", async () => {
  const { store, currentIdentity, record } = await queued();
  const engine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", async () => ({ kind: "TRANSIENT" as const })]]), { now: () => "2026-10-01T09:00:00.000Z" });
  await engine.synchronize();
  const retried = await store.getEncryptedMutation(record.operationId);
  assert.equal(retried?.operationId, record.operationId);
  assert.equal(retried?.idempotencyKey, record.idempotencyKey);
  assert.equal((await decryptEncryptedMutationPayload(currentIdentity, retried! ) as { customerId: string }).customerId, customerId);
});

test("the authenticated replay boundary classifies success, validation/rejection, and conflicts without raw errors", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "CUSTOMER_CREATE", payload: payload() };
  assert.deepEqual(await submitCustomerCreate(operation, async () => new Response(JSON.stringify({ customerId }), { status: 200 })), { kind: "APPLIED" });
  assert.deepEqual(await submitCustomerCreate(operation, async () => new Response(JSON.stringify({ code: "private database detail" }), { status: 403 })), { kind: "REJECTED", reasonCode: "CUSTOMER_CREATE_REJECTED" });
  assert.deepEqual(await submitCustomerCreate(operation, async () => new Response(JSON.stringify({ code: "private database detail" }), { status: 409 })), { kind: "CONFLICT", reasonCode: "CUSTOMER_CREATE_CONFLICT" });
});

test("network ambiguity retries the same request and a durable idempotency server returns the original customer", async () => {
  const { store, currentIdentity, record } = await queued();
  const committed = new Map<string, string>();
  let calls = 0;
  const replay = async (operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: Parameters<typeof submitCustomerCreate>[0]["payload"] }) => submitCustomerCreate(operation, async (_url, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { idempotencyKey: string; customerId: string };
    const result = committed.get(request.idempotencyKey) ?? request.customerId;
    committed.set(request.idempotencyKey, result);
    if (calls === 1) throw new Error("response lost after commit");
    return new Response(JSON.stringify({ customerId: result }), { status: 200 });
  });
  const first = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", replay]]), { now: () => "2026-10-01T09:00:00.000Z" });
  await first.synchronize();
  const second = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", replay]]), { now: () => "2026-10-01T09:01:00.000Z" });
  await second.synchronize();
  assert.equal(committed.size, 1);
  assert.equal(committed.get(record.idempotencyKey), customerId);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});

test("current inactive server authorization rejects pending customer creation without decrypting or applying it", async () => {
  const { store, currentIdentity, record } = await queued();
  const result = await new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: false }), registeredOfflineMutationExecutors, { now: () => "2026-10-01T09:00:00.000Z" }).synchronize();
  assert.equal(result.rejected, 1);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.statusCode, "AUTHORIZATION_REJECTED");
});

test("the phase registers only CUSTOMER_CREATE and CUSTOMER_UPDATE, keeps legacy outbox unused, and excludes service-worker replay", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE"]);
  const database = readFileSync(new URL("../src/lib/offline/db.ts", import.meta.url), "utf8");
  assert.match(database, /encryptedMutationOutbox/);
  assert.doesNotMatch(database.slice(0, database.indexOf("encryptedMutationOutbox")), /CUSTOMER_CREATE/);
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /customer-create|CUSTOMER_CREATE|outbox|mutation/i);
});

test("the source-only replay boundary has durable server idempotency and no new duplicate contact policy", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261001090000_phase5_offline_customer_create.sql", import.meta.url), "utf8");
  assert.match(migration, /offline_customer_create_operations/);
  assert.match(migration, /idempotency_key uuid not null unique/);
  assert.match(migration, /on conflict \(operation_id\) do nothing/);
  assert.match(migration, /for update/);
  assert.match(migration, /perform public\.require_active_profile\(\)/);
  assert.match(migration, /v_role not in \('ADMIN'/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, pg_temp/);
  assert.doesNotMatch(migration, /unique\s*\(phone\)|unique\s*\(email\)/i);
});

test("offline customer UI labels local entries pending and refreshes only after applied synchronization", () => {
  const source = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  const provider = readFileSync(new URL("../src/lib/offline/offline-auth-provider.tsx", import.meta.url), "utf8");
  assert.match(source, /Pending synchronization/);
  assert.match(source, /Not yet confirmed by the server/);
  assert.match(provider, /result\.applied > 0/);
  assert.match(provider, /refreshOfflineReadCache/);
});
