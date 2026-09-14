export type SupplierRefundReceiptActionState = {
  status: "idle" | "success" | "error";
  message: string;
  submissionRequestId: string | null;
};

export const initialSupplierRefundReceiptActionState: SupplierRefundReceiptActionState = {
  status: "idle",
  message: "",
  submissionRequestId: null,
};
