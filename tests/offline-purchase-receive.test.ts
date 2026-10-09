import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOfflineCryptoService } from "../src/lib/offline/crypto.ts";
import { assertPurchaseReceiveEligible, canonicalDecimal, canonicalPositiveDecimal, createPurchaseReceivePayload, initialSupplierPaymentMethods, parsePurchaseReceivePayload, purchaseReceiveIdentifierTypes, readPendingPurchaseReceives, readPurchaseReceiveReviews, submitPurchaseReceive, type InitialSupplierPayment } from "../src/lib/offline/purchase-receive.ts";
import { registeredOfflineMutationExecutors } from "../src/lib/offline/mutation-executors.ts";
import { decryptEncryptedMutationPayload, enqueueEncryptedMutation, EncryptedMutationSyncEngine } from "../src/lib/offline/mutation-transport.ts";
import type { MutationExecutor } from "../src/lib/offline/mutation-transport.ts";
import type { EncryptedMutationConflict, EncryptedMutationEnvelope, EncryptedMutationStore } from "../src/lib/offline/types.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const supplierId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
const serializedProductId = "55555555-5555-4555-8555-555555555555";
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
const nonserializedPayload = () => createPurchaseReceivePayload({ supplierId, receivedOn: "2026-10-06", supplierReference: "SUP-42", notes: "Delivered intact", lines: [{ productId, variantId: null, condition: "NEW", quantity: 2, unitCostDecimal: "1250.5", notes: "Blue carton", serializedUnits: [] }], initialPayments: [] });
const serializedPayload = () => createPurchaseReceivePayload({ supplierId, receivedOn: "2026-10-06", supplierReference: "SUP-SERIAL", notes: "Serialized delivery", lines: [{ productId: serializedProductId, variantId: null, condition: "NEW", quantity: 1, unitCostDecimal: null, notes: "Sealed", serializedUnits: [{ acquisitionCostDecimal: "1500.5", warrantyStart: "2026-10-06", warrantyExpiry: "2027-10-06", identifiers: [{ type: "IMEI_1", value: "123456789012345" }, { type: "SERIAL", value: " serial-a " }] }] }], initialPayments: [] });
const initialPayment = (overrides: Partial<InitialSupplierPayment> = {}): InitialSupplierPayment => ({ amount: "1250.50", method: "CASH", paidOn: "2026-10-06", reference: "Receipt 42", notes: "Paid at delivery", ...overrides });
const unsafePayment = (overrides: Record<string, unknown> = {}) => ({ amount: "1250.50", method: "CASH", paidOn: "2026-10-06", reference: "Receipt 42", notes: "Paid at delivery", ...overrides });
async function queued(payload = nonserializedPayload(), store = new MemoryStore(), currentIdentity?: Awaited<ReturnType<typeof identity>>) {
  const unlockedIdentity = currentIdentity ?? await identity();
  const record = await enqueueEncryptedMutation(store, unlockedIdentity, { mutationType: "PURCHASE_RECEIVE", payload }, { createId: nextId, now: () => "2026-10-06T09:00:00.000Z" });
  return { store, currentIdentity: unlockedIdentity, record };
}

test("PURCHASE_RECEIVE remains fifth, adjustment request sixth, and checkout seventh", () => {
  assert.deepEqual([...registeredOfflineMutationExecutors.keys()], ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "PURCHASE_RECEIVE", "INVENTORY_ADJUSTMENT_REQUEST_CREATE", "SALE_CHECKOUT"]);
});

test("nonserialized and serialized receipt intent use canonical decimal strings and allow zero initial payments", () => {
  assert.equal(canonicalDecimal("1250.5"), "1250.50");
  assert.equal(canonicalDecimal("0"), "0.00");
  assert.equal(serializedPayload().lines[0]?.serializedUnits[0]?.acquisitionCostDecimal, "1500.50");
  assert.deepEqual(purchaseReceiveIdentifierTypes, ["IMEI_1", "IMEI_2", "SERIAL"]);
  assert.throws(() => canonicalDecimal("001.00"));
  assert.throws(() => canonicalDecimal("1.234"));
  assert.deepEqual(nonserializedPayload().initialPayments, []);
});

test("initial payment intent accepts every established method, normalizes optional text, and preserves canonical money", () => {
  assert.deepEqual(initialSupplierPaymentMethods, ["CASH", "POS", "BANK_TRANSFER", "OTHER"]);
  assert.equal(canonicalPositiveDecimal("12.5"), "12.50");
  assert.throws(() => canonicalPositiveDecimal("0"));
  for (const method of initialSupplierPaymentMethods) {
    const receipt = createPurchaseReceivePayload({ ...nonserializedPayload(), initialPayments: [initialPayment({ method, amount: "1.2", reference: "  Ref  ", notes: "  Note  " })] });
    assert.deepEqual(receipt.initialPayments[0], { amount: "1.20", method, paidOn: "2026-10-06", reference: "Ref", notes: "Note" });
  }
  const multiple = createPurchaseReceivePayload({ ...nonserializedPayload(), initialPayments: [initialPayment(), initialPayment({ amount: "2.00", method: "POS", reference: "", notes: "" })] });
  assert.equal(multiple.initialPayments.length, 2);
  assert.deepEqual(multiple.initialPayments[1], { amount: "2.00", method: "POS", paidOn: "2026-10-06", reference: null, notes: null });
});

test("initial payment intent rejects malformed, non-positive, unsupported, future-authority, and client financial fields", () => {
  for (const payment of [unsafePayment({ amount: "0.00" }), unsafePayment({ amount: "-1.00" }), unsafePayment({ amount: "1.234" }), unsafePayment({ method: "CARD" }), unsafePayment({ paidOn: "not-a-date" }), unsafePayment({ paymentId: nextId() }), unsafePayment({ supplierBalance: "0.00" }), unsafePayment({ remainingBalance: "1.00" })]) {
    assert.throws(() => parsePurchaseReceivePayload({ ...nonserializedPayload(), initialPayments: [payment] }));
  }
  // A syntactically valid future date remains admissible local intent; the
  // authoritative Lagos business-date check is intentionally server-side.
  assert.equal(createPurchaseReceivePayload({ ...nonserializedPayload(), initialPayments: [initialPayment({ paidOn: "2099-01-01" })] }).initialPayments[0]?.paidOn, "2099-01-01");
});

test("serialized receipt intent rejects authority fields, malformed identifiers, and quantity mismatches", () => {
  const line = serializedPayload().lines[0]!;
  assert.throws(() => parsePurchaseReceivePayload({ ...serializedPayload(), lines: [{ ...line, quantity: 2 }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...serializedPayload(), lines: [{ ...line, status: "AVAILABLE" }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...serializedPayload(), lines: [{ ...line, serializedUnits: [{ ...line.serializedUnits[0]!, lifecycleRevision: 1 }] }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...serializedPayload(), lines: [{ ...line, serializedUnits: [{ ...line.serializedUnits[0]!, identifiers: [{ type: "IMEI_1", value: "not-imei" }] }] }] }));
  assert.throws(() => parsePurchaseReceivePayload({ ...serializedPayload(), lines: [{ ...line, serializedUnits: [{ ...line.serializedUnits[0]!, identifiers: [{ type: "NOT_A_TYPE", value: "X" }] }] }] }));
});

test("only a Manager may queue or replay an offline purchase receipt", () => {
  assert.doesNotThrow(() => assertPurchaseReceiveEligible("MANAGER"));
  assert.throws(() => assertPurchaseReceiveEligible("STAFF"));
  assert.throws(() => assertPurchaseReceiveEligible("ADMIN"));
});

test("serialized identifiers and payment intent are ciphertext-only, user/device scoped, and never form an inventory projection", async () => {
  const receipt = createPurchaseReceivePayload({ ...serializedPayload(), initialPayments: [initialPayment({ amount: "99.99", reference: "BANK-REF", notes: "Financial note" })] });
  const { store, currentIdentity, record } = await queued(receipt);
  assert.doesNotMatch(JSON.stringify(record), /123456789012345|SERIAL-A|SUP-SERIAL|1500\.50|99\.99|BANK-REF|Financial note/);
  assert.deepEqual(await readPendingPurchaseReceives(store, currentIdentity), [{ ...receipt, operationId: record.operationId, state: "PENDING" }]);
  assert.deepEqual(await readPendingPurchaseReceives(store, { ...currentIdentity, deviceId: "66666666-6666-4666-8666-666666666666" }), []);
  const decrypted = await decryptEncryptedMutationPayload(currentIdentity, record) as { lines: Array<{ serializedUnits: Array<{ identifiers: Array<{ value: string }> }> }>; initialPayments: Array<{ amount: string; reference: string }> };
  assert.equal(decrypted.lines[0]?.serializedUnits[0]?.identifiers[0]?.value, "123456789012345");
  assert.deepEqual(decrypted.initialPayments[0], { amount: "99.99", method: "CASH", paidOn: "2026-10-06", reference: "BANK-REF", notes: "Financial note" });
});

test("pending and conflict reviews stay distinct from authoritative inventory until the active vault reads them", async () => {
  const { store, currentIdentity, record } = await queued(serializedPayload());
  await store.updateEncryptedMutation({ ...(await store.getEncryptedMutation(record.operationId))!, state: "CONFLICT" });
  assert.deepEqual(await readPendingPurchaseReceives(store, currentIdentity), []);
  assert.deepEqual(await readPurchaseReceiveReviews(store, currentIdentity), [{ operationId: record.operationId, state: "CONFLICT" }]);
});

test("a lost response retries the same serialized receipt and payment identity and applies once without self-conflict", async () => {
  const receipt = createPurchaseReceivePayload({ ...serializedPayload(), initialPayments: [initialPayment()] });
  const { store, currentIdentity, record } = await queued(receipt);
  const committed = new Set<string>(); let calls = 0;
  const replay: MutationExecutor = async (operation) => submitPurchaseReceive(operation, async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; initialPayments: unknown[]; lines: Array<{ serializedUnits: unknown[] }> };
    assert.deepEqual(body.initialPayments, [{ amount: "1250.50", method: "CASH", paidOn: "2026-10-06", reference: "Receipt 42", notes: "Paid at delivery" }]); assert.equal(body.lines[0]?.serializedUnits.length, 1);
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

test("duplicate identifier conflicts become terminal generic conflicts and never retry automatically", async () => {
  const operation = { operationId: nextId(), idempotencyKey: nextId(), mutationType: "PURCHASE_RECEIVE", payload: serializedPayload() };
  assert.deepEqual(await submitPurchaseReceive(operation, async () => new Response(JSON.stringify({ detail: "unit_identifiers secret" }), { status: 409 })), { kind: "CONFLICT", reasonCode: "PURCHASE_RECEIVE_CONFLICT" });
  assert.deepEqual(await submitPurchaseReceive(operation, async () => new Response("", { status: 422 })), { kind: "REJECTED", reasonCode: "PURCHASE_RECEIVE_REJECTED" });
});

test("source-only payment boundary is Manager-only, hardened, replay-first, and delegates rather than reimplements", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261006122959_phase6cd_offline_purchase_receive_payments.sql", import.meta.url), "utf8");
  assert.match(migration, /perform public\.require_active_profile\(\)/);
  assert.match(migration, /v_role is distinct from 'MANAGER'/);
  assert.match(migration, /jsonb_object_keys\(v_payment\)[\s\S]*'amount', 'method', 'paid_on', 'reference', 'notes'/);
  assert.match(migration, /\^\(0\|\[1-9\]\[0-9\]\{0,11\}\)\\\.\[0-9\]\{2\}\$/);
  assert.match(migration, /'CASH', 'POS', 'BANK_TRANSFER', 'OTHER'/);
  assert.match(migration, /INVALID_OFFLINE_PURCHASE_RECEIVE_PAYMENT[\s\S]*errcode = '22023'/);
  assert.match(migration, /v_line \? 'status'[\s\S]*v_line \? 'lifecycle_revision'[\s\S]*v_line \? 'unit_id'/);
  assert.match(migration, /completed retry is resolved before mutable catalogue checks[\s\S]*where r\.request_id = p_request_id[\s\S]*if found and v_completed_at is not null[\s\S]*return public\.purchase_receive/i);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(migration, /revoke all on function public\.offline_purchase_receive[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.offline_purchase_receive[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /insert into public\.(supplier_payments|purchases|stock_buckets|serialized_units|unit_identifiers|inventory_movements|serialized_unit_lifecycle_effects)/i);
});

test("authoritative purchase_receive retains server-generated serialized units, normalized global identifier uniqueness, effects, audit, and transaction atomicity", () => {
  const receipt = readFileSync(new URL("../supabase/migrations/20260911131747_phase6_procurement_transactional_workflows.sql", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../supabase/migrations/202608290001_initial_schema.sql", import.meta.url), "utf8");
  assert.match(schema, /create type public\.identifier_type as enum \('IMEI_1', 'IMEI_2', 'SERIAL'\)/);
  assert.match(schema, /unique\(normalized_value\)/);
  assert.match(schema, /identifier_type not in \('IMEI_1', 'IMEI_2'\)[\s\S]*\^\[0-9\]\{14,16\}\$/);
  assert.match(receipt, /v_reservation := public\.procurement_reserve[\s\S]*if v_reservation\.completed_at is not null then return v_reservation\.result/);
  assert.match(receipt, /for v_payment in select value from jsonb_array_elements\(coalesce\(p_initial_payments[\s\S]*v_payment_total > v_total[\s\S]*Initial payments cannot exceed the purchase total/);
  assert.match(receipt, /insert into public\.supplier_payments[\s\S]*perform public\.procurement_complete[\s\S]*perform public\.procurement_audit/);
  assert.match(receipt, /jsonb_array_length\(v_input -> 'serialized_units'\) <> v_quantity/);
  assert.match(receipt, /public\.normalize_identifier_value\(v_identifier ->> 'value'\)/);
  assert.match(receipt, /insert into public\.serialized_units[\s\S]*'AVAILABLE'[\s\S]*lifecycle_revision\)\s*values[\s\S]*1\)/);
  assert.match(receipt, /insert into public\.inventory_movements[\s\S]*insert into public\.serialized_unit_lifecycle_effects[\s\S]*perform public\.procurement_complete[\s\S]*perform public\.procurement_audit/);
  assert.doesNotMatch(receipt.slice(receipt.indexOf("create or replace function public.purchase_receive"), receipt.indexOf("create or replace function public.supplier_record_payment")), /\b(commit|rollback)\b/i);
});

test("route sends the actual serialized receipt and payment fields and maps failures safely", () => {
  const route = readFileSync(new URL("../src/app/api/offline/mutations/purchase-receive/route.ts", import.meta.url), "utf8");
  assert.match(route, /profile\.role !== "MANAGER"/);
  assert.match(route, /const initialPaymentSchema = z\.object\([\s\S]*amount: canonicalMoney\.refine[\s\S]*method: z\.enum\(\["CASH", "POS", "BANK_TRANSFER", "OTHER"\]\)[\s\S]*paidOn: z\.string\(\)\.date\(\)/);
  assert.match(route, /z\.enum\(\["IMEI_1", "IMEI_2", "SERIAL"\]\)/);
  assert.match(route, /acquisition_cost: unit\.acquisitionCostDecimal/);
  assert.match(route, /condition: line\.condition/);
  assert.match(route, /error\?\.code === "23505"[\s\S]*PURCHASE_RECEIVE_CONFLICT/);
  assert.match(route, /p_request_id: parsed\.data\.idempotencyKey/);
  assert.match(route, /p_initial_payments: parsed\.data\.initialPayments\.map\(\(payment\) => \(\{[\s\S]*paid_on: payment\.paidOn/);
  assert.doesNotMatch(route, /weighted_average_cost|inventory_revision|current_selling_price/i);
});

test("offline serialized receipt UI is Manager-only, uses encrypted existing references, and never uses the legacy outbox or local authority", () => {
  const ui = readFileSync(new URL("../src/app/offline/offline-purchase-receipt.tsx", import.meta.url), "utf8");
  const fallback = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
  assert.match(ui, /snapshot\?\.serializedInventory/);
  assert.match(ui, /Quantity is the exact number of serialized units below/);
  assert.match(ui, /Pending synchronization/);
  assert.match(ui, /Needs review after reconnect/);
  assert.match(ui, /Review encrypted pending intent/);
  assert.match(ui, /Initial payments \(optional\)/);
  assert.match(ui, /Not server-confirmed/);
  assert.match(ui, /payment history, and payable balances are not changed/);
  assert.match(fallback, /mode === "purchases"/);
  assert.match(fallback, /unlocked\.role !== "MANAGER"/);
  assert.doesNotMatch(ui, /enqueueOutbox|localStorage|sessionStorage|weightedAverageCost|inventoryRevision/i);
});

test("purchase fallback remains safe-route-only; service worker and legacy outbox never replay receipt data", () => {
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const database = readFileSync(new URL("../src/lib/offline/db.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/app/purchases/page.tsx", import.meta.url), "utf8");
  assert.match(page, /OfflineNormalRouteFallback mode="purchases"/);
  assert.match(worker, /"\/app\/purchases": "\/offline\/purchases"/);
  assert.match(worker, /"\/offline\/purchases"/);
  assert.doesNotMatch(worker, /purchase-receive|PURCHASE_RECEIVE|outbox|mutation/i);
  assert.doesNotMatch(database.slice(0, database.indexOf("encryptedMutationOutbox")), /PURCHASE_RECEIVE/i);
});
