import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutLinesRpcPayload,
  checkoutPaymentsRpcPayload,
  displayedCheckoutTotal,
  paymentTotal,
  type CheckoutCartLine,
  type CheckoutPayment,
} from "../src/app/app/sales/checkout-payload.ts";

const lines: CheckoutCartLine[] = [
  {
    productId: "11111111-1111-4111-8111-111111111111",
    variantId: null,
    productName: "Earphones",
    variantLabel: null,
    condition: "NEW",
    serialized: false,
    sellingPrice: 100,
    quantity: 2,
    availableQuantity: 5,
    serializedUnitIds: [],
    serializedIdentifiers: [],
  },
  {
    productId: "22222222-2222-4222-8222-222222222222",
    variantId: null,
    productName: "Phone",
    variantLabel: null,
    condition: "NEW",
    serialized: true,
    sellingPrice: 500,
    quantity: 2,
    availableQuantity: null,
    serializedUnitIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    serializedIdentifiers: ["SERIAL: B", "SERIAL: A"],
  },
];

test("displayed checkout total uses current UI price snapshots", () => {
  assert.equal(displayedCheckoutTotal(lines), 1200);
});

test("RPC line payload excludes client price totals and sorts serialized unit IDs", () => {
  assert.deepEqual(checkoutLinesRpcPayload(lines), [
    {
      product_id: "11111111-1111-4111-8111-111111111111",
      variant_id: null,
      condition: "NEW",
      quantity: 2,
      serialized_unit_ids: [],
    },
    {
      product_id: "22222222-2222-4222-8222-222222222222",
      variant_id: null,
      condition: "NEW",
      quantity: 2,
      serialized_unit_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    },
  ]);
});

test("payment payload normalizes optional reference and excludes non-positive rows", () => {
  const payments: CheckoutPayment[] = [
    { id: "a", method: "CASH", amount: "200", reference: "", notes: "" },
    { id: "b", method: "BANK_TRANSFER", amount: "1000", reference: " REF-1 ", notes: " Transfer " },
    { id: "c", method: "POS", amount: "0", reference: "", notes: "" },
  ];
  assert.equal(paymentTotal(payments), 1200);
  assert.deepEqual(checkoutPaymentsRpcPayload(payments, "2026-09-15"), [
    { amount: 200, method: "CASH", paid_on: "2026-09-15", reference: null, notes: null },
    { amount: 1000, method: "BANK_TRANSFER", paid_on: "2026-09-15", reference: "REF-1", notes: "Transfer" },
  ]);
});
