"use client";

import { useActionState, useRef, useState } from "react";
import { recordSupplierRefundReceipt, reverseSupplierRefundReceipt } from "./supplier-refund-receipt-actions";
import { initialSupplierRefundReceiptActionState } from "./supplier-refund-receipt-state";

type PaymentMethod = "CASH" | "POS" | "BANK_TRANSFER" | "OTHER";

function createRequestId() { return crypto.randomUUID(); }

function Feedback({ status, message }: { status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle") return null;
  return <p className={`mt-3 text-sm ${status === "error" ? "text-red-700" : "text-emerald-700"}`} role="status">{message}</p>;
}

function useRelevantFeedback(actionState: typeof initialSupplierRefundReceiptActionState) {
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

export function RecordSupplierRefundReceiptForm({ supplierReturnId, lagosToday, remainingRefundDue }: { supplierReturnId: string; lagosToday: string; remainingRefundDue: number | string }) {
  const [state, action, pending] = useActionState(recordSupplierRefundReceipt, initialSupplierRefundReceiptActionState);
  const { requestId, materialChange, feedbackIsCurrent, markSubmitted } = useRelevantFeedback(state);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [receivedOn, setReceivedOn] = useState(lagosToday);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  return <form action={action} className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={markSubmitted}>
    <input name="requestId" type="hidden" value={requestId} />
    <input name="supplierReturnId" type="hidden" value={supplierReturnId} />
    <label className="block text-sm font-medium text-slate-700">Amount (₦)<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={remainingRefundDue} min="0.01" name="amount" onChange={(event) => { materialChange(); setAmount(event.target.value); }} step="0.01" type="number" value={amount} /></label>
    <label className="block text-sm font-medium text-slate-700">Method<select className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="method" onChange={(event) => { materialChange(); setMethod(event.target.value as PaymentMethod); }} value={method}><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></label>
    <label className="block text-sm font-medium text-slate-700">Received date<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={lagosToday} name="receivedOn" onChange={(event) => { materialChange(); setReceivedOn(event.target.value); }} type="date" value={receivedOn} /></label>
    <label className="block text-sm font-medium text-slate-700">Reference <span className="font-normal text-slate-500">(optional)</span><input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="reference" onChange={(event) => { materialChange(); setReference(event.target.value); }} value={reference} /></label>
    <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Notes <span className="font-normal text-slate-500">(optional)</span><textarea className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="notes" onChange={(event) => { materialChange(); setNotes(event.target.value); }} value={notes} /></label>
    <div className="sm:col-span-2 lg:col-span-3"><button className="app-button-primary w-full px-4 sm:w-auto" disabled={pending} type="submit">{pending ? "Recording refund…" : "Record supplier refund"}</button><p className="mt-2 text-xs text-slate-600">The current refund due is verified by the database when this receipt is recorded.</p><Feedback message={feedbackIsCurrent ? state.message : ""} status={feedbackIsCurrent ? state.status : "idle"} /></div>
  </form>;
}

export function ReverseSupplierRefundReceiptForm({ refundReceiptId, purchaseId }: { refundReceiptId: string; purchaseId: string }) {
  const [state, action, pending] = useActionState(reverseSupplierRefundReceipt, initialSupplierRefundReceiptActionState);
  const { requestId, materialChange, feedbackIsCurrent, markSubmitted } = useRelevantFeedback(state);
  const [reason, setReason] = useState("");

  return <form action={action} className="mt-4 rounded border border-red-200 bg-red-50/50 p-3" onSubmit={markSubmitted}>
    <input name="requestId" type="hidden" value={requestId} />
    <input name="purchaseId" type="hidden" value={purchaseId} />
    <input name="refundReceiptId" type="hidden" value={refundReceiptId} />
    <p className="text-sm font-semibold text-red-800">Reverse refund receipt</p>
    <label className="mt-3 block text-sm font-medium text-slate-700">Reason<textarea required className="mt-1 min-h-20 w-full rounded border border-red-200 bg-white px-3 py-2 font-normal" name="reason" onChange={(event) => { materialChange(); setReason(event.target.value); }} value={reason} /></label>
    <label className="mt-3 flex items-start gap-2 text-sm text-slate-700"><input required className="mt-1" name="confirmation" onChange={materialChange} type="checkbox" value="yes" /><span>I confirm that this active supplier refund receipt should be reversed. The original receipt will remain in history.</span></label>
    <button className="mt-3 w-full rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto" disabled={pending} type="submit">{pending ? "Reversing refund…" : "Confirm refund reversal"}</button>
    <Feedback message={feedbackIsCurrent ? state.message : ""} status={feedbackIsCurrent ? state.status : "idle"} />
  </form>;
}
