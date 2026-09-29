import Dexie, { type Table } from "dexie";
import type { DeviceIdentity, OfflineAuthProfile, OfflineMetadata, OfflineStore, OutboxRecord, OutboxStatus, SyncConflict } from "./types.ts";

export class TimmersGadgetOfflineDatabase extends Dexie {
  metadata!: Table<OfflineMetadata, string>;
  device!: Table<DeviceIdentity, string>;
  outbox!: Table<OutboxRecord, string>;
  syncConflicts!: Table<SyncConflict, string>;
  offlineAuthProfiles!: Table<OfflineAuthProfile, [string, string]>;

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
    this.on("populate", () => this.metadata.put({ key: "local_schema_version", value: "1", updatedAt: new Date().toISOString() }));
  }
}

let database: TimmersGadgetOfflineDatabase | undefined;

export function getOfflineDatabase() {
  if (typeof indexedDB === "undefined") throw new Error("The offline database is available only in a browser.");
  database ??= new TimmersGadgetOfflineDatabase();
  return database;
}

export class DexieOfflineStore implements OfflineStore {
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
}

export function compareOutboxRecords(left: OutboxRecord, right: OutboxRecord) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
