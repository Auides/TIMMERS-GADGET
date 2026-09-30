import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { EncryptedMutationSyncEngine, canTransitionEncryptedMutation, createEncryptedMutationEnvelope, decryptEncryptedMutationPayload, enqueueEncryptedMutation, noBusinessMutationExecutors, retryEncryptedMutation } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "../src/lib/offline/types.ts";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";
const deviceOne = "33333333-3333-4333-8333-333333333333";
const initialNow = "2026-09-30T10:00:00.000Z";

class MemoryMutationStore implements EncryptedMutationStore {
  readonly records = new Map<string, EncryptedMutationEnvelope>();
  readonly conflicts = new Map<string, EncryptedMutationConflict>();
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async getEncryptedMutation(operationId: string) { return this.records.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async listEncryptedMutations(userId: string, deviceId: string) { return [...this.records.values()].filter((record) => record.userId === userId && record.deviceId === deviceId); }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { this.conflicts.set(conflict.operationId, { ...conflict }); }
  async listEncryptedMutationConflicts(userId: string, deviceId: string) { return [...this.conflicts.values()].filter((record) => record.userId === userId && record.deviceId === deviceId); }
}

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const dependencies = { now: () => initialNow, createId: nextId };
const crypto = createOfflineCryptoService(1);
async function identity(userId = userOne, deviceId = deviceOne) {
  return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode(`${userId}:${deviceId}`))).vaultKey };
}
const input = (payload: JsonValue = { customerName: "Ada Customer", phone: "08000000000", amount: 1500 }) => ({ mutationType: "CUSTOMER_CREATE" as const, payload });
async function queued(store = new MemoryMutationStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, input(), dependencies);
  return { store, identity: unlockedIdentity, record };
}

test("future mutation payloads are encrypted at rest with no business plaintext metadata", async () => {
  const { store, record } = await queued();
  assert.doesNotMatch(JSON.stringify(store.records.get(record.operationId)), /Ada Customer|08000000000|1500/);
  assert.notEqual(record.ciphertext, "");
  assert.notEqual(record.iv, "");
  assert.deepEqual(Object.keys(record).sort(), ["ciphertext", "createdAt", "deviceId", "idempotencyKey", "iv", "lastAttemptAt", "mutationType", "nextAttemptAt", "operationId", "retryCount", "schemaVersion", "state", "statusCode", "userId"].sort());
});

test("encrypted operations are user/device scoped and AAD rejects cross-operation substitution", async () => {
  const firstIdentity = await identity();
  const secondIdentity = await identity(userTwo);
  const first = await createEncryptedMutationEnvelope(firstIdentity, input(), dependencies);
  const second = await createEncryptedMutationEnvelope(firstIdentity, input({ serial: "IMEI-123" }), dependencies);
  await assert.rejects(() => decryptEncryptedMutationPayload(secondIdentity, first));
  await assert.rejects(() => decryptEncryptedMutationPayload(firstIdentity, { ...second, ciphertext: first.ciphertext, iv: first.iv }));
  assert.deepEqual(await decryptEncryptedMutationPayload(firstIdentity, first), input().payload);
});

test("queue ordering is deterministic by creation time then operation ID", async () => {
  const store = new MemoryMutationStore();
  const currentIdentity = await identity();
  const first = await createEncryptedMutationEnvelope(currentIdentity, input(), { ...dependencies, createId: () => "z" });
  const second = { ...await createEncryptedMutationEnvelope(currentIdentity, input(), { ...dependencies, createId: () => "a" }), operationId: "a" };
  const later = { ...await createEncryptedMutationEnvelope(currentIdentity, input(), { now: () => "2026-09-30T10:01:00.000Z", createId: () => "b" }), operationId: "b" };
  await store.addEncryptedMutation(first);
  await store.addEncryptedMutation(second);
  await store.addEncryptedMutation(later);
  const seen: string[] = [];
  const engine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", async (operation) => { seen.push(operation.operationId); return { kind: "APPLIED" as const }; }]]), dependencies);
  await engine.synchronize();
  assert.deepEqual(seen, [second.operationId, first.operationId, later.operationId]);
});

test("transient retry, crash recovery, and terminal state rules preserve stable identities", async () => {
  const { store, identity: currentIdentity, record } = await queued();
  const engine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", async () => ({ kind: "TRANSIENT" as const })]]), dependencies);
  await engine.synchronize();
  const retried = await store.getEncryptedMutation(record.operationId);
  assert.equal(retried?.state, "PENDING");
  assert.equal(retried?.idempotencyKey, record.idempotencyKey);
  assert.equal(retried?.operationId, record.operationId);
  assert.equal(retried?.retryCount, 1);
  assert.ok(retried?.nextAttemptAt && retried.nextAttemptAt > initialNow);
  const stale = { ...retried!, state: "SYNCING" as const, lastAttemptAt: "2026-09-30T09:00:00.000Z", nextAttemptAt: null };
  await store.updateEncryptedMutation(stale);
  const recovery = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: false, hasActiveProfile: false }), noBusinessMutationExecutors, { ...dependencies, staleSyncingAfterMs: 60_000 });
  assert.equal((await recovery.synchronize()).recovered, 1);
  const restored = await store.getEncryptedMutation(record.operationId);
  assert.equal(restored?.state, "PENDING");
  assert.equal(restored?.idempotencyKey, record.idempotencyKey);
  assert.equal(canTransitionEncryptedMutation("APPLIED", "PENDING"), false);
  assert.equal(canTransitionEncryptedMutation("CONFLICT", "PENDING"), false);
  assert.equal(canTransitionEncryptedMutation("REJECTED", "PENDING"), false);
  assert.equal(retryEncryptedMutation({ ...stale, state: "SYNCING" }, initialNow).retryCount, 2);
});

test("single-flight synchronization, conflict, rejection, applied terminal, and unknown types behave safely", async () => {
  const { store, identity: currentIdentity, record } = await queued();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const engine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", async () => { calls += 1; await wait; return { kind: "APPLIED" as const }; }]]), dependencies);
  const first = engine.synchronize();
  const second = engine.synchronize();
  assert.equal(first, second);
  release?.();
  assert.equal((await first).applied, 1);
  assert.equal(calls, 1);
  assert.equal((await engine.synchronize()).processed, 0);
  const conflictRecord = await enqueueEncryptedMutation(store, currentIdentity, input({ customerName: "Private Context" }), dependencies);
  const conflictEngine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", async () => ({ kind: "CONFLICT" as const, reasonCode: "REVISION_MISMATCH", encryptedContext: { customerName: "Private Context" } })]]), dependencies);
  await conflictEngine.synchronize();
  assert.equal((await store.getEncryptedMutation(conflictRecord.operationId))?.state, "CONFLICT");
  assert.doesNotMatch(JSON.stringify(await store.listEncryptedMutationConflicts(userOne, deviceOne)), /Private Context/);
  const unknown = await enqueueEncryptedMutation(store, currentIdentity, input(), dependencies);
  const unknownEngine = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), noBusinessMutationExecutors, dependencies);
  await unknownEngine.synchronize();
  assert.equal((await store.getEncryptedMutation(unknown.operationId))?.state, "REJECTED");
  assert.equal((await store.getEncryptedMutation(unknown.operationId))?.statusCode, "MUTATION_TYPE_NOT_IMPLEMENTED");
  assert.equal(record.state, "PENDING");
});

test("a locked vault and unavailable replay authorization leave encrypted operations untouched", async () => {
  const { store, identity: currentIdentity, record } = await queued();
  const locked = new EncryptedMutationSyncEngine(store, () => null, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), noBusinessMutationExecutors, dependencies);
  assert.equal((await locked.synchronize()).locked, true);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "PENDING");
  const unauthorized = new EncryptedMutationSyncEngine(store, () => currentIdentity, async () => ({ hasAuthenticatedSession: false, hasActiveProfile: false }), noBusinessMutationExecutors, dependencies);
  assert.equal((await unauthorized.synchronize()).authorizationUnavailable, true);
  assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "PENDING");
});

test("no real business executor is registered and the service worker contains no mutation replay", () => {
  assert.equal(noBusinessMutationExecutors.size, 0);
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /outbox|mutation|sync|background\s*sync|Supabase/i);
});
