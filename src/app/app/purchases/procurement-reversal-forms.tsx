"use client";

import { useActionState, useRef, useState } from "react";
import { reversePurchase, reverseSupplierReturn } from "./procurement-reversal-actions";
import { initialProcurementReversalActionState } from "./procurement-reversal-state";

function createRequestId() { return crypto.randomUUID(); }

function Feedback({ status, message }: { status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle") return null;
  return <p className={`mt-3 text-sm ${status === "error" ? "text-red-700" : "text-emerald-700"}`} role="status">{message}</p>;
}

function useRelevantFeedback(actionState: typeof initialProcurementReversalActionState) {
  const [requestId, setRequestId] = useState(() => actionState.submissionRequestId ?? createRequestId());
  const [dismissedResultRequestId, setDismissedResultRequestId] = useState<string | null>(null);
  const submitted = useRef(false);
  const feedbackIsCurrent = actionState.submissionRequestId !== null
    && actionState.submissionRequestId === requestId
    && dismissedResultRequestId !== actionState.submissionRequestId;

  function materialChange() {
    const resultMatchesDraft = actionState.submissionRequestId !== null && actionState.submissionRequestId === requestId;
    if (resultMatchesDraft) {
      setDismissedResultRequestId(actionState.submissionRequestId);
    }
    if (submitted.current || resultMatchesDraft) {
      setRequestId(createRequestId());
      submitted.current = false;
    }
  }

  return { requestId, materialChange, feedbackIsCurrent, markSubmitted: () => { submitted.current = true; } };
}

function ReversalFields({ action, pending, requestId, materialChange, feedbackIsCurrent, markSubmitted, state, targetName, targetId, heading, confirmation, pendingLabel, submitLabel }: {
  action: (payload: FormData) => void;
  pending: boolean;
  requestId: string;
  materialChange: () => void;
  feedbackIsCurrent: boolean;
  markSubmitted: () => void;
  state: typeof initialProcurementReversalActionState;
  targetName: "supplierReturnId" | "purchaseId";
  targetId: string;
  heading: string;
  confirmation: string;
  pendingLabel: string;
  submitLabel: string;
}) {
  const [reason, setReason] = useState("");
  return <form action={action} className="rounded border border-red-200 bg-red-50/50 p-3" onSubmit={markSubmitted}>
    <input name="requestId" type="hidden" value={requestId} />
    <input name={targetName} type="hidden" value={targetId} />
    <p className="text-sm font-semibold text-red-800">{heading}</p>
    <p className="mt-1 text-sm text-slate-600">Final eligibility and safety checks are performed by the database when submitted.</p>
    <label className="mt-3 block text-sm font-medium text-slate-700">Reason<textarea required className="mt-1 min-h-20 w-full rounded border border-red-200 bg-white px-3 py-2 font-normal" name="reason" onChange={(event) => { materialChange(); setReason(event.target.value); }} value={reason} /></label>
    <label className="mt-3 flex items-start gap-2 text-sm text-slate-700"><input required className="mt-1" name="confirmation" onChange={materialChange} type="checkbox" value="yes" /><span>{confirmation}</span></label>
    <button className="mt-3 w-full rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto" disabled={pending} type="submit">{pending ? pendingLabel : submitLabel}</button>
    <Feedback message={feedbackIsCurrent ? state.message : ""} status={feedbackIsCurrent ? state.status : "idle"} />
  </form>;
}

export function ReverseSupplierReturnForm({ supplierReturnId }: { supplierReturnId: string }) {
  const [state, action, pending] = useActionState(reverseSupplierReturn, initialProcurementReversalActionState);
  const feedback = useRelevantFeedback(state);
  return <ReversalFields action={action} confirmation="I confirm that this supplier return should be reversed. The original return remains in history." heading="Reverse supplier return" pending={pending} pendingLabel="Reversing supplier return…" state={state} submitLabel="Confirm supplier return reversal" targetId={supplierReturnId} targetName="supplierReturnId" {...feedback} />;
}

export function ReversePurchaseForm({ purchaseId }: { purchaseId: string }) {
  const [state, action, pending] = useActionState(reversePurchase, initialProcurementReversalActionState);
  const feedback = useRelevantFeedback(state);
  return <ReversalFields action={action} confirmation="I confirm that this purchase should be reversed. The original purchase and its history remain visible." heading="Reverse purchase" pending={pending} pendingLabel="Reversing purchase…" state={state} submitLabel="Confirm purchase reversal" targetId={purchaseId} targetName="purchaseId" {...feedback} />;
}
