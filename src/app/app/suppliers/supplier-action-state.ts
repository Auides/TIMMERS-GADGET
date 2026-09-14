export type SupplierActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialSupplierActionState: SupplierActionState = {
  status: "idle",
  message: "",
};
