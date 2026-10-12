import { decryptVaultValue, encryptVaultValue } from "./crypto.ts";
import { offlineReadRoles, type EncryptedBusinessCacheRecord, type OfflineAdjustmentRequestStatus, type OfflineBusinessCacheStore, type OfflineBusinessResource, type OfflineReadRole, type OfflineReadSnapshot } from "./types.ts";

type CachedPayload = { capturedAt: string; records: unknown[] };
type CacheIdentity = { userId: string; deviceId: string; role: OfflineReadRole };
type CacheIdentityWithKey = CacheIdentity & { vaultKey: CryptoKey };
type EncryptedRecordWithKey = EncryptedBusinessCacheRecord & { vaultKey: CryptoKey };
type RefreshDependencies = {
  now?: () => string;
  createId?: () => string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function offlineBusinessCacheContext(userId: string, deviceId: string, resource: OfflineBusinessResource) {
  return encoder.encode(JSON.stringify({ cryptoVersion: "v1", userId, deviceId, resource }));
}

function isOfflineReadRole(role: string): role is OfflineReadRole {
  return (offlineReadRoles as readonly string[]).includes(role);
}

function makeSnapshotId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure random snapshot identifiers are unavailable.");
  return globalThis.crypto.randomUUID();
}

function validateSnapshot(snapshot: OfflineReadSnapshot) {
  if (!snapshot || !Array.isArray(snapshot.catalogue) || !Array.isArray(snapshot.serializedInventory) || !Array.isArray(snapshot.sellableSerialized ?? []) || !Array.isArray(snapshot.customers) || !Array.isArray(snapshot.suppliers) || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new Error("The online inventory snapshot has an invalid shape.");
  }
}

async function encryptedRecord(identity: CacheIdentityWithKey, resource: OfflineBusinessResource, snapshotId: string, capturedAt: string, encryptedAt: string, records: unknown[]) {
  const encrypted = await encryptVaultValue(identity.vaultKey, encoder.encode(JSON.stringify({ capturedAt, records })), offlineBusinessCacheContext(identity.userId, identity.deviceId, resource));
  return { userId: identity.userId, deviceId: identity.deviceId, role: identity.role, resource, snapshotId, capturedAt, encryptedAt, ...encrypted } satisfies EncryptedBusinessCacheRecord;
}

/** Fetch, encrypt, then atomically replace all read-only resources; failed work leaves the prior snapshot untouched. */
export async function refreshOfflineReadCache(store: OfflineBusinessCacheStore, identity: CacheIdentityWithKey, snapshot: OfflineReadSnapshot, dependencies: RefreshDependencies = {}) {
  if (!isOfflineReadRole(identity.role)) throw new Error("This role is not approved for offline business reads.");
  validateSnapshot(snapshot);
  const encryptedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const snapshotId = (dependencies.createId ?? makeSnapshotId)();
  const records = await Promise.all([
    encryptedRecord(identity, "catalogue", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.catalogue),
    encryptedRecord(identity, "inventory", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.serializedInventory),
    encryptedRecord(identity, "sellableSerialized", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.sellableSerialized ?? []),
    encryptedRecord(identity, "customers", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.customers),
    encryptedRecord(identity, "suppliers", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.suppliers),
  ]);
  await store.replaceOfflineBusinessCache(records);
  return { capturedAt: snapshot.capturedAt, snapshotId, catalogueCount: snapshot.catalogue.length, serializedInventoryCount: snapshot.serializedInventory.length, customerCount: snapshot.customers.length, supplierCount: snapshot.suppliers.length };
}

async function decryptResource(record: EncryptedRecordWithKey) {
  const plaintext = await decryptVaultValue(record.vaultKey, { ciphertext: record.ciphertext, iv: record.iv }, offlineBusinessCacheContext(record.userId, record.deviceId, record.resource));
  const payload = JSON.parse(decoder.decode(plaintext)) as CachedPayload;
  if (!payload || !Array.isArray(payload.records) || payload.capturedAt !== record.capturedAt) throw new Error("The encrypted offline snapshot is invalid.");
  return payload;
}

/** Returns nothing for incomplete or mixed snapshots; it never combines records from different refreshes. */
export async function readOfflineReadCache(store: OfflineBusinessCacheStore, identity: CacheIdentityWithKey): Promise<OfflineReadSnapshot | null> {
  if (!isOfflineReadRole(identity.role)) return null;
  const matches = (await store.listOfflineBusinessCache(identity.userId, identity.deviceId))
    .filter((record) => record.role === identity.role)
    .map((record) => ({ ...record, vaultKey: identity.vaultKey } satisfies EncryptedRecordWithKey));
  const catalogue = matches.find((record) => record.resource === "catalogue");
  const inventory = matches.find((record) => record.resource === "inventory");
  const sellableSerialized = matches.find((record) => record.resource === "sellableSerialized");
  const customers = matches.find((record) => record.resource === "customers");
  const suppliers = matches.find((record) => record.resource === "suppliers");
  const records = [catalogue, inventory, sellableSerialized, customers, suppliers];
  if (records.some((record) => !record) || new Set(records.map((record) => record!.snapshotId)).size !== 1 || new Set(records.map((record) => record!.capturedAt)).size !== 1) return null;
  const [cataloguePayload, inventoryPayload, sellablePayload, customerPayload, supplierPayload] = await Promise.all(records.map((record) => decryptResource(record!)));
  return { capturedAt: catalogue!.capturedAt, catalogue: cataloguePayload.records as OfflineReadSnapshot["catalogue"], serializedInventory: inventoryPayload.records as OfflineReadSnapshot["serializedInventory"], sellableSerialized: sellablePayload.records as NonNullable<OfflineReadSnapshot["sellableSerialized"]>, customers: customerPayload.records as OfflineReadSnapshot["customers"], suppliers: supplierPayload.records as OfflineReadSnapshot["suppliers"] };
}

export async function fetchOfflineReadSnapshot() {
  const response = await fetch("/api/offline/read-snapshot", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 403 ? "Offline business reads are not available for this role." : "The offline snapshot could not be refreshed.");
  return response.json() as Promise<OfflineReadSnapshot>;
}

function validateAdjustmentRequests(records: OfflineAdjustmentRequestStatus[]) {
  if (!Array.isArray(records) || records.some((record) => !record || !record.adjustmentRequestId || !record.productId || !["OPEN", "RESOLVED", "REJECTED"].includes(record.status) || !Number.isSafeInteger(record.requestedQuantity) || !record.reason || Number.isNaN(Date.parse(record.requestedAt)))) throw new Error("The adjustment-request status snapshot has an invalid shape.");
}
/** A narrow encrypted resource, independent of the inventory snapshot. */
export async function refreshOfflineAdjustmentRequestCache(store: OfflineBusinessCacheStore, identity: CacheIdentityWithKey, records: OfflineAdjustmentRequestStatus[], dependencies: RefreshDependencies = {}) {
  if (!isOfflineReadRole(identity.role)) throw new Error("This role is not approved for offline request-status reads.");
  validateAdjustmentRequests(records);
  const capturedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const record = await encryptedRecord(identity, "adjustmentRequests", (dependencies.createId ?? makeSnapshotId)(), capturedAt, capturedAt, records);
  if (!store.replaceOfflineAdjustmentRequestCache) throw new Error("The encrypted request-status cache is unavailable.");
  await store.replaceOfflineAdjustmentRequestCache(record);
  return { capturedAt, count: records.length };
}
export async function readOfflineAdjustmentRequestCache(store: OfflineBusinessCacheStore, identity: CacheIdentityWithKey): Promise<OfflineAdjustmentRequestStatus[]> {
  if (!isOfflineReadRole(identity.role)) return [];
  const record = (await store.listOfflineBusinessCache(identity.userId, identity.deviceId)).find((candidate) => candidate.resource === "adjustmentRequests" && candidate.role === identity.role);
  if (!record) return [];
  const payload = await decryptResource({ ...record, vaultKey: identity.vaultKey });
  validateAdjustmentRequests(payload.records as OfflineAdjustmentRequestStatus[]);
  return payload.records as OfflineAdjustmentRequestStatus[];
}
export async function fetchOfflineAdjustmentRequestStatuses() {
  const response = await fetch("/api/offline/adjustment-request-statuses", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 403 ? "Offline adjustment-request statuses are not available for this role." : "Adjustment-request statuses could not be refreshed.");
  return response.json() as Promise<OfflineAdjustmentRequestStatus[]>;
}
