import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService, offlineCryptoContext } from "../src/lib/offline/crypto.ts";
import { createEncryptedMutationEnvelope, decryptEncryptedMutationPayload, EncryptedMutationSyncEngine, type MutationExecutor } from "../src/lib/offline/mutation-transport.ts";
import { assertOfflineSaleCheckoutEligible, createOfflineSaleCheckoutPayload, parseOfflineSaleCheckoutPayload, submitOfflineSaleCheckout } from "../src/lib/offline/sale-checkout.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
let sequence = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const payload = () => ({ schemaVersion: 1 as const, businessDate: "2026-10-09", customerId: null, notes: null, dependencies: [], lines: [{ productId: "33333333-3333-4333-8333-333333333333", variantId: null, condition: "NEW" as const, quantity: 2, quote: { cataloguePriceId: "44444444-4444-4444-8444-444444444444", priceRevision: 3, quotedSellingPrice: "1250.50" } }], payment: { method: "CASH" as const, amount: "2501.00" } });

class MemoryStore implements EncryptedMutationStore {
  records = new Map<string, EncryptedMutationEnvelope>(); conflicts = new Map<string, EncryptedMutationConflict>();
  async addEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async getEncryptedMutation(operationId: string) { return this.records.get(operationId); }
  async updateEncryptedMutation(record: EncryptedMutationEnvelope) { this.records.set(record.operationId, { ...record }); }
  async listEncryptedMutations(currentUserId: string, currentDeviceId: string) { return [...this.records.values()].filter((record) => record.userId === currentUserId && record.deviceId === currentDeviceId); }
  async addEncryptedMutationConflict(conflict: EncryptedMutationConflict) { this.conflicts.set(conflict.operationId, { ...conflict }); }
  async listEncryptedMutationConflicts() { return [...this.conflicts.values()]; }
}
async function identity() {
  const crypto = createOfflineCryptoService();
  return { userId, deviceId, vaultKey: (await crypto.createEnrollmentMaterial("eight-char", offlineCryptoContext(userId, deviceId))).vaultKey };
}

test("SALE_CHECKOUT is exactly the seventh registered offline command", () => {
  const registry = readFileSync(new URL("../src/lib/offline/mutation-executors.ts", import.meta.url), "utf8");
  const types = [...registry.matchAll(/\["([A-Z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(types, ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE", "SALE_CHECKOUT"]);
});

test("strict encrypted payload accepts only a cash-only nonserialized quote intent", () => {
  assert.deepEqual(createOfflineSaleCheckoutPayload(payload()), payload());
  assert.doesNotThrow(() => assertOfflineSaleCheckoutEligible("STAFF"));
  assert.doesNotThrow(() => assertOfflineSaleCheckoutEligible("MANAGER"));
  assert.throws(() => assertOfflineSaleCheckoutEligible("ADMIN"));
  for (const unsafe of [
    { ...payload(), payment: { method: "POS", amount: "2501.00" } },
    { ...payload(), payment: { method: "CASH", amount: "1.00" } },
    { ...payload(), discount: "1.00" },
    { ...payload(), creditRequestId: nextId() },
    { ...payload(), lines: [{ ...payload().lines[0], serializedUnitIds: [nextId()] }] },
    { ...payload(), dependencies: ["55555555-5555-4555-8555-555555555555", "55555555-5555-4555-8555-555555555555"] },
  ]) assert.throws(() => parseOfflineSaleCheckoutPayload(unsafe as JsonValue));
});

test("sale intent is AES-GCM ciphertext scoped to the vault user/device and contains no cost", async () => {
  const current = await identity(); const record = await createEncryptedMutationEnvelope(current, { mutationType: "SALE_CHECKOUT", payload: payload() }, { createId: nextId });
  assert.doesNotMatch(JSON.stringify(record), /1250\.50|2501\.00|weighted_average_cost|acquisition_cost|COGS/i);
  assert.deepEqual(await decryptEncryptedMutationPayload(current, record), payload());
  await assert.rejects(() => decryptEncryptedMutationPayload({ ...current, deviceId: nextId() }, record));
});

test("checkout replay sends stable idempotency identity and only narrow safe fields", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "SALE_CHECKOUT", payload: payload() as JsonValue };
  const result = await submitOfflineSaleCheckout(operation, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operationId, operation.operationId); assert.equal(body.idempotencyKey, operation.idempotencyKey);
    assert.equal(body.payment.method, "CASH"); assert.equal(body.lines[0].quote.priceRevision, 3);
    assert.equal("weightedAverageCost" in body, false); assert.equal("saleNumber" in body, false);
    return new Response(JSON.stringify({ sale: { sale_id: nextId() } }), { status: 200 });
  });
  assert.deepEqual(result, { kind: "APPLIED" });
  assert.deepEqual(await submitOfflineSaleCheckout(operation, async () => new Response("", { status: 409 })), { kind: "CONFLICT", reasonCode: "SALE_CHECKOUT_CONFLICT" });
});

test("dependency-aware replay waits for customer creation then permits the dependent sale", async () => {
  const current = await identity(); const store = new MemoryStore();
  const customer = await createEncryptedMutationEnvelope(current, { mutationType: "CUSTOMER_CREATE", payload: { customerId: nextId(), fullName: "Customer", phone: null, email: null } }, { createId: nextId, now: () => "2026-10-09T10:00:00.000Z" });
  const sale = await createEncryptedMutationEnvelope(current, { mutationType: "SALE_CHECKOUT", payload: { ...payload(), dependencies: [customer.operationId] } }, { createId: nextId, now: () => "2026-10-09T10:01:00.000Z" });
  await store.addEncryptedMutation(customer); await store.addEncryptedMutation(sale);
  const calls: string[] = [];
  const executor: MutationExecutor = async (operation) => { calls.push(operation.mutationType); return { kind: "APPLIED" }; };
  await new EncryptedMutationSyncEngine(store, () => current, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map([["CUSTOMER_CREATE", executor], ["SALE_CHECKOUT", executor]]), { now: () => "2026-10-09T11:00:00.000Z" }).synchronize();
  assert.deepEqual(calls, ["CUSTOMER_CREATE", "SALE_CHECKOUT"]);
  assert.equal((await store.getEncryptedMutation(sale.operationId))?.state, "APPLIED");
});

test("rejected dependency safely conflicts its checkout and self dependency is rejected", async () => {
  const current = await identity(); const store = new MemoryStore();
  const failed = await createEncryptedMutationEnvelope(current, { mutationType: "CUSTOMER_CREATE", payload: { customerId: nextId(), fullName: "Customer", phone: null, email: null } }, { createId: nextId });
  await store.addEncryptedMutation({ ...failed, state: "REJECTED" });
  const blocked = await createEncryptedMutationEnvelope(current, { mutationType: "SALE_CHECKOUT", payload: { ...payload(), dependencies: [failed.operationId] } }, { createId: nextId });
  await store.addEncryptedMutation(blocked);
  await new EncryptedMutationSyncEngine(store, () => current, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map(), { now: () => "2026-10-09T11:00:00.000Z" }).synchronize();
  assert.equal((await store.getEncryptedMutation(blocked.operationId))?.state, "CONFLICT");

  const selfOperationId = nextId();
  const selfDependent = await createEncryptedMutationEnvelope(
    current,
    { mutationType: "SALE_CHECKOUT", payload: { ...payload(), dependencies: [selfOperationId] } },
    { createId: (() => { let calls = 0; return () => ++calls === 1 ? selfOperationId : nextId(); })() },
  );
  await store.addEncryptedMutation(selfDependent);
  await new EncryptedMutationSyncEngine(store, () => current, async () => ({ hasAuthenticatedSession: true, hasActiveProfile: true }), new Map(), { now: () => "2026-10-09T11:01:00.000Z" }).synchronize();
  assert.equal((await store.getEncryptedMutation(selfOperationId))?.state, "REJECTED");
});

test("source-only migration enforces exact quote, replay-first reservation, and delegates finalization", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261009080116_phase7bb_provisional_offline_cash_checkout.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/offline/mutations/sale-checkout/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/app/offline/offline-sale-checkout.tsx", import.meta.url), "utf8");
  assert.match(migration, /quote_revision bigint not null default 1/);
  assert.match(migration, /staff_offline_catalogue_snapshot/);
  assert.match(migration, /on conflict do nothing[\s\S]*where request_id = p_request_id[\s\S]*IDEMPOTENCY_MISMATCH/);
  assert.match(migration, /v_reservation\.completed_at is not null[\s\S]*return v_reservation\.result/);
  assert.match(migration, /v_price\.quote_revision <> v_quote_revision[\s\S]*v_price\.selling_price <> v_quote_price/);
  assert.match(migration, /public\.sales_finalize_checkout\(/);
  assert.doesNotMatch(migration, /insert into public\.(sales|sale_lines|sale_payments|stock_buckets|inventory_movements)/i);
  assert.match(route, /\["STAFF", "MANAGER"\]/); assert.match(route, /z\.literal\("CASH"\)/);
  assert.doesNotMatch(route, /WAC|acquisition.?cost|serializedUnitIds/i);
  assert.match(ui, /Local pending sale/); assert.match(ui, /Awaiting synchronization/); assert.match(ui, /OFFLINE-/); assert.doesNotMatch(ui, /server-confirmed sale/i);
});
