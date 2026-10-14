import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertDistinctSerializedIdentifiers, assertUniqueSerializedIdentifierValues, normalizeSerializedIdentifierValue } from "../src/lib/serialized-identifier-validation.ts";
import { createPurchaseReceivePayload, parsePurchaseReceivePayload, type PurchaseReceivePayload, type SerializedPurchaseReceiveLine, type SerializedPurchaseUnit } from "../src/lib/offline/purchase-receive.ts";

const receipt = readFileSync(new URL("../supabase/migrations/20260911131747_phase6_procurement_transactional_workflows.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../supabase/migrations/202608290001_initial_schema.sql", import.meta.url), "utf8");
const openingAction = readFileSync(new URL("../src/app/app/inventory/inventory-actions.ts", import.meta.url), "utf8");
const openingForm = readFileSync(new URL("../src/app/app/inventory/inventory-forms.tsx", import.meta.url), "utf8");
const productMigration = readFileSync(new URL("../supabase/migrations/202608290002_catalogue_master_data.sql", import.meta.url), "utf8");
const offlineRoute = readFileSync(new URL("../src/app/api/offline/mutations/purchase-receive/route.ts", import.meta.url), "utf8");
const diagnostic = readFileSync(new URL("../supabase/migrations/20261013123309_phase7bd_serialized_unit_integrity_preflight.sql", import.meta.url), "utf8");

const ids = (identifiers: Array<{ type: "IMEI_1" | "IMEI_2" | "SERIAL"; value: string }>): PurchaseReceivePayload => {
  const unit: SerializedPurchaseUnit = { acquisitionCostDecimal: "1500.00", warrantyStart: null, warrantyExpiry: null, identifiers };
  return {
  supplierId: "11111111-1111-4111-8111-111111111111",
  receivedOn: "2026-10-13",
  supplierReference: null,
  notes: null,
  initialPayments: [],
  lines: [{
    productId: "22222222-2222-4222-8222-222222222222", variantId: "33333333-3333-4333-8333-333333333333", condition: "NEW", quantity: 1,
    unitCostDecimal: null,
    notes: null,
    serializedUnits: [unit],
  }],
  };
};

function serializedLine(payload: PurchaseReceivePayload): SerializedPurchaseReceiveLine {
  const line = payload.lines[0];
  if (!line || line.unitCostDecimal !== null) throw new Error("Expected serialized purchase line.");
  return line;
}

test("one physical serialized unit retains every valid identifier combination", () => {
  for (const identifiers of [
    [{ type: "IMEI_1" as const, value: "111111111111111" }],
    [{ type: "SERIAL" as const, value: "abc123" }],
    [{ type: "IMEI_1" as const, value: "111111111111111" }, { type: "SERIAL" as const, value: "abc123" }],
    [{ type: "IMEI_1" as const, value: "111111111111111" }, { type: "IMEI_2" as const, value: "222222222222222" }],
    [{ type: "IMEI_1" as const, value: "111111111111111" }, { type: "IMEI_2" as const, value: "222222222222222" }, { type: "SERIAL" as const, value: "abc123" }],
  ]) {
    const payload = createPurchaseReceivePayload(ids(identifiers));
    assert.equal(payload.lines[0]?.quantity, 1);
    assert.equal(payload.lines[0]?.serializedUnits.length, 1);
    assert.equal(payload.lines[0]?.serializedUnits[0]?.identifiers.length, identifiers.length);
  }
});

test("identifier normalization is stable and duplicate type or value is rejected before replay", () => {
  assert.equal(normalizeSerializedIdentifierValue(" serial-a "), "SERIAL-A");
  assert.throws(() => assertDistinctSerializedIdentifiers([{ type: "IMEI_1", value: "111111111111111" }, { type: "IMEI_2", value: "111111111111111" }]));
  assert.throws(() => assertDistinctSerializedIdentifiers([{ type: "SERIAL", value: "A" }, { type: "SERIAL", value: "B" }]));
  assert.throws(() => parsePurchaseReceivePayload(ids([{ type: "IMEI_1", value: "111111111111111" }, { type: "IMEI_2", value: " 111111111111111 " }])));
});

test("a receipt cannot reuse an identifier across physical-unit cards", () => {
  const payload = ids([{ type: "IMEI_1", value: "111111111111111" }]);
  const line = serializedLine(payload);
  line.quantity = 2;
  line.serializedUnits.push({ acquisitionCostDecimal: "1500.00", warrantyStart: null, warrantyExpiry: null, identifiers: [{ type: "SERIAL", value: "111111111111111" }] });
  assert.throws(() => parsePurchaseReceivePayload(payload));
});

test("different physical units may each have an IMEI1, but not the same normalized value", () => {
  assert.doesNotThrow(() => assertUniqueSerializedIdentifierValues([
    { type: "IMEI_1", value: "111111111111111" },
    { type: "IMEI_1", value: "222222222222222" },
  ]));
  assert.throws(() => assertUniqueSerializedIdentifierValues([
    { type: "IMEI_1", value: "111111111111111" },
    { type: "SERIAL", value: " 111111111111111 " },
  ]));
});

test("two serialized purchase unit cards retain two physical units regardless of identifier count", () => {
  const payload = ids([{ type: "IMEI_1", value: "111111111111111" }, { type: "SERIAL", value: "first" }]);
  const line = serializedLine(payload);
  line.quantity = 2;
  line.serializedUnits.push({
    acquisitionCostDecimal: "1500.00", warrantyStart: null, warrantyExpiry: null,
    identifiers: [{ type: "IMEI_1", value: "222222222222222" }, { type: "SERIAL", value: "second" }],
  });
  const parsed = parsePurchaseReceivePayload(payload);
  assert.equal(parsed.lines[0]?.quantity, 2);
  assert.equal(parsed.lines[0]?.serializedUnits.length, 2);
  assert.equal(parsed.lines[0]?.serializedUnits.flatMap((unit) => unit.identifiers).length, 4);
});

test("authoritative opening stock creates one unit, then attaches every identifier to it", () => {
  assert.match(openingForm, /Quantity: 1 serialized unit/);
  assert.match(openingForm, /Identifiers belong to this physical unit/);
  assert.match(openingAction, /Serialized stock quantity must be exactly one/);
  assert.match(openingAction, /assertDistinctSerializedIdentifiers\(identifiers\)/);
  const opening = receipt.slice(receipt.indexOf("create or replace function public.inventory_record_opening_stock"));
  assert.match(opening, /insert into public\.serialized_units[\s\S]*returning \* into v_unit[\s\S]*for v_identifier[\s\S]*unit_id,identifier_type,normalized_value\)values\(v_unit\.id/);
  assert.match(opening, /inventory_movements[\s\S]*unit_id[\s\S]*'OPENING_STOCK',1/);
});

test("authoritative receipt creates one unit per unit card, never per identifier", () => {
  const purchase = receipt.slice(receipt.indexOf("create or replace function public.purchase_receive"), receipt.indexOf("create or replace function public.supplier_record_payment"));
  assert.match(purchase, /jsonb_array_length\(v_input -> 'serialized_units'\) <> v_quantity/);
  assert.match(purchase, /for v_serial_input[\s\S]*insert into public\.serialized_units[\s\S]*returning \* into v_unit[\s\S]*for v_identifier[\s\S]*unit_id, identifier_type, normalized_value\)[\s\S]*v_unit\.id/);
  assert.match(purchase, /inventory_movements[\s\S]*'PURCHASE', 1/);
});

test("database constraints, idempotency, checkout de-duplication, and offline delegation remain intact", () => {
  assert.match(schema, /unique\(normalized_value\)[\s\S]*unique\(unit_id, identifier_type\)[\s\S]*unique\(unit_id, normalized_value\)/);
  assert.match(receipt, /if v_reservation\.completed_at is not null then return v_reservation\.result/);
  assert.match(offlineRoute, /rpc\("offline_purchase_receive"/);
  assert.doesNotMatch(offlineRoute, /insert into public\.(serialized_units|unit_identifiers)/i);
  const sales = readFileSync(new URL("../src/app/app/sales/actions.ts", import.meta.url), "utf8");
  assert.match(sales, /staff_sellable_serialized_lookup_v2/);
  assert.match(sales, /Array\.isArray\(row\.identifiers\)/);
  assert.match(sales, /unitId: row\.unit_id/);
});

test("product creation does not create inventory and the read-only diagnostic is hardened", () => {
  const createProduct = productMigration.slice(productMigration.indexOf("create or replace function public.catalogue_create_product"), productMigration.indexOf("create or replace function public.catalogue_update_product"));
  assert.doesNotMatch(createProduct, /serialized_units|unit_identifiers|opening_stock/i);
  assert.match(diagnostic, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/);
  assert.match(diagnostic, /DUPLICATE_IDENTIFIER_VALUE[\s\S]*MULTIPLE_UNITS_FOR_OPENING_STOCK_LINE[\s\S]*PURCHASE_ITEM_UNIT_COUNT_EXCEEDS_QUANTITY/);
  assert.match(diagnostic, /revoke all on function public\.serialized_unit_integrity_preflight\(\) from public, anon, authenticated/);
  assert.doesNotMatch(diagnostic, /\b(insert into|update public|delete from)\s+public\./i);
});
