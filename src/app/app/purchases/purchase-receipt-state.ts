export type PurchaseReceiptRecoveryLine = {
  productId: string;
  variantId: string;
  condition: "NEW" | "USED" | "REFURBISHED";
  quantity: string;
  unitCost: string;
  notes: string;
  serializedUnits: Array<{
    acquisitionCost: string;
    imei1: string;
    imei2: string;
    serial: string;
    warrantyStart: string;
    warrantyExpiry: string;
  }>;
};

export type PurchaseReceiptRecovery = {
  requestId: string;
  supplierId: string;
  receivedOn: string;
  supplierReference: string;
  notes: string;
  lines: PurchaseReceiptRecoveryLine[];
  initialPayments: Array<{
    amount: string;
    method: "CASH" | "POS" | "BANK_TRANSFER" | "OTHER";
    paidOn: string;
    reference: string;
    notes: string;
  }>;
};

export type PurchaseReceiptActionState = {
  status: "idle" | "error";
  message: string;
  recovery: PurchaseReceiptRecovery | null;
  submissionRequestId: string | null;
};

export const initialPurchaseReceiptActionState: PurchaseReceiptActionState = {
  status: "idle",
  message: "",
  recovery: null,
  submissionRequestId: null,
};
