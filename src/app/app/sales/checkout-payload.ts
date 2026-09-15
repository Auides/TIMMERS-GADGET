export type SaleCondition = "NEW" | "USED" | "REFURBISHED";
export type SalePaymentMethod = "CASH" | "POS" | "BANK_TRANSFER" | "OTHER";

export type CheckoutCartLine = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantLabel: string | null;
  condition: SaleCondition;
  serialized: boolean;
  sellingPrice: number;
  quantity: number;
  availableQuantity: number | null;
  serializedUnitIds: string[];
  serializedIdentifiers: string[];
};

export type CheckoutPayment = {
  id: string;
  method: SalePaymentMethod;
  amount: string;
  reference: string;
  notes: string;
};

export function checkoutLineKey(line: Pick<CheckoutCartLine, "productId" | "variantId" | "condition">) {
  return `${line.productId}:${line.variantId ?? "base"}:${line.condition}`;
}

export function displayedCheckoutTotal(lines: CheckoutCartLine[]) {
  return lines.reduce((total, line) => total + line.sellingPrice * line.quantity, 0);
}

export function checkoutLinesRpcPayload(lines: CheckoutCartLine[]) {
  return lines.map((line) => ({
    product_id: line.productId,
    variant_id: line.variantId,
    condition: line.condition,
    quantity: line.quantity,
    serialized_unit_ids: line.serialized ? [...line.serializedUnitIds].sort() : [],
  }));
}

export function checkoutPaymentsRpcPayload(payments: CheckoutPayment[], paidOn: string) {
  return payments
    .map((payment) => ({
      amount: Number(payment.amount),
      method: payment.method,
      paid_on: paidOn,
      reference: payment.reference.trim() || null,
      notes: payment.notes.trim() || null,
    }))
    .filter((payment) => Number.isFinite(payment.amount) && payment.amount > 0);
}

export function paymentTotal(payments: CheckoutPayment[]) {
  return payments.reduce((total, payment) => {
    const amount = Number(payment.amount);
    return total + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}
