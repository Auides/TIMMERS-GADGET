export type ProcurementReversalActionState = {
  status: "idle" | "success" | "error";
  message: string;
  submissionRequestId: string | null;
};

export const initialProcurementReversalActionState: ProcurementReversalActionState = {
  status: "idle",
  message: "",
  submissionRequestId: null,
};
