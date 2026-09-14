export type SupplierPaymentActionState = {
  status: "idle" | "success" | "error";
  message: string;
  submissionRequestId: string | null;
};

export const initialSupplierPaymentActionState: SupplierPaymentActionState = {
  status: "idle",
  message: "",
  submissionRequestId: null,
};
