"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { receivePurchase } from "./purchase-receipt-actions";
import { initialPurchaseReceiptActionState, type PurchaseReceiptActionState, type PurchaseReceiptRecovery } from "./purchase-receipt-state";

type SupplierOption = { id: string; business_name: string; contact_name: string | null };
type ProductOption = { id: string; name: string; sku: string; serialized: boolean };
type VariantOption = { id: string; product_id: string; label: string; sku: string | null };
type Condition = "NEW" | "USED" | "REFURBISHED";
type SerializedUnit = { key: number; acquisitionCost: string; imei1: string; imei2: string; serial: string; warrantyStart: string; warrantyExpiry: string };
type PurchaseLine = { key: number; productId: string; variantId: string; condition: Condition; quantity: string; unitCost: string; notes: string; serializedUnits: SerializedUnit[] };
type InitialPayment = { key: number; amount: string; method: "CASH" | "POS" | "BANK_TRANSFER" | "OTHER"; paidOn: string; reference: string; notes: string };

function createRequestId() { return crypto.randomUUID(); }
function emptyUnit(key: number): SerializedUnit { return { key, acquisitionCost: "", imei1: "", imei2: "", serial: "", warrantyStart: "", warrantyExpiry: "" }; }
function emptyLine(key: number): PurchaseLine { return { key, productId: "", variantId: "", condition: "NEW", quantity: "1", unitCost: "", notes: "", serializedUnits: [] }; }
function emptyPayment(key: number, paidOn: string): InitialPayment { return { key, amount: "", method: "CASH", paidOn, reference: "", notes: "" }; }
function numberValue(value: string) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : 0; }
function formatCurrency(value: number) { return `₦${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function normalizedIdentifier(value: string) { return value.trim().toUpperCase(); }
function conditionLabel(value: Condition) { return value.charAt(0) + value.slice(1).toLowerCase(); }

function SerializedUnitCards({ line, lineNumber, onAdd, onRemove, onUpdate }: {
  line: PurchaseLine;
  lineNumber: number;
  onAdd: () => void;
  onRemove: (key: number) => void;
  onUpdate: (key: number, update: Partial<SerializedUnit>) => void;
}) {
  const lineValue = line.serializedUnits.reduce((total, unit) => total + Math.max(numberValue(unit.acquisitionCost), 0), 0);
  return <div className="mt-4 rounded border border-[var(--tg-gold)] bg-amber-50/40 p-3 sm:p-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="font-semibold text-[var(--tg-navy)]">Serialized units</h4><p className="mt-1 text-sm text-slate-600">{line.serializedUnits.length} {line.serializedUnits.length === 1 ? "unit" : "units"} · Estimated line value {formatCurrency(lineValue)}</p></div><button className="app-button-secondary w-full px-3 sm:w-auto" onClick={onAdd} type="button">Add unit</button></div>
    <div className="mt-4 space-y-4">{line.serializedUnits.map((unit, index) => <article className="rounded border border-slate-200 bg-white p-3 sm:p-4" key={unit.key}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-semibold text-slate-900">Unit {index + 1}</h5>{line.serializedUnits.length > 1 ? <button className="text-sm font-medium text-red-700 underline" onClick={() => onRemove(unit.key)} type="button">Remove unit</button> : null}</div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm font-medium text-slate-700">Acquisition cost (₦)<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min="0" onChange={(event) => onUpdate(unit.key, { acquisitionCost: event.target.value })} step="0.01" type="number" value={unit.acquisitionCost} /></label>
        <label className="block text-sm font-medium text-slate-700">Warranty start<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={unit.warrantyExpiry || undefined} onChange={(event) => onUpdate(unit.key, { warrantyStart: event.target.value })} type="date" value={unit.warrantyStart} /></label>
        <label className="block text-sm font-medium text-slate-700">Warranty end<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min={unit.warrantyStart || undefined} onChange={(event) => onUpdate(unit.key, { warrantyExpiry: event.target.value })} type="date" value={unit.warrantyExpiry} /></label>
        <label className="block text-sm font-medium text-slate-700">IMEI 1<input autoComplete="off" className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" inputMode="numeric" onChange={(event) => onUpdate(unit.key, { imei1: event.target.value })} value={unit.imei1} /></label>
        <label className="block text-sm font-medium text-slate-700">IMEI 2<input autoComplete="off" className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" inputMode="numeric" onChange={(event) => onUpdate(unit.key, { imei2: event.target.value })} value={unit.imei2} /></label>
        <label className="block text-sm font-medium text-slate-700">Serial<input autoComplete="off" className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => onUpdate(unit.key, { serial: event.target.value })} value={unit.serial} /></label>
      </div>
      <p className="mt-3 text-xs text-slate-600">Enter at least one identifier. IMEI and serial values are trimmed and normalized before submission.</p>
    </article>)}</div>
    <p className="sr-only">Serialized line {lineNumber} condition is {conditionLabel(line.condition)}.</p>
  </div>;
}

function recoveredLines(recovery: PurchaseReceiptRecovery | null) {
  let lineKey = 1;
  let unitKey = 1;
  const lines = recovery?.lines.length ? recovery.lines.map((line) => ({
    key: lineKey++, productId: line.productId, variantId: line.variantId, condition: line.condition,
    quantity: line.quantity || "1", unitCost: line.unitCost, notes: line.notes,
    serializedUnits: line.serializedUnits.map((unit) => ({ key: unitKey++, ...unit })),
  })) : [emptyLine(lineKey++)];
  return { lines, nextLineKey: lineKey, nextUnitKey: unitKey };
}

function PurchaseReceiptDraftForm({ suppliers, products, variants, lagosToday, state, action, pending, recovery }: {
  suppliers: SupplierOption[];
  products: ProductOption[];
  variants: VariantOption[];
  lagosToday: string;
  state: PurchaseReceiptActionState;
  action: (formData: FormData) => void;
  pending: boolean;
  recovery: PurchaseReceiptRecovery | null;
}) {
  const initialLines = recoveredLines(recovery);
  const [requestId, setRequestId] = useState(() => recovery?.requestId || createRequestId());
  const [supplierId, setSupplierId] = useState(() => recovery?.supplierId ?? "");
  const [receivedOn, setReceivedOn] = useState(() => recovery?.receivedOn || lagosToday);
  const [supplierReference, setSupplierReference] = useState(() => recovery?.supplierReference ?? "");
  const [notes, setNotes] = useState(() => recovery?.notes ?? "");
  const [lines, setLines] = useState<PurchaseLine[]>(() => initialLines.lines);
  const [payments, setPayments] = useState<InitialPayment[]>(() => recovery?.initialPayments.map((payment, index) => ({ key: index + 1, ...payment })) ?? []);
  const [clientError, setClientError] = useState("");
  const submitted = useRef(Boolean(recovery));
  const [visibleResultRequestId, setVisibleResultRequestId] = useState<string | null>(() => state.submissionRequestId);
  const observedActionState = useRef(state);
  const nextLineKey = useRef(initialLines.nextLineKey);
  const nextPaymentKey = useRef((recovery?.initialPayments.length ?? 0) + 1);
  const nextUnitKey = useRef(initialLines.nextUnitKey);
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  useEffect(() => {
    if (observedActionState.current !== state) {
      observedActionState.current = state;
      setVisibleResultRequestId(state.submissionRequestId);
    }
  }, [state]);

  const feedbackIsCurrent = visibleResultRequestId !== null
    && visibleResultRequestId === state.submissionRequestId
    && visibleResultRequestId === requestId;

  function materialChange() {
    const resultMatchesDraft = visibleResultRequestId !== null
      && visibleResultRequestId === state.submissionRequestId
      && visibleResultRequestId === requestId;
    if (resultMatchesDraft) setVisibleResultRequestId(null);
    if (submitted.current || resultMatchesDraft) { setRequestId(createRequestId()); submitted.current = false; }
    setClientError("");
  }
  function updateLine(key: number, update: Partial<PurchaseLine>) {
    materialChange();
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...update } : line));
  }
  function chooseProduct(key: number, productId: string) {
    materialChange();
    const product = productsById.get(productId);
    setLines((current) => current.map((line) => line.key === key ? {
      ...line, productId, variantId: "", quantity: "1", unitCost: "", serializedUnits: product?.serialized ? [emptyUnit(nextUnitKey.current++)] : [],
    } : line));
  }
  function updateUnit(lineKey: number, unitKey: number, update: Partial<SerializedUnit>) {
    materialChange();
    setLines((current) => current.map((line) => line.key === lineKey ? { ...line, serializedUnits: line.serializedUnits.map((unit) => unit.key === unitKey ? { ...unit, ...update } : unit) } : line));
  }
  function updatePayment(key: number, update: Partial<InitialPayment>) {
    materialChange();
    setPayments((current) => current.map((payment) => payment.key === key ? { ...payment, ...update } : payment));
  }

  const estimatedTotal = lines.reduce((total, line) => {
    const product = productsById.get(line.productId);
    return total + (product?.serialized ? line.serializedUnits.reduce((sum, unit) => sum + Math.max(numberValue(unit.acquisitionCost), 0), 0) : Math.max(numberValue(line.quantity), 0) * Math.max(numberValue(line.unitCost), 0));
  }, 0);
  const estimatedPayments = payments.reduce((total, payment) => total + Math.max(numberValue(payment.amount), 0), 0);
  const localValidationError = (() => {
    const seen = new Set<string>();
    for (const line of lines) {
      if (!productsById.get(line.productId)?.serialized) continue;
      for (const unit of line.serializedUnits) {
        const values = [unit.imei1, unit.imei2, unit.serial].map(normalizedIdentifier).filter(Boolean);
        if (values.length === 0) return "Each serialized unit requires at least one IMEI or serial number.";
        for (const value of values) { if (seen.has(value)) return "Each IMEI or serial number can be used only once in this receipt."; seen.add(value); }
        if (unit.warrantyStart && unit.warrantyExpiry && unit.warrantyExpiry < unit.warrantyStart) return "Warranty end cannot be earlier than warranty start.";
      }
    }
    return "";
  })();
  return <form action={action} className="space-y-5" onSubmit={(event) => {
    if (localValidationError) { event.preventDefault(); setClientError(localValidationError); return; }
    submitted.current = true;
  }}>
    <input name="requestId" type="hidden" value={requestId} />
    <input name="lines" type="hidden" value={JSON.stringify(lines.map((line) => {
      const serialized = Boolean(productsById.get(line.productId)?.serialized);
      return { productId: line.productId, variantId: line.variantId || null, condition: line.condition, quantity: serialized ? line.serializedUnits.length : line.quantity, unitCost: serialized ? null : line.unitCost, notes: line.notes, serializedUnits: line.serializedUnits.map((unit) => ({ acquisitionCost: unit.acquisitionCost, imei1: unit.imei1, imei2: unit.imei2, serial: unit.serial, warrantyStart: unit.warrantyStart, warrantyExpiry: unit.warrantyExpiry })) };
    }))} />
    <input name="initialPayments" type="hidden" value={JSON.stringify(payments.map((payment) => ({ amount: payment.amount, method: payment.method, paidOn: payment.paidOn, reference: payment.reference, notes: payment.notes })))} />

    <section className="app-panel p-4 sm:p-6"><h2 className="font-semibold text-[var(--tg-navy)]">Purchase header</h2><div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="block text-sm font-medium text-slate-700">Supplier<select required aria-label="Supplier" autoComplete="off" className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="supplierId" onChange={(event) => { materialChange(); setSupplierId(event.target.value); }} value={supplierId}><option value="">Select an active supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}{supplier.contact_name ? ` · ${supplier.contact_name}` : ""}</option>)}</select></label>
      <label className="block text-sm font-medium text-slate-700">Received date<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={lagosToday} name="receivedOn" onChange={(event) => { materialChange(); setReceivedOn(event.target.value); }} type="date" value={receivedOn} /></label>
      <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Supplier reference<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="supplierReference" onChange={(event) => { materialChange(); setSupplierReference(event.target.value); }} value={supplierReference} /></label>
      <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Notes<textarea className="mt-1 min-h-24 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" name="notes" onChange={(event) => { materialChange(); setNotes(event.target.value); }} value={notes} /></label>
    </div></section>

    <section className="app-panel p-4 sm:p-6"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-[var(--tg-navy)]">Purchase lines</h2><p className="mt-1 text-sm text-slate-600">Nonserialized and serialized products can be recorded in one immutable receipt. Lines remain in this order.</p></div><button className="app-button-secondary w-full px-3 sm:w-auto" onClick={() => { materialChange(); setLines((current) => [...current, emptyLine(nextLineKey.current++)]); }} type="button">Add line</button></div>
      <div className="mt-4 space-y-4">{lines.map((line, index) => {
        const product = productsById.get(line.productId);
        const serialized = Boolean(product?.serialized);
        const productVariants = variants.filter((variant) => variant.product_id === line.productId);
        return <article className="rounded border border-slate-200 p-4" key={line.key}><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-slate-900">Line {index + 1}</h3>{product ? <p className="mt-1 text-xs font-medium text-[var(--tg-navy)]">{serialized ? "Serialized" : "Non-serialized"} tracking</p> : null}</div>{lines.length > 1 ? <button className="text-sm font-medium text-red-700 underline" onClick={() => { materialChange(); setLines((current) => current.filter((item) => item.key !== line.key)); }} type="button">Remove line</button> : null}</div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-sm font-medium text-slate-700 sm:col-span-2 lg:col-span-1">Product<select required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => chooseProduct(line.key, event.target.value)} value={line.productId}><option value="">Select a product</option>{products.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.sku} · {option.serialized ? "Serialized" : "Non-serialized"}</option>)}</select></label>
            {productVariants.length ? <label className="block text-sm font-medium text-slate-700">Variant<select required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateLine(line.key, { variantId: event.target.value })} value={line.variantId}><option value="">Select a variant</option>{productVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.label}{variant.sku ? ` · ${variant.sku}` : ""}</option>)}</select></label> : <div className="text-sm text-slate-600"><p className="font-medium text-slate-700">Variant</p><p className="mt-2">{line.productId ? "Base product (no active variants)" : "Select a product first"}</p></div>}
            <label className="block text-sm font-medium text-slate-700">Condition<select className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateLine(line.key, { condition: event.target.value as Condition })} value={line.condition}><option value="NEW">New</option><option value="USED">Used</option><option value="REFURBISHED">Refurbished</option></select></label>
            {serialized ? <div className="text-sm text-slate-600"><p className="font-medium text-slate-700">Quantity</p><p className="mt-2">{line.serializedUnits.length} (from unit cards)</p></div> : <><label className="block text-sm font-medium text-slate-700">Quantity<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min="1" onChange={(event) => updateLine(line.key, { quantity: event.target.value })} step="1" type="number" value={line.quantity} /></label><label className="block text-sm font-medium text-slate-700">Unit cost (₦)<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min="0" onChange={(event) => updateLine(line.key, { unitCost: event.target.value })} step="0.01" type="number" value={line.unitCost} /></label></>}
            <label className="block text-sm font-medium text-slate-700 sm:col-span-2 lg:col-span-3">Line notes<textarea className="mt-1 min-h-20 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updateLine(line.key, { notes: event.target.value })} value={line.notes} /></label>
          </div>
          {serialized ? <SerializedUnitCards line={line} lineNumber={index + 1} onAdd={() => { materialChange(); setLines((current) => current.map((item) => item.key === line.key ? { ...item, serializedUnits: [...item.serializedUnits, emptyUnit(nextUnitKey.current++)] } : item)); }} onRemove={(unitKey) => { materialChange(); setLines((current) => current.map((item) => item.key === line.key ? { ...item, serializedUnits: item.serializedUnits.filter((unit) => unit.key !== unitKey) } : item)); }} onUpdate={(unitKey, update) => updateUnit(line.key, unitKey, update)} /> : null}
        </article>;
      })}</div>
    </section>

    <section className="app-panel p-4 sm:p-6"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-[var(--tg-navy)]">Initial payments</h2><p className="mt-1 text-sm text-slate-600">Optional. The completed receipt is authoritative for the final payment state.</p></div><button className="app-button-secondary w-full px-3 sm:w-auto" onClick={() => { materialChange(); setPayments((current) => [...current, emptyPayment(nextPaymentKey.current++, lagosToday)]); }} type="button">Add payment</button></div>
      {payments.length ? <div className="mt-4 space-y-4">{payments.map((payment, index) => <article className="rounded border border-slate-200 p-4" key={payment.key}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">Payment {index + 1}</h3><button className="text-sm font-medium text-red-700 underline" onClick={() => { materialChange(); setPayments((current) => current.filter((item) => item.key !== payment.key)); }} type="button">Remove payment</button></div><div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm font-medium text-slate-700">Amount (₦)<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" min="0.01" onChange={(event) => updatePayment(payment.key, { amount: event.target.value })} step="0.01" type="number" value={payment.amount} /></label>
        <label className="block text-sm font-medium text-slate-700">Method<select className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updatePayment(payment.key, { method: event.target.value as InitialPayment["method"] })} value={payment.method}><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></label>
        <label className="block text-sm font-medium text-slate-700">Paid date<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" max={lagosToday} onChange={(event) => updatePayment(payment.key, { paidOn: event.target.value })} type="date" value={payment.paidOn} /></label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Reference<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updatePayment(payment.key, { reference: event.target.value })} value={payment.reference} /></label>
        <label className="block text-sm font-medium text-slate-700 sm:col-span-2 lg:col-span-3">Payment notes<textarea className="mt-1 min-h-20 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" onChange={(event) => updatePayment(payment.key, { notes: event.target.value })} value={payment.notes} /></label>
      </div></article>)}</div> : <p className="mt-4 text-sm text-slate-600">No initial payments have been added.</p>}
    </section>

    <section className="sticky bottom-3 rounded border border-[var(--tg-gold)] bg-white p-4 shadow-sm"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm"><div><dt className="text-slate-500">Estimated receipt total</dt><dd className="font-semibold text-slate-900">{formatCurrency(estimatedTotal)}</dd></div><div><dt className="text-slate-500">Initial payments</dt><dd className="font-semibold text-slate-900">{formatCurrency(estimatedPayments)}</dd></div></dl><button className="app-button-primary w-full px-4 sm:w-auto" disabled={pending} type="submit">{pending ? "Recording purchase…" : "Record purchase"}</button></div><p className="mt-2 text-xs text-slate-600">Estimate only. The database validates the receipt total, payments, and inventory effects.</p>{clientError || (state.status === "error" && feedbackIsCurrent) ? <p className="mt-3 text-sm text-red-700" role="status">{clientError || state.message}</p> : null}</section>
  </form>;
}

export function PurchaseReceiptForm({ suppliers, products, variants, lagosToday }: { suppliers: SupplierOption[]; products: ProductOption[]; variants: VariantOption[]; lagosToday: string }) {
  const [state, action, pending] = useActionState(receivePurchase, initialPurchaseReceiptActionState);
  const recoveryKey = state.recovery ? JSON.stringify(state.recovery) : "new-receipt";
  return <PurchaseReceiptDraftForm key={recoveryKey} action={action} lagosToday={lagosToday} pending={pending} products={products} recovery={state.recovery} state={state} suppliers={suppliers} variants={variants} />;
}
