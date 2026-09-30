import Dexie, { type Table } from "dexie";
import type { DeviceIdentity, EncryptedBusinessCacheRecord, EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore, OfflineAuthProfile, OfflineBusinessCacheStore, OfflineMetadata, OfflineStore, OutboxRecord, OutboxStatus, SyncConflict } from "./types.ts";

export class TimmersGadgetOfflineDatabase extends Dexie {
  metadata!: Table<OfflineMetadata, string>;
  device!: Table<DeviceIdentity, string>;
  outbox!: Table<OutboxRecord, string>;
  syncConflicts!: Table<SyncConflict, string>;
  offlineAuthProfiles!: Table<OfflineAuthProfile, [string, string]>;
  encryptedBusinessCache!: Table<EncryptedBusinessCacheRecord, [string, string, string]>;
  encryptedMutationOutbox!: Table<EncryptedMutationEnvelope, string>;
  encryptedMutationConflicts!: Table<EncryptedMutationConflict, string>;

  constructor() {
    super("timmers-gadget-offline");
    this.version(1).stores({
      metadata: "&key, updatedAt",
      device: "&id, updatedAt",
      outbox: "&id, status, createdAt, [status+createdAt], idempotencyKey",
      syncConflicts: "&id, outboxId, detectedAt",
    });
    this.version(2).stores({
      metadata: "&key, updatedAt",
      device: "&id, updatedAt",
      outbox: "&id, status, createdAt, [status+createdAt], idempotencyKey",
      syncConflicts: "&id, outboxId, detectedAt",
      offlineAuthProfiles: "[userId+deviceId], userId, deviceId, role, activeSnapshot, updatedAt",
    });
    this.version(3).stores({
      metadata: "&key, updatedAt",
      device: "&id, updatedAt",
      outbox: "&id, status, createdAt, [status+createdAt], idempotencyKey",
      syncConflicts: "&id, outboxId, detectedAt",
      offlineAuthProfiles: "[userId+deviceId], userId, deviceId, role, activeSnapshot, updatedAt",
      encryptedBusinessCache: "[userId+deviceId+resource], [userId+deviceId], userId, deviceId, resource, snapshotId, encryptedAt",
    });
    this.version(4).stores({
      metadata: "&key, updatedAt",
      device: "&id, updatedAt",
      // Legacy Phase 1 prototype only. It contains no production business mutations.
      outbox: "&id, status, createdAt, [status+createdAt], idempotencyKey",
      syncConflicts: "&id, outboxId, detectedAt",
      offlineAuthProfiles: "[userId+deviceId], userId, deviceId, role, activeSnapshot, updatedAt",
      encryptedBusinessCache: "[userId+deviceId+resource], [userId+deviceId], userId, deviceId, resource, snapshotId, encryptedAt",
      encryptedMutationOutbox: "&operationId, [userId+deviceId], userId, deviceId, state, createdAt, nextAttemptAt, [state+nextAttemptAt]",
      encryptedMutationConflicts: "&operationId, [userId+deviceId], userId, deviceId, state, detectedAt",
    });
    this.on("populate", () => this.metadata.put({ key: "local_schema_version", value: "1", updatedAt: new Date().toISOString() }));
  }
}

let database: TimmersGadgetOfflineDatabase | undefined;

export function getOfflineDatabase() {
  if (typeof indexedDB === "undefined") throw new Error("The offline database is available only in a browser.");
  database ??= new TimmersGadgetOfflineDatabase();
  return database;
}

export class DexieOfflineStore implements OfflineStore, OfflineBusinessCacheStore, EncryptedMutationStore {
  private readonly database: TimmersGadgetOfflineDatabase;

  constructor(database: TimmersGadgetOfflineDatabase = getOfflineDatabase()) {
    this.database = database;
  }
  async getDevice() { return this.database.device.toCollection().first(); }
  async saveDevice(device: DeviceIdentity) { await this.database.device.put(device); }
  async addOutbox(record: OutboxRecord) { await this.database.outbox.add(record); }
  async getOutbox(id: string) { return this.database.outbox.get(id); }
  async updateOutbox(record: OutboxRecord) { await this.database.outbox.put(record); }
  async listOutboxByStatus(status: OutboxStatus) {
    return (await this.database.outbox.where("status").equals(status).toArray()).sort(compareOutboxRecords);
  }
  async addConflict(conflict: SyncConflict) { await this.database.syncConflicts.add(conflict); }
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { await this.database.encryptedMutationOutbox.add(record); }
  async getEncryptedMutation(operationId: string) { return this.database.encryptedMutationOutbox.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { await this.database.encryptedMutationOutbox.put(record); }
  async listEncryptedMutations(userId: string, deviceId: string) {
    return (await this.database.encryptedMutationOutbox.where("[userId+deviceId]").equals([userId, deviceId]).toArray()).sort(compareEncryptedMutationEnvelopes);
  }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { await this.database.encryptedMutationConflicts.put(conflict); }
  async listEncryptedMutationConflicts(userId: string, deviceId: string) {
    return (await this.database.encryptedMutationConflicts.where("[userId+deviceId]").equals([userId, deviceId]).toArray())
      .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.operationId.localeCompare(right.operationId));
  }
  async purgeEncryptedMutationTransport(userId: string, deviceId: string) {
    await this.database.transaction("rw", this.database.encryptedMutationOutbox, this.database.encryptedMutationConflicts, async () => {
      await this.database.encryptedMutationOutbox.where("[userId+deviceId]").equals([userId, deviceId]).delete();
      await this.database.encryptedMutationConflicts.where("[userId+deviceId]").equals([userId, deviceId]).delete();
    });
  }
  async getOfflineAuthProfile(userId: string, deviceId: string) {
    return this.database.offlineAuthProfiles.get([userId, deviceId]);
  }
  async listOfflineAuthProfiles(deviceId: string) {
    return (await this.database.offlineAuthProfiles.where("deviceId").equals(deviceId).toArray())
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.userId.localeCompare(right.userId));
  }
  async saveOfflineAuthProfile(profile: OfflineAuthProfile) { await this.database.offlineAuthProfiles.put(profile); }
  async deleteOfflineAuthProfile(userId: string, deviceId: string) {
    await this.database.offlineAuthProfiles.delete([userId, deviceId]);
  }
  async replaceOfflineBusinessCache(records: EncryptedBusinessCacheRecord[]) {
    if (records.length !== 4 || new Set(records.map((record) => record.resource)).size !== 4) throw new Error("An encrypted offline snapshot must contain every resource.");
    const { userId, deviceId } = records[0];
    if (records.some((record) => record.userId !== userId || record.deviceId !== deviceId || record.snapshotId !== records[0].snapshotId || record.capturedAt !== records[0].capturedAt || record.role !== records[0].role)) throw new Error("Offline snapshot scope is inconsistent.");
    await this.database.transaction("rw", this.database.encryptedBusinessCache, async () => {
      await this.database.encryptedBusinessCache.where("[userId+deviceId]").equals([userId, deviceId]).delete();
      await this.database.encryptedBusinessCache.bulkPut(records);
    });
  }
  async listOfflineBusinessCache(userId: string, deviceId: string) {
    return (await this.database.encryptedBusinessCache.where("[userId+deviceId]").equals([userId, deviceId]).toArray())
      .sort((left, right) => left.resource.localeCompare(right.resource));
  }
  async purgeOfflineBusinessCache(userId: string, deviceId: string) {
    await this.database.encryptedBusinessCache.where("[userId+deviceId]").equals([userId, deviceId]).delete();
  }
  async deleteOfflineAccess(userId: string, deviceId: string) {
    await this.database.transaction("rw", this.database.offlineAuthProfiles, this.database.encryptedBusinessCache, this.database.encryptedMutationOutbox, this.database.encryptedMutationConflicts, async () => {
      await this.database.encryptedBusinessCache.where("[userId+deviceId]").equals([userId, deviceId]).delete();
      await this.database.encryptedMutationOutbox.where("[userId+deviceId]").equals([userId, deviceId]).delete();
      await this.database.encryptedMutationConflicts.where("[userId+deviceId]").equals([userId, deviceId]).delete();
      await this.database.offlineAuthProfiles.delete([userId, deviceId]);
    });
  }
}

export function compareOutboxRecords(left: OutboxRecord, right: OutboxRecord) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function compareEncryptedMutationEnvelopes(left: EncryptedMutationEnvelope, right: EncryptedMutationEnvelope) {
  return left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId);
}
