import assert from "node:assert/strict";
import test from "node:test";
import { connectivityStateFor } from "../src/lib/offline/connectivity.ts";
import { getOrCreateDevice } from "../src/lib/offline/device.ts";
import { canTransitionOutboxStatus, createOutboxRecord, OutboxSyncEngine, sortOutbox } from "../src/lib/offline/outbox.ts";
import type { DeviceIdentity, OfflineStore, OutboxRecord, OutboxStatus, SyncConflict } from "../src/lib/offline/types.ts";

class MemoryOfflineStore implements OfflineStore {
  device: DeviceIdentity | undefined;
  readonly outbox = new Map<string, OutboxRecord>();
  readonly conflicts: SyncConflict[] = [];
  async getDevice() { return this.device; }
  async saveDevice(device: DeviceIdentity) { this.device = device; }
  async addOutbox(record: OutboxRecord) { this.outbox.set(record.id, record); }
  async getOutbox(id: string) { return this.outbox.get(id); }
  async updateOutbox(record: OutboxRecord) { this.outbox.set(record.id, record); }
  async listOutboxByStatus(status: OutboxStatus) { return [...this.outbox.values()].filter((record) => record.status === status); }
  async addConflict(conflict: SyncConflict) { this.conflicts.push(conflict); }
}

let id = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
const now = () => "2026-09-28T12:00:00.000Z";
const input = () => ({ operationType: "future.operation", aggregateType: "future.aggregate", aggregateId: null, payload: { amount: "12.50" }, createdByLocalUserId: null, deviceId: nextId() });

test("device identity is created once and remains stable", async () => {
  const store = new MemoryOfflineStore();
  const first = await getOrCreateDevice(store, { createId: nextId, now });
  const second = await getOrCreateDevice(store, { createId: nextId, now });
  assert.equal(first.id, second.id);
  assert.equal(first.createdAt, "2026-09-28T12:00:00.000Z");
});

test("outbox creation keeps UUID identity, idempotency, ISO timestamps, and decimal-string payloads", () => {
  const record = createOutboxRecord(input(), { createId: nextId, now });
  assert.match(record.id, /^[0-9a-f-]{36}$/i);
  assert.match(record.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.notEqual(record.id, record.idempotencyKey);
  assert.equal(record.payload.amount, "12.50");
  assert.equal(record.status, "PENDING");
});

test("outbox status transitions prohibit terminal rewrites", () => {
  assert.equal(canTransitionOutboxStatus("PENDING", "SYNCING"), true);
  assert.equal(canTransitionOutboxStatus("SYNCING", "CONFLICT"), true);
  assert.equal(canTransitionOutboxStatus("SYNCED", "PENDING"), false);
  assert.equal(canTransitionOutboxStatus("CONFLICT", "PENDING"), false);
});

test("queue ordering is deterministic by creation time and UUID", () => {
  const later = { ...createOutboxRecord(input(), { createId: nextId, now }), id: "b", createdAt: "2026-09-28T12:01:00.000Z" };
  const sameTimeLaterId = { ...createOutboxRecord(input(), { createId: nextId, now }), id: "z" };
  const sameTimeEarlierId = { ...createOutboxRecord(input(), { createId: nextId, now }), id: "a" };
  assert.deepEqual(sortOutbox([later, sameTimeLaterId, sameTimeEarlierId]).map((record) => record.id), ["a", "z", "b"]);
});

test("network retry preserves the idempotency key and returns to pending", async () => {
  const store = new MemoryOfflineStore();
  const record = createOutboxRecord(input(), { createId: nextId, now });
  await store.addOutbox(record);
  const engine = new OutboxSyncEngine(store, { sync: async () => ({ kind: "NETWORK_ERROR", message: "offline" }) }, { createId: nextId, now });
  await engine.synchronize();
  const retried = await store.getOutbox(record.id);
  assert.equal(retried?.status, "PENDING");
  assert.equal(retried?.retryCount, 1);
  assert.equal(retried?.idempotencyKey, record.idempotencyKey);
});

test("conflicts are recorded for review instead of retried", async () => {
  const store = new MemoryOfflineStore();
  const record = createOutboxRecord(input(), { createId: nextId, now });
  await store.addOutbox(record);
  const engine = new OutboxSyncEngine(store, { sync: async () => ({ kind: "CONFLICT", conflictType: "revision", description: "Server state changed." }) }, { createId: nextId, now });
  await engine.synchronize();
  assert.equal((await store.getOutbox(record.id))?.status, "CONFLICT");
  assert.equal(store.conflicts[0]?.outboxId, record.id);
});

test("synchronization is single-flight", async () => {
  const store = new MemoryOfflineStore();
  await store.addOutbox(createOutboxRecord(input(), { createId: nextId, now }));
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = new OutboxSyncEngine(store, { sync: async () => { calls += 1; await gate; return { kind: "SYNCED" }; } }, { createId: nextId, now });
  const first = engine.synchronize();
  const second = engine.synchronize();
  assert.equal(first, second);
  release?.();
  await first;
  assert.equal(calls, 1);
});

test("connectivity distinguishes browser state from verified reachability", () => {
  assert.equal(connectivityStateFor(false, "REACHABLE"), "OFFLINE");
  assert.equal(connectivityStateFor(true, "UNKNOWN"), "CHECKING");
  assert.equal(connectivityStateFor(true, "REACHABLE"), "ONLINE");
  assert.equal(connectivityStateFor(true, "UNREACHABLE"), "DEGRADED");
});
