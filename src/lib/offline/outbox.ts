import { compareOutboxRecords } from "./db.ts";
import type { JsonValue, OfflineStore, OutboxRecord, OutboxStatus, SyncConflict } from "./types.ts";

type OutboxInput = Pick<OutboxRecord, "operationType" | "aggregateType" | "aggregateId" | "payload" | "createdByLocalUserId" | "deviceId">;
type OutboxDependencies = { createId?: () => string; now?: () => string };

export type OperationSyncOutcome =
  | { kind: "SYNCED"; serverResult?: JsonValue }
  | { kind: "NETWORK_ERROR"; message: string }
  | { kind: "CONFLICT"; conflictType: string; description: string; serverPayload?: JsonValue }
  | { kind: "FAILED"; message: string };
export type OfflineOperationAdapter = { sync(record: OutboxRecord): Promise<OperationSyncOutcome> };
export type SyncRunResult = { processed: number; synced: number; retried: number; conflicted: number; failed: number };

export const validOutboxTransitions: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  PENDING: ["SYNCING"], SYNCING: ["PENDING", "SYNCED", "CONFLICT", "FAILED"], SYNCED: [], CONFLICT: [], FAILED: ["PENDING"],
};

function createUuid() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure UUID generation is unavailable in this browser.");
  return id;
}
function requireText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required.`);
  return value;
}

export function createOutboxRecord(input: OutboxInput, dependencies: OutboxDependencies = {}) {
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const createId = dependencies.createId ?? createUuid;
  return {
    id: createId(), operationType: requireText(input.operationType, "operationType"), aggregateType: requireText(input.aggregateType, "aggregateType"), aggregateId: input.aggregateId,
    payload: input.payload, createdAt: now, createdByLocalUserId: input.createdByLocalUserId, deviceId: requireText(input.deviceId, "deviceId"), idempotencyKey: createId(),
    status: "PENDING" as const, retryCount: 0, lastAttemptAt: null, lastError: null, serverResult: null,
  };
}
export function canTransitionOutboxStatus(from: OutboxStatus, to: OutboxStatus) { return validOutboxTransitions[from].includes(to); }
export function transitionOutbox(record: OutboxRecord, status: OutboxStatus, now: string, updates: Partial<OutboxRecord> = {}) {
  if (!canTransitionOutboxStatus(record.status, status)) throw new Error(`Invalid outbox status transition: ${record.status} to ${status}.`);
  return { ...record, ...updates, status, lastAttemptAt: now };
}
export function sortOutbox(records: OutboxRecord[]) { return [...records].sort(compareOutboxRecords); }
function notifyOutboxChanged() { if (typeof window !== "undefined") window.dispatchEvent(new Event("timmers-offline-outbox-changed")); }

export class OutboxSyncEngine {
  private inFlight: Promise<SyncRunResult> | undefined;
  private readonly store: OfflineStore;
  private readonly adapter: OfflineOperationAdapter;
  private readonly dependencies: OutboxDependencies;

  constructor(store: OfflineStore, adapter: OfflineOperationAdapter, dependencies: OutboxDependencies = {}) {
    this.store = store;
    this.adapter = adapter;
    this.dependencies = dependencies;
  }
  synchronize() {
    this.inFlight ??= this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async run(): Promise<SyncRunResult> {
    const pending = sortOutbox(await this.store.listOutboxByStatus("PENDING"));
    const result: SyncRunResult = { processed: 0, synced: 0, retried: 0, conflicted: 0, failed: 0 };
    for (const record of pending) {
      result.processed += 1;
      const now = (this.dependencies.now ?? (() => new Date().toISOString()))();
      const syncing = transitionOutbox(record, "SYNCING", now);
      await this.store.updateOutbox(syncing);
      let outcome: OperationSyncOutcome;
      try { outcome = await this.adapter.sync(syncing); } catch { outcome = { kind: "NETWORK_ERROR", message: "Network request failed." }; }
      await this.applyOutcome(syncing, outcome, now, result);
    }
    notifyOutboxChanged();
    return result;
  }
  private async applyOutcome(record: OutboxRecord, outcome: OperationSyncOutcome, now: string, result: SyncRunResult) {
    if (outcome.kind === "SYNCED") {
      await this.store.updateOutbox(transitionOutbox(record, "SYNCED", now, { serverResult: outcome.serverResult ?? null, lastError: null })); result.synced += 1; return;
    }
    if (outcome.kind === "NETWORK_ERROR") {
      await this.store.updateOutbox(transitionOutbox(record, "PENDING", now, { retryCount: record.retryCount + 1, lastError: outcome.message })); result.retried += 1; return;
    }
    if (outcome.kind === "CONFLICT") {
      await this.store.updateOutbox(transitionOutbox(record, "CONFLICT", now, { lastError: outcome.description }));
      const conflict: SyncConflict = { id: (this.dependencies.createId ?? createUuid)(), outboxId: record.id, conflictType: outcome.conflictType, localPayload: record.payload, serverPayload: outcome.serverPayload ?? null, description: outcome.description, detectedAt: now, resolvedAt: null, resolutionMetadata: null };
      await this.store.addConflict(conflict); result.conflicted += 1; return;
    }
    await this.store.updateOutbox(transitionOutbox(record, "FAILED", now, { lastError: outcome.message })); result.failed += 1;
  }
}
