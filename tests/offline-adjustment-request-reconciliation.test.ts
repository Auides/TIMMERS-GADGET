import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { offlineBusinessCacheContext, readOfflineAdjustmentRequestCache, refreshOfflineAdjustmentRequestCache } from "../src/lib/offline/business-cache.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import type { EncryptedBusinessCacheRecord, OfflineBusinessCacheStore } from "../src/lib/offline/types.ts";

const user = "11111111-1111-4111-8111-111111111111";
const device = "22222222-2222-4222-8222-222222222222";
const status = { adjustmentRequestId: "33333333-3333-4333-8333-333333333333", productId: "44444444-4444-4444-8444-444444444444", variantId: null, unitId: "55555555-5555-4555-8555-555555555555", condition: null, requestedQuantity: -1, reason: "Missing serialized unit", status: "OPEN" as const, requestedAt: "2026-10-08T09:00:00.000Z", reviewedAt: null, rejectionReason: null };

class MemoryCache implements OfflineBusinessCacheStore {
  records: EncryptedBusinessCacheRecord[] = [];
  async replaceOfflineBusinessCache(records: EncryptedBusinessCacheRecord[]) { this.records = records.map((record) => ({ ...record })); }
  async replaceOfflineAdjustmentRequestCache(record: EncryptedBusinessCacheRecord) { this.records = [...this.records.filter((candidate) => candidate.resource !== record.resource), { ...record }]; }
  async listOfflineBusinessCache(userId: string, deviceId: string) { return this.records.filter((record) => record.userId === userId && record.deviceId === deviceId); }
  async purgeOfflineBusinessCache(userId: string, deviceId: string) { this.records = this.records.filter((record) => record.userId !== userId || record.deviceId !== deviceId); }
}

async function key(forUser = user) {
  return (await createOfflineCryptoService(1).createEnrollmentMaterial("eight-char", offlineBusinessCacheContext(forUser, device, "adjustmentRequests"))).vaultKey;
}

test("authoritative request statuses are separately encrypted and user/device scoped", async () => {
  const store = new MemoryCache();
  const vaultKey = await key();
  await refreshOfflineAdjustmentRequestCache(store, { userId: user, deviceId: device, role: "STAFF", vaultKey }, [status], { now: () => "2026-10-08T09:10:00.000Z", createId: () => "status-snapshot" });
  assert.equal(store.records[0]?.resource, "adjustmentRequests");
  assert.doesNotMatch(JSON.stringify(store.records), /Missing serialized unit|55555555/);
  assert.deepEqual(await readOfflineAdjustmentRequestCache(store, { userId: user, deviceId: device, role: "STAFF", vaultKey }), [status]);
  assert.deepEqual(await readOfflineAdjustmentRequestCache(store, { userId: "99999999-9999-4999-8999-999999999999", deviceId: device, role: "STAFF", vaultKey: await key("99999999-9999-4999-8999-999999999999") }), []);
});

test("status boundary is read-only, role-filtered, and cost-safe", () => {
  const route = readFileSync(new URL("../src/app/api/offline/adjustment-request-statuses/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20261008091725_phase7ac_offline_adjustment_request_reconciliation.sql", import.meta.url), "utf8");
  assert.match(route, /profile\.role !== "STAFF" && profile\.role !== "MANAGER"/);
  assert.match(route, /offline_inventory_adjustment_request_status_snapshot/);
  assert.match(route, /Cache-Control.*no-store/);
  assert.doesNotMatch(route, /\.from\(/);
  assert.doesNotMatch(route, /acquisition_cost|weighted_average_cost|total_cogs|wac/i);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /v_role not in \('STAFF', 'MANAGER'\)/);
  assert.match(migration, /v_role = 'MANAGER' or request\.requested_by = auth\.uid\(\)/);
  assert.doesNotMatch(migration, /\b(insert|update|delete)\s+into\s+public\./i);
});

test("reconciliation preserves the exact seven-command registry and never makes status refresh an executor", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE", "SALE_CHECKOUT"]);
  const provider = readFileSync(new URL("../src/lib/offline/offline-auth-provider.tsx", import.meta.url), "utf8");
  assert.match(provider, /fetchOfflineAdjustmentRequestStatuses\(\)[\s\S]*refreshOfflineAdjustmentRequestCache[\s\S]*fetchOfflineReadSnapshot/);
  assert.match(provider, /Statuses never mutate local inventory|never change local inventory/);
  assert.doesNotMatch(provider, /enqueueOutbox/);
});

test("offline request UI distinguishes local, open, executed, and rejected states without local inventory authority", () => {
  const ui = readFileSync(new URL("../src/app/offline/offline-inventory-adjustment-request.tsx", import.meta.url), "utf8");
  assert.match(ui, /Pending request — not yet synced; no stock change\./);
  assert.match(ui, /Pending Admin review — no stock change yet\./);
  assert.match(ui, /Executed by Admin\./);
  assert.match(ui, /Rejected safely\./);
  assert.match(ui, /unlocked\.role === "ADMIN"/);
  assert.doesNotMatch(ui, /weightedAverageCost|inventoryRevision|localStorage|sessionStorage|enqueueOutbox/i);
});

test("Admin execution sends actual request values and asks for cost only for positive nonserialized work", () => {
  const form = readFileSync(new URL("../src/app/app/inventory/inventory-forms.tsx", import.meta.url), "utf8");
  assert.match(form, /const requiresCost=!unitId&&quantity>0/);
  assert.match(form, /name="unitCost"/);
  assert.match(form, /name="productId" value=\{productId\}/);
  assert.match(form, /name="quantity" value=\{quantity\}/);
  assert.doesNotMatch(form, /00000000-0000-0000-0000-000000000000/);
  assert.doesNotMatch(form, /<input name="quantity" value="-1" type="hidden"/);
});
