"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { finalizeSupplierReturn } from "./supplier-return-actions";
import { initialSupplierReturnActionState } from "./supplier-return-state";

type Numeric = number | string;
type PaymentMethod = "CASH" | "POS" | "BANK_TRANSFER" | "OTHER";

export type ReturnableNonSerializedLine = {
  purchaseItemId: string;
  lineNumber: number;
  productName: string;
  variantLabel: string | null;
  condition: string;
  originalQuantity: number;
  returnedQuantity: number;
  returnableQuantity: number;
  unitCost: Numeric;
};

export type ReturnableSerializedUnit = {
  unitId: string;
  purchaseItemId: string;
  lineNumber: number;
  productName: string;
  variantLabel: string | null;
  condition: string;
  acquisitionCost: Numeric;
  identifiers: string;
};

type InitialRefundReceipt = {
  rowId: string;
  amount: string;
  method: PaymentMethod;
  receivedOn: string;
  reference: string;
  notes: string;
};

function createRequestId() { return crypto.randomUUID(); }
function formatCurrency(value: Numeric) { return `₦${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function label(value: string) { return value.replaceAll("_", " ").toLocaleLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function clampQuantity(value: string | undefined, maximum: number) {
  if (maximum <= 0) return "0";
  if (!value) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.min(Math.max(parsed, 0), maximum));
}

function Feedback({ status, message }: { status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle") return null;
  return <p className={`mt-3 text-sm ${status === "error" ? "text-red-700" : "text-emerald-700"}`} role="status">{message}</p>;
}

export function SupplierReturnForm({
  purchaseId,
  lagosToday,
  financialContext,
  nonSerializedLines,
  serializedUnits,
}: {
  purchaseId: string;
  lagosToday: string;
  financialContext: { originalTotal: Numeric; activeReturnValue: Numeric; netPayments: Numeric; remainingPayable: Numeric; paymentStatus: string };
  nonSerializedLines: ReturnableNonSerializedLine[];
  serializedUnits: ReturnableSerializedUnit[];
}) {
  const [state, action, pending] = useActionState(finalizeSupplierReturn, initialSupplierReturnActionState);
  const [requestId, setRequestId] = useState(() => state.submissionRequestId ?? createRequestId());
  const [returnedOn, setReturnedOn] = useState(lagosToday);
  const [supplierReference, setSupplierReference] = useState("");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  const [receipts, setReceipts] = useState<InitialRefundReceipt[]>([]);
  const [dismissedResultRequestId, setDismissedResultRequestId] = useState<string | null>(null);
  const submitted = useRef(false);
  const feedbackIsCurrent = state.submissionRequestId !== null
    && state.submissionRequestId === requestId
    && dismissedResultRequestId !== state.submissionRequestId;

  function materialChange() {
    const resultMatchesDraft = state.submissionRequestId !== null && state.submissionRequestId === requestId;
    if (resultMatchesDraft) {
      setDismissedResultRequestId(state.submissionRequestId);
    }
    if (submitted.current || resultMatchesDraft) {
      setRequestId(createRequestId());
      submitted.current = false;
    }
  }

  const returnableQuantityByPurchaseItem = useMemo(() => new Map(nonSerializedLines.map((line) => [
    line.purchaseItemId,
    Number(clampQuantity(quantities[line.purchaseItemId], line.returnableQuantity)),
  ])), [nonSerializedLines, quantities]);

  const returnLines = useMemo(() => [
    ...nonSerializedLines.flatMap((line) => {
      const quantity = returnableQuantityByPurchaseItem.get(line.purchaseItemId) ?? 0;
      return line.returnableQuantity > 0 && Number.isInteger(quantity) && quantity > 0 ? [{ purchase_item_id: line.purchaseItemId, serialized_unit_id: null, quantity }] : [];
    }),
    ...serializedUnits.filter((unit) => selectedUnitIds.has(unit.unitId)).map((unit) => ({ purchase_item_id: unit.purchaseItemId, serialized_unit_id: unit.unitId, quantity: 1 })),
  ], [nonSerializedLines, returnableQuantityByPurchaseItem, selectedUnitIds, serializedUnits]);
  const estimatedReturnValue = useMemo(() => {
    const nonSerialized = nonSerializedLines.reduce((total, line) => total + (returnableQuantityByPurchaseItem.get(line.purchaseItemId) ?? 0) * Number(line.unitCost), 0);
    const serialized = serializedUnits.filter((unit) => selectedUnitIds.has(unit.unitId)).reduce((total, unit) => total + Number(unit.acquisitionCost), 0);
    return nonSerialized + serialized;
  }, [nonSerializedLines, returnableQuantityByPurchaseItem, selectedUnitIds, serializedUnits]);
  const receiptPayload = receipts.map(({ amount, method, receivedOn, reference, notes }) => ({ amount, method, received_on: receivedOn, reference, notes }));
  const noReturnableLines = nonSerializedLines.every((line) => line.returnableQuantity <= 0) && serializedUnits.length === 0;

  function setQuantity(purchaseItemId: string, value: string, maximum: number) {
    materialChange();
    setQuantities((current) => ({ ...current, [purchaseItemId]: clampQuantity(value, maximum) }));
  }

  function toggleUnit(unitId: string) {
    materialChange();
    setSelectedUnitIds((current) => {
      const next = new Set(current);
      if (next.has(unitId)) next.delete(unitId); else next.add(unitId);
      return next;
    });
  }

  function updateReceipt(rowId: string, patch: Partial<InitialRefundReceipt>) {
    materialChange();
    setReceipts((current) => current.map((receipt) => receipt.rowId === rowId ? { ...receipt, ...patch } : receipt));
  }

  return <form action={action} className="space-y-5 p-4" onSubmit={() => { submitted.current = true; }}>
    <input name="requestId" type="hidden" value={requestId} />
    <input name="purchaseId" type="hidden" value={purchaseId} />
    <input name="lines" type="hidden" value={JSON.stringify(returnLines)} />
    <input name="initialRefundReceipts" type="hidden" value={JSON.stringify(receiptPayload)} />

    <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm"><p className="font-semibold text-[var(--tg-navy)]">Before this return</p><dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><div><dt className="text-slate-500">Original total</dt><dd>{formatCurrency(financialContext.originalTotal)}</dd></div><div><dt className="text-slate-500">Active return value</dt><dd>{formatCurrency(financialContext.activeReturnValue)}</dd></div><div><dt className="text-slate-500">Net payments</dt><dd>{formatCurrency(financialContext.netPayments)}</dd></div><div><dt className="text-slate-500">Remaining payable</dt><dd>{formatCurrency(financialContext.remainingPayable)}</dd></div><div><dt className="text-slate-500">Payment status</dt><dd>{label(financialContext.paymentStatus)}</dd></div></dl><p className="mt-3 text-slate-600">Supplier returns reduce remaining payable first. Only resulting supplier overpayment becomes refund entitlement.</p></div>

    <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium text-slate-700">Return date<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={lagosToday} name="returnedOn" onChange={(event) => { materialChange(); setReturnedOn(event.target.value); }} type="date" value={returnedOn} /></label><label className="block text-sm font-medium text-slate-700">Supplier return reference <span className="font-normal text-slate-500">(optional)</span><input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="supplierReference" onChange={(event) => { materialChange(); setSupplierReference(event.target.value); }} value={supplierReference} /></label></div>
    <label className="block text-sm font-medium text-slate-700">Reason<textarea required className="mt-1 min-h-20 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="reason" onChange={(event) => { materialChange(); setReason(event.target.value); }} value={reason} /></label>

    <div><h3 className="font-semibold text-[var(--tg-navy)]">Non-serialized purchase lines</h3><div className="mt-3 grid gap-3">{nonSerializedLines.map((line) => <article className="rounded border border-slate-200 p-3 text-sm" key={line.purchaseItemId}><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><p className="font-medium text-slate-900">Line {line.lineNumber} · {line.productName}{line.variantLabel ? ` · ${line.variantLabel}` : ""}</p><p className="mt-1 text-slate-600">{label(line.condition)} · Purchased {line.originalQuantity} · Previously returned {line.returnedQuantity} · Original unit cost {formatCurrency(line.unitCost)}</p><p className="mt-1 text-slate-600">Currently returnable: {line.returnableQuantity} <span className="text-xs">(database confirms final availability)</span></p></div>{line.returnableQuantity <= 0 ? <p className="text-sm font-medium text-slate-500">Fully returned</p> : <label className="block w-full text-sm font-medium text-slate-700 sm:w-36">Return quantity<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={line.returnableQuantity} min="0" onChange={(event) => setQuantity(line.purchaseItemId, event.target.value, line.returnableQuantity)} step="1" type="number" value={clampQuantity(quantities[line.purchaseItemId], line.returnableQuantity)} /></label>}</div></article>)}{nonSerializedLines.length === 0 ? <p className="text-sm text-slate-600">This purchase has no non-serialized lines.</p> : null}</div></div>

    <div><h3 className="font-semibold text-[var(--tg-navy)]">Available serialized units</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{serializedUnits.map((unit) => <label className="flex gap-3 rounded border border-slate-200 p-3 text-sm" key={unit.unitId}><input checked={selectedUnitIds.has(unit.unitId)} className="mt-1" onChange={() => toggleUnit(unit.unitId)} type="checkbox" /><span className="min-w-0"><span className="block font-medium text-slate-900">Line {unit.lineNumber} · {unit.productName}{unit.variantLabel ? ` · ${unit.variantLabel}` : ""}</span><span className="mt-1 block text-slate-600">{label(unit.condition)} · Acquisition cost {formatCurrency(unit.acquisitionCost)}</span><span className="mt-1 block break-words text-slate-600">{unit.identifiers}</span></span></label>)}{serializedUnits.length === 0 ? <p className="text-sm text-slate-600">No AVAILABLE serialized units from this purchase can be returned.</p> : null}</div></div>

    <div className="rounded border border-[var(--tg-gold)] bg-amber-50 p-3"><p className="text-sm font-semibold text-[var(--tg-navy)]">Estimated return value: {formatCurrency(estimatedReturnValue)}</p><p className="mt-1 text-xs text-slate-600">This preview uses original purchase-line costs and serialized acquisition costs. The database confirms the final value.</p></div>

    {!noReturnableLines ? <div><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold text-[var(--tg-navy)]">Initial refund receipts <span className="font-normal text-slate-500">(optional)</span></h3><p className="mt-1 text-sm text-slate-600">The database confirms the refund entitlement after assigning the immutable return order.</p></div><button className="app-button-secondary w-full px-3 sm:w-auto" onClick={() => { materialChange(); setReceipts((current) => [...current, { rowId: createRequestId(), amount: "", method: "CASH", receivedOn: lagosToday, reference: "", notes: "" }]); }} type="button">Add refund receipt</button></div><div className="mt-3 space-y-3">{receipts.map((receipt, index) => <article className="rounded border border-slate-200 p-3" key={receipt.rowId}><div className="mb-3 flex items-center justify-between"><p className="text-sm font-medium text-slate-900">Receipt {index + 1}</p><button className="text-sm font-medium text-red-700 underline" onClick={() => { materialChange(); setReceipts((current) => current.filter((item) => item.rowId !== receipt.rowId)); }} type="button">Remove</button></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="text-sm font-medium text-slate-700">Amount (₦)<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min="0.01" onChange={(event) => updateReceipt(receipt.rowId, { amount: event.target.value })} step="0.01" type="number" value={receipt.amount} /></label><label className="text-sm font-medium text-slate-700">Method<select className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateReceipt(receipt.rowId, { method: event.target.value as PaymentMethod })} value={receipt.method}><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></label><label className="text-sm font-medium text-slate-700">Received date<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={lagosToday} onChange={(event) => updateReceipt(receipt.rowId, { receivedOn: event.target.value })} type="date" value={receipt.receivedOn} /></label><label className="text-sm font-medium text-slate-700">Reference <span className="font-normal text-slate-500">(optional)</span><input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateReceipt(receipt.rowId, { reference: event.target.value })} value={receipt.reference} /></label><label className="text-sm font-medium text-slate-700 sm:col-span-2">Notes <span className="font-normal text-slate-500">(optional)</span><input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateReceipt(receipt.rowId, { notes: event.target.value })} value={receipt.notes} /></label></div></article>)}</div></div> : null}

    {noReturnableLines ? <div><p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">No items from this purchase are currently returnable.</p><Feedback message={feedbackIsCurrent ? state.message : ""} status={feedbackIsCurrent ? state.status : "idle"} /></div> : <div><button className="app-button-primary w-full px-4 sm:w-auto" disabled={pending} type="submit">{pending ? "Finalizing return…" : "Finalize supplier return"}</button><Feedback message={feedbackIsCurrent ? state.message : ""} status={feedbackIsCurrent ? state.status : "idle"} /></div>}
  </form>;
}
