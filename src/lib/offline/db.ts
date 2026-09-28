import Dexie, { type Table } from "dexie";
import type { DeviceIdentity, OfflineMetadata, OfflineStore, OutboxRecord, OutboxStatus, SyncConflict } from "./types.ts";

export class TimmersGadgetOfflineDatabase extends Dexie {
  metadata!: Table<OfflineMetadata, string>;
  device!: Table<DeviceIdentity, string>;
  outbox!: Table<OutboxRecord, string>;
  syncConflicts!: Table<SyncConflict, string>;

  constructor() {
    super("timmers-gadget-offline");
    this.version(1).stores({
      metadata: "&key, updatedAt",
      device: "&id, updatedAt",
      outbox: "&id, status, createdAt, [status+createdAt], idempotencyKey",
      syncConflicts: "&id, outboxId, detectedAt",
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
}

export function compareOutboxRecords(left: OutboxRecord, right: OutboxRecord) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
