export type SupplierReturnActionState = {
  status: "idle" | "success" | "error";
  message: string;
  submissionRequestId: string | null;
};

export const initialSupplierReturnActionState: SupplierReturnActionState = {
  status: "idle",
  message: "",
  submissionRequestId: null,
};
