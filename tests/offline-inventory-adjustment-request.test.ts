import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { assertInventoryAdjustmentRequestEligible, createInventoryAdjustmentRequestPayload, parseInventoryAdjustmentRequestPayload, readInventoryAdjustmentRequestReviews, readPendingInventoryAdjustmentRequests, submitInventoryAdjustmentRequest } from "../src/lib/offline/inventory-adjustment-request.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { enqueueEncryptedMutation, EncryptedMutationSyncEngine } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "../src/lib/offline/types.ts";

const ids = { user: "11111111-1111-4111-8111-111111111111", device: "22222222-2222-4222-8222-222222222222", product: "33333333-3333-4333-8333-333333333333", unit: "44444444-4444-4444-8444-444444444444" };
let sequence = 600;
const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
class MemoryStore implements EncryptedMutationStore {
  records = new Map<string, EncryptedMutationEnvelope>(); conflicts = new Map<string, EncryptedMutationConflict>();
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async getEncryptedMutation(operationId: string) { return this.records.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async listEncryptedMutations(userId: string, deviceId: string) { return [...this.records.values()].filter((record) => record.userId === userId && record.deviceId === deviceId); }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { this.conflicts.set(conflict.operationId, conflict); }
  async listEncryptedMutationConflicts(userId: string, deviceId: string) { return [...this.conflicts.values()].filter((record) => record.userId === userId && record.deviceId === deviceId); }
}
async function identity() { const crypto = createOfflineCryptoService(1); return { userId: ids.user, deviceId: ids.device, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("adjustment-request"))).vaultKey }; }
const nonserialized = () => createInventoryAdjustmentRequestPayload({ kind: "NON_SERIALIZED", productId: ids.product, variantId: null, condition: "NEW", unitId: null, requestedQuantity: -2, reason: "  Count correction  " });
const serialized = () => createInventoryAdjustmentRequestPayload({ kind: "SERIALIZED", productId: ids.product, variantId: null, condition: null, unitId: ids.unit, requestedQuantity: -1, reason: "Missing unit" });

test("the sixth and only added offline command is INVENTORY_ADJUSTMENT_REQUEST_CREATE", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE"]);
});
test("only Staff and Managers may create or replay offline adjustment requests", () => {
  assert.doesNotThrow(() => assertInventoryAdjustmentRequestEligible("STAFF")); assert.doesNotThrow(() => assertInventoryAdjustmentRequestEligible("MANAGER")); assert.throws(() => assertInventoryAdjustmentRequestEligible("ADMIN"));
});
test("strict payload supports signed nonserialized intent and only the exact serialized -1 shape", () => {
  assert.deepEqual(nonserialized(), { kind: "NON_SERIALIZED", productId: ids.product, variantId: null, condition: "NEW", unitId: null, requestedQuantity: -2, reason: "Count correction" });
  assert.deepEqual(serialized(), { kind: "SERIALIZED", productId: ids.product, variantId: null, condition: null, unitId: ids.unit, requestedQuantity: -1, reason: "Missing unit" });
  for (const invalid of [{ ...nonserialized(), requestedQuantity: 0 }, { ...nonserialized(), unitId: ids.unit }, { ...serialized(), requestedQuantity: 1 }, { ...serialized(), condition: "NEW" }, { ...nonserialized(), weightedAverageCost: 12 }, { ...serialized(), identifierValue: "secret" }]) assert.throws(() => parseInventoryAdjustmentRequestPayload(invalid as JsonValue));
});
test("payload is AES-GCM ciphertext, user/device scoped, and never changes inventory projection", async () => {
  const currentIdentity = await identity(); const store = new MemoryStore(); const record = await enqueueEncryptedMutation(store, currentIdentity, { mutationType: "INVENTORY_ADJUSTMENT_REQUEST_CREATE", payload: serialized() }, { createId: nextId });
  assert.doesNotMatch(JSON.stringify(record), /Missing unit|44444444/);
  assert.deepEqual(await readPendingInventoryAdjustmentRequests(store, currentIdentity), [{ ...serialized(), operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingInventoryAdjustmentRequests(store, { ...currentIdentity, deviceId: nextId() }), []);
  await store.updateEncryptedMutation({ ...(await store.getEncryptedMutation(record.operationId))!, state: "CONFLICT" });
  assert.deepEqual(await readInventoryAdjustmentRequestReviews(store, currentIdentity), [{ operationId: record.operationId, state: "CONFLICT" }]);
});
test("lost response retries the exact idempotency identity and applies once", async () => {
  const currentIdentity = await identity(); const store = new MemoryStore(); const record = await enqueueEncryptedMutation(store, currentIdentity, { mutationType: "INVENTORY_ADJUSTMENT_REQUEST_CREATE", payload: serialized() }, { createId: nextId, now: () => "2026-10-07T10:00:00.000Z" });
  let calls = 0; const idempotencies = new Set<string>();
  const executor = async (operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }) => submitInventoryAdjustmentRequest(operation, async (_url, init) => { calls += 1; const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; unitId: string; requestedQuantity: number }; idempotencies.add(body.idempotencyKey); assert.equal(body.unitId, ids.unit); assert.equal(body.requestedQuantity, -1); if (calls === 1) throw new Error("response lost"); return new Response(JSON.stringify({ adjustmentRequestId: nextId() }), { status: 200 }); });
  const authorization = async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true });
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, authorization, new Map([["INVENTORY_ADJUSTMENT_REQUEST_CREATE", executor]]), { now: () => "2026-10-07T10:00:00.000Z" }).synchronize();
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, authorization, new Map([["INVENTORY_ADJUSTMENT_REQUEST_CREATE", executor]]), { now: () => "2026-10-07T10:00:11.000Z" }).synchronize();
  assert.equal(idempotencies.size, 1); assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});
test("stale serialized availability is terminal conflict and malformed intent is rejected", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "INVENTORY_ADJUSTMENT_REQUEST_CREATE", payload: serialized() };
  assert.deepEqual(await submitInventoryAdjustmentRequest(operation, async () => new Response("", { status: 409 })), { kind: "CONFLICT", reasonCode: "INVENTORY_ADJUSTMENT_REQUEST_CONFLICT" });
  assert.deepEqual(await submitInventoryAdjustmentRequest({ ...operation, payload: { bad: true } }, async () => new Response("", { status: 200 })), { kind: "REJECTED", reasonCode: "INVENTORY_ADJUSTMENT_REQUEST_REJECTED" });
});
test("source-only RPC is a hardened request-creation wrapper and never executes inventory", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261007152918_phase7a_offline_inventory_adjustment_request.sql", import.meta.url), "utf8");
  assert.match(migration, /offline_inventory_adjustment_request_operations[\s\S]*operation_id uuid primary key[\s\S]*idempotency_key uuid not null unique[\s\S]*adjustment_request_id uuid unique/);
  assert.match(migration, /perform public\.require_active_profile\(\)[\s\S]*current_role\(\) not in \('STAFF', 'MANAGER'\)/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /from public\.inventory_submit_adjustment_request\(/);
  assert.match(migration, /v_unit\.status <> 'AVAILABLE'[\s\S]*P0001/);
  assert.match(migration, /revoke all on function public\.offline_inventory_adjustment_request_create[\s\S]*from public, anon/);
  assert.match(migration, /grant execute on function public\.offline_inventory_adjustment_request_create[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /inventory_execute_adjustment|insert into public\.(stock_buckets|inventory_movements|inventory_bucket_effects|serialized_unit_lifecycle_effects|serialized_units)/i);
});
test("route and offline UI expose only a pending request, not approval or execution", () => {
  const route = readFileSync(new URL("../src/app/api/offline/mutations/inventory-adjustment-request/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/app/offline/offline-inventory-adjustment-request.tsx", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(route, /profile\.role !== "STAFF" && profile\.role !== "MANAGER"/); assert.match(route, /requestedQuantity: z\.literal\(-1\)/); assert.match(route, /offline_inventory_adjustment_request_create/);
  assert.match(ui, /Pending request; Not approved; No stock change\./); assert.match(ui, /Approval, rejection, and every inventory execution remain online-only Admin work/);
  assert.doesNotMatch(ui, /enqueueOutbox|localStorage|sessionStorage|weightedAverageCost|inventoryRevision/i); assert.doesNotMatch(worker, /inventory-adjustment-request|INVENTORY_ADJUSTMENT_REQUEST_CREATE|outbox|mutation/i);
});
