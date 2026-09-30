import { decryptVaultValue, encryptVaultValue } from "./crypto.ts";
import { offlineReadRoles, type EncryptedBusinessCacheRecord, type OfflineBusinessCacheStore, type OfflineBusinessResource, type OfflineReadRole, type OfflineReadSnapshot } from "./types.ts";

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
  if (!snapshot || !Array.isArray(snapshot.catalogue) || !Array.isArray(snapshot.serializedInventory) || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new Error("The online inventory snapshot has an invalid shape.");
  }
}

async function encryptedRecord(identity: CacheIdentityWithKey, resource: OfflineBusinessResource, snapshotId: string, capturedAt: string, encryptedAt: string, records: unknown[]) {
  const encrypted = await encryptVaultValue(identity.vaultKey, encoder.encode(JSON.stringify({ capturedAt, records })), offlineBusinessCacheContext(identity.userId, identity.deviceId, resource));
  return { userId: identity.userId, deviceId: identity.deviceId, role: identity.role, resource, snapshotId, capturedAt, encryptedAt, ...encrypted } satisfies EncryptedBusinessCacheRecord;
}

/** Fetch, encrypt, then atomically replace both read-only resources; failed work leaves the prior snapshot untouched. */
export async function refreshOfflineReadCache(store: OfflineBusinessCacheStore, identity: CacheIdentityWithKey, snapshot: OfflineReadSnapshot, dependencies: RefreshDependencies = {}) {
  if (!isOfflineReadRole(identity.role)) throw new Error("This role is not approved for offline business reads.");
  validateSnapshot(snapshot);
  const encryptedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const snapshotId = (dependencies.createId ?? makeSnapshotId)();
  const records = await Promise.all([
    encryptedRecord(identity, "catalogue", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.catalogue),
    encryptedRecord(identity, "inventory", snapshotId, snapshot.capturedAt, encryptedAt, snapshot.serializedInventory),
  ]);
  await store.replaceOfflineBusinessCache(records);
  return { capturedAt: snapshot.capturedAt, snapshotId, catalogueCount: snapshot.catalogue.length, serializedInventoryCount: snapshot.serializedInventory.length };
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
  if (!catalogue || !inventory || catalogue.snapshotId !== inventory.snapshotId || catalogue.capturedAt !== inventory.capturedAt) return null;
  const [cataloguePayload, inventoryPayload] = await Promise.all([decryptResource(catalogue), decryptResource(inventory)]);
  return { capturedAt: catalogue.capturedAt, catalogue: cataloguePayload.records as OfflineReadSnapshot["catalogue"], serializedInventory: inventoryPayload.records as OfflineReadSnapshot["serializedInventory"] };
}

export async function fetchOfflineReadSnapshot() {
  const response = await fetch("/api/offline/read-snapshot", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 403 ? "Offline business reads are not available for this role." : "The offline snapshot could not be refreshed.");
  return response.json() as Promise<OfflineReadSnapshot>;
}
