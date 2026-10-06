import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { canonicalDecimal, createPurchaseReceivePayload, parsePurchaseReceivePayload, readPendingPurchaseReceives, readPurchaseReceiveReviews, submitPurchaseReceive } from "../src/lib/offline/purchase-receive.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { decryptEncryptedMutationPayload, enqueueEncryptedMutation, EncryptedMutationSyncEngine } from "../src/lib/offline/mutation-transport.ts";
import type { MutationExecutor } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const supplierId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
let sequence = 500;
const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

class MemoryStore implements EncryptedMutationStore {
  readonly records = new Map<string, EncryptedMutationEnvelope>();
  readonly conflicts = new Map<string, EncryptedMutationConflict>();
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async getEncryptedMutation(operationId: string) { return this.records.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async listEncryptedMutations(user: string, device: string) { return [...this.records.values()].filter((record) => record.userId === user && record.deviceId === device); }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { this.conflicts.set(conflict.operationId, conflict); }
  async listEncryptedMutationConflicts(user: string, device: string) { return [...this.conflicts.values()].filter((record) => record.userId === user && record.deviceId === device); }
}

async function identity() { const crypto = createOfflineCryptoService(1); return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", new TextEncoder().encode("purchase-receive"))).vaultKey }; }
const payload = () => createPurchaseReceivePayload({ supplierId, receivedOn: "2026-10-06", supplierReference: "SUP-42", notes: "Delivered intact", lines: [{ productId, variantId: null, condition: "NEW", quantity: 2, unitCostDecimal: "1250.5", notes: "Blue carton" }], initialPayments: [] });
async function queued(store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "PURCHASE_RECEIVE", payload: payload() }, { createId: nextId, now: () => "2026-10-06T09:00:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("PURCHASE_RECEIVE is the fifth and final registered executor", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE"]);
});

test("payload accepts only canonicalized decimal strings, positive integer nonserialized lines, and exact empty payments", () => {
  assert.equal(canonicalDecimal("1250.5"), "1250.50");
  assert.equal(canonicalDecimal("0"), "0.00");
  assert.throws(() => canonicalDecimal("001.00"));
  assert.throws(() => canonicalDecimal("1.234"));
  assert.throws(() => parsePurchaseReceivePayload({ ...payload(), initialPayments: [{ amount: "1.00" }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...payload(), serializedUnits: [] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...payload(), lines: [{ ...payload().lines[0], quantity: 1.5 }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...payload(), lines: [{ ...payload().lines[0], serializedUnits: [] }] }));
});

test("receipt intent is encrypted, user/device scoped, and its pending projection never changes stock", async () => {
  const { store, currentIdentity, record } = await queued();
  assert.doesNotMatch(JSON.stringify(record), /SUP-42|1250\.50|Blue carton|Delivered intact/);
  assert.deepEqual(await readPendingPurchaseReceives(store, currentIdentity), [{ ...payload(), operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingPurchaseReceives(store, { ...currentIdentity, deviceId: "55555555-5555-4555-8555-555555555555" }), []);
  const decrypted = await decryptEncryptedMutationPayload(currentIdentity, record) as { lines: Array<{ unitCostDecimal: string }> };
  assert.equal(decrypted.lines[0]?.unitCostDecimal, "1250.50");
});

test("pending and conflict projections stay encrypted until the active vault reads them", async () => {
  const { store, currentIdentity, record } = await queued();
  await store.updateEncryptedMutation({ ...(await store.getEncryptedMutation(record.operationId))!, state: "CONFLICT" });
  assert.deepEqual(await readPendingPurchaseReceives(store, currentIdentity), []);
  assert.deepEqual(await readPurchaseReceiveReviews(store, currentIdentity), [{ operationId: record.operationId, state: "CONFLICT" }]);
});

test("a lost response retries the same stable receipt identity and applies once", async () => {
  const { store, currentIdentity, record } = await queued();
  const committed = new Set<string>(); let calls = 0;
  const replay: MutationExecutor = async (operation) => submitPurchaseReceive(operation, async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; operationId: string; initialPayments: unknown[] };
    assert.equal(body.operationId, record.operationId); assert.equal(body.initialPayments.length, 0);
    committed.add(body.idempotencyKey); if (calls === 1) throw new Error("response lost after commit");
    return new Response(JSON.stringify({ purchaseId: nextId() }), { status: 200 });
  });
  const authorization = async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true });
  let now = "2026-10-06T09:00:00.000Z";
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, authorization, new Map([["PURCHASE_RECEIVE", replay]]), { now: () => now }).synchronize();
  now = "2026-10-06T09:00:11.000Z";
  await new EncryptedMutationSyncEngine(store, () => currentIdentity, authorization, new Map([["PURCHASE_RECEIVE", replay]]), { now: () => now }).synchronize();
  assert.equal(committed.size, 1); assert.equal((await store.getEncryptedMutation(record.operationId))?.state, "APPLIED");
});

test("terminal and transient receipt outcomes reveal no database detail", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "PURCHASE_RECEIVE", payload: payload() };
  assert.deepEqual(await submitPurchaseReceive(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 409 })), { kind: "CONFLICT", reasonCode: "PURCHASE_RECEIVE_CONFLICT" });
  assert.deepEqual(await submitPurchaseReceive(operation, async () => new Response(JSON.stringify({ detail: "private database error" }), { status: 422 })), { kind: "REJECTED", reasonCode: "PURCHASE_RECEIVE_REJECTED" });
  assert.deepEqual(await submitPurchaseReceive(operation, async () => new Response("", { status: 503 })), { kind: "TRANSIENT", statusCode: "PURCHASE_RECEIVE_TRANSIENT" });
});

test("route has a strict Manager-only no-payment/nonserialized RPC contract", () => {
  const route = readFileSync(new URL("../src/app/api/offline/mutations/purchase-receive/route.ts", import.meta.url), "utf8");
  assert.match(route, /profile\.role !== "MANAGER"/);
  assert.match(route, /initialPayments: z\.array\(z\.never\(\)\)\.length\(0\)/);
  assert.match(route, /lineSchema.*\.strict\(\)/);
  assert.match(route, /p_request_id: parsed\.data\.idempotencyKey/);
  assert.match(route, /serialized_units: \[\]/);
  assert.doesNotMatch(route, /weighted_average_cost|inventory_revision|total_cogs|acquisition_cost/i);
});

test("narrow source-only wrapper reauthorizes Manager and delegates all transaction semantics", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261006100000_phase6c_offline_purchase_receive.sql", import.meta.url), "utf8");
  assert.match(migration, /perform public\.require_active_profile\(\)/);
  assert.match(migration, /v_role is distinct from 'MANAGER'/);
  assert.match(migration, /jsonb_array_length\(p_initial_payments\) <> 0/);
  assert.match(migration, /OFFLINE_PURCHASE_RECEIVE_NON_SERIALIZED_ONLY/);
  assert.match(migration, /Preserve a completed existing receipt replay before considering mutable[\s\S]*where r\.request_id = p_request_id[\s\S]*if found and v_completed_at is not null[\s\S]*return public\.purchase_receive/);
  assert.match(migration, /return public\.purchase_receive\(/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /revoke all on function public\.offline_purchase_receive[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(migration, /weighted_average_cost|inventory_revision|insert into public\.stock_buckets/i);
});

test("offline receipt UI is Manager-only, uses cached references, and has no serialized/payment/local-authority path", () => {
  const ui = readFileSync(new URL("../src/app/offline/offline-purchase-receipt.tsx", import.meta.url), "utf8");
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  assert.match(ui, /activeSuppliers/); assert.match(ui, /snapshot\?\.catalogue/);
  assert.match(ui, /Only non-serialized items can be received offline/);
  assert.match(ui, /Payments, serialized units, purchase totals, WAC, and stock projections are unavailable here/);
  assert.match(ui, /initialPayments: \[\] as \[\]/);
  assert.match(ui, /Cached stock and WAC are not changed/);
  assert.match(fallback, /mode === "purchases"/);
  assert.match(fallback, /unlocked\.role !== "MANAGER"/);
  assert.doesNotMatch(ui, /enqueueOutbox|localStorage|sessionStorage/i);
});

test("purchase fallback is safe-route-only; service worker and legacy outbox never replay receipt data", () => {
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const database = readFileSync(new URL("../src/lib/offline/db.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/app/purchases/page.tsx", import.meta.url), "utf8");
  assert.match(page, /OfflineNormalRouteFallback mode="purchases"/);
  assert.match(worker, /"\/app\/purchases": "\/offline\/purchases"/);
  assert.match(worker, /"\/offline\/purchases"/);
  assert.doesNotMatch(worker, /purchase-receive|PURCHASE_RECEIVE|outbox|mutation/i);
  assert.doesNotMatch(database.slice(0, database.indexOf("encryptedMutationOutbox")), /PURCHASE_RECEIVE/i);
});
