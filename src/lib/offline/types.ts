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

export const offlineRoles = ["ADMIN", "MANAGER", "STAFF"] as const;
export type OfflineRole = (typeof offlineRoles)[number];
export const offlineReadRoles = ["MANAGER", "STAFF"] as const;
export type OfflineReadRole = (typeof offlineReadRoles)[number];

/** Encrypted, device-local enrollment metadata. It never contains a passcode or plaintext key. */
export type OfflineAuthProfile = {
  userId: string;
  deviceId: string;
  displayName: string;
  role: OfflineRole;
  activeSnapshot: boolean;
  enrolledAt: string;
  lastOnlineVerifiedAt: string;
  cryptoVersion: "v1";
  kdfAlgorithm: "PBKDF2-SHA-256";
  kdfIterations: number;
  kdfSalt: string;
  wrappedVaultKey: string;
  wrapIv: string;
  failedUnlockAttempts: number;
  nextUnlockAllowedAt: string | null;
  updatedAt: string;
};

export type DeviceIdentityStore = { getDevice(): Promise<DeviceIdentity | undefined>; saveDevice(device: DeviceIdentity): Promise<void> };
export type OutboxStore = {
  addOutbox(record: OutboxRecord): Promise<void>;
  getOutbox(id: string): Promise<OutboxRecord | undefined>;
  updateOutbox(record: OutboxRecord): Promise<void>;
  listOutboxByStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
};
export type SyncConflictStore = { addConflict(conflict: SyncConflict): Promise<void> };
export type OfflineAuthStore = {
  getOfflineAuthProfile(userId: string, deviceId: string): Promise<OfflineAuthProfile | undefined>;
  listOfflineAuthProfiles(deviceId: string): Promise<OfflineAuthProfile[]>;
  saveOfflineAuthProfile(profile: OfflineAuthProfile): Promise<void>;
  deleteOfflineAuthProfile(userId: string, deviceId: string): Promise<void>;
  /** Present in the browser store so authorization changes can remove encrypted business data. */
  purgeOfflineBusinessCache?: (userId: string, deviceId: string) => Promise<void>;
  /** Enrollment removal also makes encrypted, unsynchronized operations unreplayable. */
  purgeEncryptedMutationTransport?: (userId: string, deviceId: string) => Promise<void>;
  deleteOfflineAccess?: (userId: string, deviceId: string) => Promise<void>;
};
export type OfflineStore = DeviceIdentityStore & OutboxStore & SyncConflictStore;

/**
 * V4 is the only queue that may ever carry a business mutation.  Its payload
 * is AES-GCM ciphertext; the legacy Phase 1 outbox above remains an inert
 * transport prototype and is deliberately not a source for this queue.
 */
export const encryptedMutationStates = ["PENDING", "SYNCING", "APPLIED", "CONFLICT", "REJECTED"] as const;
export type EncryptedMutationState = (typeof encryptedMutationStates)[number];
export const ENCRYPTED_MUTATION_SCHEMA_VERSION = 1 as const;

export type EncryptedMutationEnvelope = {
  operationId: string;
  idempotencyKey: string;
  userId: string;
  deviceId: string;
  mutationType: string;
  schemaVersion: typeof ENCRYPTED_MUTATION_SCHEMA_VERSION;
  createdAt: string;
  state: EncryptedMutationState;
  retryCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  statusCode: string | null;
  ciphertext: string;
  iv: string;
};

/** No business data or server error text is permitted outside this ciphertext. */
export type EncryptedMutationConflict = {
  operationId: string;
  userId: string;
  deviceId: string;
  mutationType: string;
  schemaVersion: typeof ENCRYPTED_MUTATION_SCHEMA_VERSION;
  state: "CONFLICT";
  reasonCode: string;
  detectedAt: string;
  ciphertext: string | null;
  iv: string | null;
};

export type EncryptedMutationStore = {
  addEncryptedMutation(record: EncryptedMutationEnvelope): Promise<void>;
  getEncryptedMutation(operationId: string): Promise<EncryptedMutationEnvelope | undefined>;
  updateEncryptedMutation(record: EncryptedMutationEnvelope): Promise<void>;
  listEncryptedMutations(userId: string, deviceId: string): Promise<EncryptedMutationEnvelope[]>;
  addEncryptedMutationConflict(conflict: EncryptedMutationConflict): Promise<void>;
  listEncryptedMutationConflicts(userId: string, deviceId: string): Promise<EncryptedMutationConflict[]>;
  purgeEncryptedMutationTransport?: (userId: string, deviceId: string) => Promise<void>;
};

export type OfflineBusinessResource = "catalogue" | "inventory" | "customers" | "suppliers";
export type OfflineCatalogueRecord = {
  productId: string;
  productName: string;
  productSku: string;
  productBarcode: string | null;
  brandName: string | null;
  categoryName: string | null;
  serialized: false;
  variantId: string | null;
  variantLabel: string | null;
  variantSku: string | null;
  variantBarcode: string | null;
  condition: string;
  quantity: number;
  sellingPrice: number;
};

export type OfflineSerializedInventoryRecord = {
  unitId: string;
  productId: string;
  productName: string;
  productSku: string;
  productBarcode: string | null;
  productModel: string | null;
  brandName: string | null;
  categoryName: string | null;
  variantId: string | null;
  variantLabel: string | null;
  variantSku: string | null;
  variantBarcode: string | null;
  condition: string;
  status: string;
  sellingPrice: number | null;
  identifierType: string;
  identifierValue: string;
};

/** Operational reference data only; financial, credit, purchase, and history fields are excluded. */
export type OfflineCustomerRecord = { customerId: string; fullName: string; phone: string | null; email: string | null };
export type OfflineSupplierRecord = { supplierId: string; businessName: string; contactName: string | null; phone: string | null; email: string | null; active: boolean };

export type OfflineReadSnapshot = {
  capturedAt: string;
  catalogue: OfflineCatalogueRecord[];
  serializedInventory: OfflineSerializedInventoryRecord[];
  customers: OfflineCustomerRecord[];
  /** Always empty for STAFF; the server decides whether a manager may receive it. */
  suppliers: OfflineSupplierRecord[];
};

/** Metadata is non-business data; the payload is always encrypted with the in-memory vault key. */
export type EncryptedBusinessCacheRecord = {
  userId: string;
  deviceId: string;
  resource: OfflineBusinessResource;
  snapshotId: string;
  role: OfflineReadRole;
  capturedAt: string;
  encryptedAt: string;
  ciphertext: string;
  iv: string;
};

export type OfflineBusinessCacheStore = {
  replaceOfflineBusinessCache(records: EncryptedBusinessCacheRecord[]): Promise<void>;
  listOfflineBusinessCache(userId: string, deviceId: string): Promise<EncryptedBusinessCacheRecord[]>;
  purgeOfflineBusinessCache(userId: string, deviceId: string): Promise<void>;
};
