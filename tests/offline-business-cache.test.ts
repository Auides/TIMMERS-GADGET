import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { offlineBusinessCacheContext, readOfflineReadCache, refreshOfflineReadCache } from "../src/lib/offline/business-cache.ts";
import { reverifyOfflineAccess } from "../src/lib/offline/offline-auth.ts";
import type { EncryptedBusinessCacheRecord, OfflineAuthProfile, OfflineBusinessCacheStore, OfflineReadSnapshot } from "../src/lib/offline/types.ts";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";

class MemoryCacheStore implements OfflineBusinessCacheStore {
  records: EncryptedBusinessCacheRecord[] = [];
  failReplacement = false;
  async replaceOfflineBusinessCache(records: EncryptedBusinessCacheRecord[]) {
    if (this.failReplacement) throw new Error("simulated write failure");
    this.records = records.map((record) => ({ ...record }));
  }
  async listOfflineBusinessCache(userId: string, device: string) { return this.records.filter((record) => record.userId === userId && record.deviceId === device); }
  async purgeOfflineBusinessCache(userId: string, device: string) { this.records = this.records.filter((record) => record.userId !== userId || record.deviceId !== device); }
}

const snapshot = (capturedAt = "2026-09-30T10:00:00.000Z"): OfflineReadSnapshot => ({
  capturedAt,
  catalogue: [{ productId: "product-1", productName: "Widget", productSku: "WIDGET-1", productBarcode: null, brandName: null, categoryName: null, serialized: false, variantId: null, variantLabel: null, variantSku: null, variantBarcode: null, condition: "NEW", quantity: 4, cataloguePriceId: "price-1", priceRevision: 1, sellingPrice: 1500 }],
  serializedInventory: [{ unitId: "unit-1", productId: "product-1", productName: "Widget", productSku: "WIDGET-1", productBarcode: null, productModel: null, brandName: null, categoryName: null, variantId: null, variantLabel: null, variantSku: null, variantBarcode: null, condition: "NEW", status: "AVAILABLE", sellingPrice: 1500, identifierType: "SERIAL", identifierValue: "SERIAL-001" }],
  sellableSerialized: [],
  customers: [{ customerId: "customer-1", fullName: "Ada Customer", phone: "08000000000", email: "ada@example.test", customerVersion: "2026-09-30T09:00:00.000Z" }],
  suppliers: [{ supplierId: "supplier-1", businessName: "Acme Supplier", contactName: "Ayo Contact", phone: "08001111111", email: "ayo@example.test", active: true, supplierVersion: "2026-09-30T09:00:00.000Z" }],
});

async function vaultKey(userId = userOne) {
  const crypto = createOfflineCryptoService(1);
  return (await crypto.createEnrollmentMaterial("eight-char", offlineBusinessCacheContext(userId, deviceId, "catalogue"))).vaultKey;
}

test("business snapshots are encrypted, complete, and readable only by their user and device", async () => {
  const store = new MemoryCacheStore();
  const key = await vaultKey();
  await refreshOfflineReadCache(store, { userId: userOne, deviceId, role: "STAFF", vaultKey: key }, snapshot(), { createId: () => "snapshot-1" });
  assert.equal(store.records.length, 5);
  assert.equal(new Set(store.records.map((record) => record.snapshotId)).size, 1);
  assert.doesNotMatch(JSON.stringify(store.records), /Widget|SERIAL-001|1500|Ada Customer|08000000000|ada@example\.test|Acme Supplier|Ayo Contact|08001111111|ayo@example\.test/);
  assert.doesNotMatch(readFileSync(new URL("../src/lib/offline/business-cache.ts", import.meta.url), "utf8"), /outbox/i);
  assert.deepEqual(await readOfflineReadCache(store, { userId: userOne, deviceId, role: "STAFF", vaultKey: key }), snapshot());
  assert.equal(await readOfflineReadCache(store, { userId: userTwo, deviceId, role: "STAFF", vaultKey: await vaultKey(userTwo) }), null);
});

test("a failed refresh retains the prior complete encrypted snapshot", async () => {
  const store = new MemoryCacheStore();
  const key = await vaultKey();
  await refreshOfflineReadCache(store, { userId: userOne, deviceId, role: "MANAGER", vaultKey: key }, snapshot(), { createId: () => "snapshot-1" });
  store.failReplacement = true;
  await assert.rejects(() => refreshOfflineReadCache(store, { userId: userOne, deviceId, role: "MANAGER", vaultKey: key }, snapshot("2026-09-30T11:00:00.000Z"), { createId: () => "snapshot-2" }));
  const cached = await readOfflineReadCache(store, { userId: userOne, deviceId, role: "MANAGER", vaultKey: key });
  assert.equal(cached?.capturedAt, "2026-09-30T10:00:00.000Z");
});

test("role change and deactivation purge encrypted business cache", async () => {
  const cache = new MemoryCacheStore();
  const key = await vaultKey();
  await refreshOfflineReadCache(cache, { userId: userOne, deviceId, role: "STAFF", vaultKey: key }, snapshot(), { createId: () => "snapshot-1" });
  let profile: OfflineAuthProfile | undefined = { userId: userOne, deviceId, displayName: "Ada", role: "STAFF", activeSnapshot: true, enrolledAt: "2026-09-30T09:00:00.000Z", lastOnlineVerifiedAt: "2026-09-30T09:00:00.000Z", cryptoVersion: "v1", kdfAlgorithm: "PBKDF2-SHA-256", kdfIterations: 1, kdfSalt: "salt", wrappedVaultKey: "wrapped", wrapIv: "iv", failedUnlockAttempts: 0, nextUnlockAllowedAt: null, updatedAt: "2026-09-30T09:00:00.000Z" };
  const store = {
    ...cache,
    getOfflineAuthProfile: async () => profile,
    listOfflineAuthProfiles: async () => profile ? [profile] : [],
    saveOfflineAuthProfile: async (next: OfflineAuthProfile) => { profile = next; },
    deleteOfflineAuthProfile: async () => { profile = undefined; },
    purgeOfflineBusinessCache: cache.purgeOfflineBusinessCache.bind(cache),
  };
  await reverifyOfflineAccess(store, { authenticatedUserId: userOne, profileUserId: userOne, displayName: "Ada", role: "MANAGER", active: true }, deviceId);
  assert.equal(cache.records.length, 0);
  await refreshOfflineReadCache(cache, { userId: userOne, deviceId, role: "MANAGER", vaultKey: key }, snapshot(), { createId: () => "snapshot-2" });
  await reverifyOfflineAccess(store, { authenticatedUserId: userOne, profileUserId: userOne, displayName: "Ada", role: "MANAGER", active: false }, deviceId);
  assert.equal(cache.records.length, 0);
  assert.equal(profile, undefined);
});

test("the authenticated snapshot boundary uses only approved read RPCs and forbids shared caching", () => {
  const source = readFileSync(new URL("../src/app/api/offline/read-snapshot/route.ts", import.meta.url), "utf8");
  assert.match(source, /getAuthenticatedProfile\(\)/);
  assert.match(source, /staff_offline_catalogue_snapshot/);
  assert.match(source, /staff_serialized_inventory_snapshot/);
  assert.match(source, /Cache-Control.*no-store/);
  assert.doesNotMatch(source, /\.from\(/);
  assert.doesNotMatch(source, /\b(POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(source, /\b(acquisition_cost|weighted_average_cost|wac|total_cogs|purchase_id)\b/i);
});
