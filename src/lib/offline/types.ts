export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type OfflineMetadata = { key: string; value: JsonValue; updatedAt: string };
export type DeviceIdentity = { id: string; createdAt: string; updatedAt: string; label?: string };

export const outboxStatuses = ["PENDING", "SYNCING", "SYNCED", "CONFLICT", "FAILED"] as const;
export type OutboxStatus = (typeof outboxStatuses)[number];

export type OutboxRecord = {
  id: string;
  operationType: string;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, JsonValue>;
  createdAt: string;
  createdByLocalUserId: string | null;
  deviceId: string;
  idempotencyKey: string;
  status: OutboxStatus;
  retryCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  serverResult: JsonValue | null;
};

export type SyncConflict = {
  id: string;
  outboxId: string;
  conflictType: string;
  localPayload: Record<string, JsonValue>;
  serverPayload: JsonValue | null;
  description: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolutionMetadata: JsonValue | null;
};

export type DeviceIdentityStore = { getDevice(): Promise<DeviceIdentity | undefined>; saveDevice(device: DeviceIdentity): Promise<void> };
export type OutboxStore = {
  addOutbox(record: OutboxRecord): Promise<void>;
  getOutbox(id: string): Promise<OutboxRecord | undefined>;
  updateOutbox(record: OutboxRecord): Promise<void>;
  listOutboxByStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
};
export type SyncConflictStore = { addConflict(conflict: SyncConflict): Promise<void> };
export type OfflineStore = DeviceIdentityStore & OutboxStore & SyncConflictStore;
