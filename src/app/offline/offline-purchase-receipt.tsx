"use client";

import { useEffect, useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import { purchaseReceiveIdentifierTypes, type InitialSupplierPaymentMethod, type PurchaseReceiveIdentifierType, type SerializedPurchaseUnit } from "@/lib/offline/purchase-receive";
import type { OfflineCatalogueRecord, OfflineReadSnapshot } from "@/lib/offline/types";

type ProductSelection = Pick<OfflineCatalogueRecord, "productId" | "variantId" | "condition" | "productName" | "productSku" | "variantLabel" | "variantSku"> & { kind: "NON_SERIALIZED" | "SERIALIZED" };
type DraftIdentifier = { key: string; type: PurchaseReceiveIdentifierType; value: string };
type DraftSerializedUnit = { key: string; acquisitionCostDecimal: string; warrantyStart: string; warrantyExpiry: string; identifiers: DraftIdentifier[] };
type NonserializedDraftLine = { key: string; kind: "NON_SERIALIZED"; selection: string; quantity: string; unitCostDecimal: string; notes: string };
type SerializedDraftLine = { key: string; kind: "SERIALIZED"; selection: string; notes: string; serializedUnits: DraftSerializedUnit[] };
type DraftLine = NonserializedDraftLine | SerializedDraftLine;
type DraftInitialPayment = { key: string; amount: string; method: InitialSupplierPaymentMethod; paidOn: string; reference: string; notes: string };

function choiceKey(record: ProductSelection) { return `${record.kind}|${record.productId}|${record.variantId ?? ""}|${record.condition}`; }
function newIdentifier(): DraftIdentifier { return { key: globalThis.crypto.randomUUID(), type: "IMEI_1", value: "" }; }
function newSerializedUnit(): DraftSerializedUnit { return { key: globalThis.crypto.randomUUID(), acquisitionCostDecimal: "", warrantyStart: "", warrantyExpiry: "", identifiers: [newIdentifier()] }; }
function newInitialPayment(): DraftInitialPayment { return { key: globalThis.crypto.randomUUID(), amount: "", method: "CASH", paidOn: localBusinessDate(), reference: "", notes: "" }; }
function localBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: "year" | "month" | "day") => parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Manager-only encrypted intent UI; pending receipt data never alters cached authority. */
export function OfflinePurchaseReceipt({ snapshot, online, onSnapshotUpdated }: { snapshot: OfflineReadSnapshot | null; online: boolean; onSnapshotUpdated: (snapshot: OfflineReadSnapshot | null) => void }) {
  const { queuePurchaseReceive, readPendingPurchaseReceives, readPurchaseReceiveReviews, readBusinessCache, syncOfflineMutations } = useOfflineVault();
  const [supplierId, setSupplierId] = useState("");
  const [receivedOn, setReceivedOn] = useState(localBusinessDate);
  const [supplierReference, setSupplierReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [initialPayments, setInitialPayments] = useState<DraftInitialPayment[]>([]);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof readPendingPurchaseReceives>>>([]);
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof readPurchaseReceiveReviews>>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const nonserializedCatalogue = useMemo<ProductSelection[]>(() => snapshot?.catalogue.map((record) => ({ kind: "NON_SERIALIZED", productId: record.productId, variantId: record.variantId, condition: record.condition, productName: record.productName, productSku: record.productSku, variantLabel: record.variantLabel, variantSku: record.variantSku })) ?? [], [snapshot]);
  const serializedCatalogue = useMemo<ProductSelection[]>(() => {
    const choices = new Map<string, ProductSelection>();
    for (const record of snapshot?.serializedInventory ?? []) {
      const selection: ProductSelection = { kind: "SERIALIZED", productId: record.productId, variantId: record.variantId, condition: record.condition, productName: record.productName, productSku: record.productSku, variantLabel: record.variantLabel, variantSku: record.variantSku };
      choices.set(choiceKey(selection), selection);
    }
    return [...choices.values()];
  }, [snapshot]);
  const selections = useMemo(() => new Map([...nonserializedCatalogue, ...serializedCatalogue].map((record) => [choiceKey(record), record])), [nonserializedCatalogue, serializedCatalogue]);
  const activeSuppliers = useMemo(() => snapshot?.suppliers.filter((supplier) => supplier.active) ?? [], [snapshot]);
  const addNonserializedLine = () => setLines((current) => [...current, { key: globalThis.crypto.randomUUID(), kind: "NON_SERIALIZED", selection: nonserializedCatalogue[0] ? choiceKey(nonserializedCatalogue[0]) : "", quantity: "1", unitCostDecimal: "", notes: "" }]);
  const addSerializedLine = () => setLines((current) => [...current, { key: globalThis.crypto.randomUUID(), kind: "SERIALIZED", selection: serializedCatalogue[0] ? choiceKey(serializedCatalogue[0]) : "", notes: "", serializedUnits: [newSerializedUnit()] }]);
  const loadProjection = async () => {
    try {
      const [nextPending, nextReviews] = await Promise.all([readPendingPurchaseReceives(), readPurchaseReceiveReviews()]);
      setPending(nextPending); setReviews(nextReviews);
    } catch { setMessage("Pending purchase receipts could not be read until offline access is unlocked again."); }
  };
  useEffect(() => {
    let disposed = false;
    void Promise.all([readPendingPurchaseReceives(), readPurchaseReceiveReviews()]).then(([nextPending, nextReviews]) => {
      if (!disposed) { setPending(nextPending); setReviews(nextReviews); }
    }).catch(() => { if (!disposed) setMessage("Pending purchase receipts could not be read until offline access is unlocked again."); });
    return () => { disposed = true; };
  }, [readPendingPurchaseReceives, readPurchaseReceiveReviews]);

  const updateLine = (key: string, update: (line: DraftLine) => DraftLine) => setLines((current) => current.map((line) => line.key === key ? update(line) : line));
  const queue = async () => {
    setBusy(true); setMessage("");
    try {
      const payload = {
        supplierId: supplierId || activeSuppliers[0]?.supplierId || "",
        receivedOn,
        supplierReference,
        notes,
        lines: lines.map((draft) => {
          const selected = selections.get(draft.selection);
          if (!selected || selected.kind !== draft.kind) throw new Error("Select a cached product for every line.");
          if (draft.kind === "NON_SERIALIZED") {
            const quantity = Number(draft.quantity);
            if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Each receipt quantity must be a positive integer.");
            return { productId: selected.productId, variantId: selected.variantId, condition: selected.condition, quantity, unitCostDecimal: draft.unitCostDecimal, notes: draft.notes, serializedUnits: [] as [] };
          }
          if (!draft.serializedUnits.length) throw new Error("Add at least one serialized unit.");
          return {
            productId: selected.productId,
            variantId: selected.variantId,
            condition: selected.condition,
            quantity: draft.serializedUnits.length,
            unitCostDecimal: null,
            notes: draft.notes,
            serializedUnits: draft.serializedUnits.map((unit) => ({ acquisitionCostDecimal: unit.acquisitionCostDecimal, warrantyStart: unit.warrantyStart || null, warrantyExpiry: unit.warrantyExpiry || null, identifiers: unit.identifiers.map((identifier) => ({ type: identifier.type, value: identifier.value })) })) as [SerializedPurchaseUnit, ...SerializedPurchaseUnit[]],
          };
        }),
        initialPayments: initialPayments.map((payment) => ({ amount: payment.amount, method: payment.method, paidOn: payment.paidOn, reference: payment.reference, notes: payment.notes })),
      };
      await queuePurchaseReceive(payload);
      setSupplierReference(""); setNotes(""); setLines([]); setInitialPayments([]); await loadProjection();
      setMessage("Receipt and intended payment intent were saved securely on this device and are pending server confirmation. They do not change cached stock, WAC, inventory, or financial history.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The purchase receipt could not be queued securely."); }
    finally { setBusy(false); }
  };
  const synchronize = async () => {
    if (!online) { setMessage("Reconnect before synchronizing pending purchase receipts."); return; }
    setBusy(true); setMessage("");
    try {
      const result = await syncOfflineMutations();
      await loadProjection();
      onSnapshotUpdated(await readBusinessCache());
      setMessage(result.applied ? "Pending purchase receipt synchronized and encrypted references refreshed." : result.rejected ? "A pending purchase receipt was rejected by current server authorization or validation." : result.conflicted ? "A purchase receipt needs review after reconnect." : "No pending purchase receipt was ready to synchronize.");
    } catch { setMessage("Pending purchase receipts could not be synchronized. They remain encrypted and will not be duplicated."); }
    finally { setBusy(false); }
  };
  const reviewIds = new Set(reviews.filter((review) => review.state === "CONFLICT").map((review) => review.operationId));

  return <section className="offline-workspace-section">
    <h2>Offline purchase receipt</h2>
    <p>Managers may compose encrypted non-serialized and serialized receipt intent offline, with optional initial payments. Purchase totals, WAC, stock projections, payment history, and payable balances remain server-only until confirmation.</p>
    {!online ? <form className="offline-customer-create" onSubmit={(event) => { event.preventDefault(); void queue(); }}>
      <label>Supplier<select required value={supplierId || activeSuppliers[0]?.supplierId || ""} onChange={(event) => setSupplierId(event.target.value)}><option value="">Select cached active supplier</option>{activeSuppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.businessName}</option>)}</select></label>
      <label>Received on<input required type="date" value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} /></label>
      <label>Supplier reference (optional)<input value={supplierReference} onChange={(event) => setSupplierReference(event.target.value)} /></label>
      <label>Receipt notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <h3>Receipt lines</h3>
      {lines.map((line, index) => <fieldset key={line.key} className="grid gap-2 border-t border-slate-200 pt-3"><legend>{line.kind === "SERIALIZED" ? "Serialized" : "Non-serialized"} line {index + 1}</legend>
        <label>Cached {line.kind === "SERIALIZED" ? "serialized" : "non-serialized"} product<select required value={line.selection} onChange={(event) => updateLine(line.key, (current) => ({ ...current, selection: event.target.value } as DraftLine))}><option value="">Select product</option>{(line.kind === "SERIALIZED" ? serializedCatalogue : nonserializedCatalogue).map((record) => <option key={choiceKey(record)} value={choiceKey(record)}>{record.productName}{record.variantLabel ? ` â€” ${record.variantLabel}` : ""} Â· {record.variantSku ?? record.productSku} Â· {record.condition}</option>)}</select></label>
        {line.kind === "NON_SERIALIZED" ? <><label>Quantity<input required min="1" step="1" inputMode="numeric" type="number" value={line.quantity} onChange={(event) => updateLine(line.key, (current) => current.kind === "NON_SERIALIZED" ? { ...current, quantity: event.target.value } : current)} /></label><label>Unit acquisition cost<input required inputMode="decimal" pattern="^(0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$" value={line.unitCostDecimal} onChange={(event) => updateLine(line.key, (current) => current.kind === "NON_SERIALIZED" ? { ...current, unitCostDecimal: event.target.value } : current)} /></label></> : <><p>Quantity is the exact number of serialized units below: {line.serializedUnits.length}.</p>{line.serializedUnits.map((unit, unitIndex) => <fieldset key={unit.key} className="grid gap-2 border-t border-slate-100 pt-2"><legend>Serialized unit {unitIndex + 1}</legend><label>Acquisition cost<input required inputMode="decimal" pattern="^(0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$" value={unit.acquisitionCostDecimal} onChange={(event) => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, acquisitionCostDecimal: event.target.value } : candidate) } : current)} /></label><label>Warranty start (optional)<input type="date" value={unit.warrantyStart} onChange={(event) => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, warrantyStart: event.target.value } : candidate) } : current)} /></label><label>Warranty expiry (optional)<input type="date" value={unit.warrantyExpiry} onChange={(event) => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, warrantyExpiry: event.target.value } : candidate) } : current)} /></label><h4>Identifiers</h4>{unit.identifiers.map((identifier) => <div className="grid gap-2" key={identifier.key}><label>Type<select value={identifier.type} onChange={(event) => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, identifiers: candidate.identifiers.map((item) => item.key === identifier.key ? { ...item, type: event.target.value as PurchaseReceiveIdentifierType } : item) } : candidate) } : current)}>{purchaseReceiveIdentifierTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label>Value<input required value={identifier.value} onChange={(event) => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, identifiers: candidate.identifiers.map((item) => item.key === identifier.key ? { ...item, value: event.target.value } : item) } : candidate) } : current)} /></label><button className="app-button-secondary" type="button" disabled={busy || unit.identifiers.length === 1} onClick={() => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, identifiers: candidate.identifiers.filter((item) => item.key !== identifier.key) } : candidate) } : current)}>Remove identifier</button></div>)}<button className="app-button-secondary" type="button" disabled={busy} onClick={() => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.map((candidate) => candidate.key === unit.key ? { ...candidate, identifiers: [...candidate.identifiers, newIdentifier()] } : candidate) } : current)}>Add identifier</button><button className="app-button-secondary" type="button" disabled={busy || line.serializedUnits.length === 1} onClick={() => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: current.serializedUnits.filter((candidate) => candidate.key !== unit.key) } : current)}>Remove serialized unit</button></fieldset>)}<button className="app-button-secondary" type="button" disabled={busy} onClick={() => updateLine(line.key, (current) => current.kind === "SERIALIZED" ? { ...current, serializedUnits: [...current.serializedUnits, newSerializedUnit()] } : current)}>Add serialized unit</button></>}
        <label>Line notes (optional)<input value={line.notes} onChange={(event) => updateLine(line.key, (current) => ({ ...current, notes: event.target.value } as DraftLine))} /></label>
        <button className="app-button-secondary" type="button" disabled={busy} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>Remove line</button>
      </fieldset>)}
      <button className="app-button-secondary" type="button" disabled={busy || !nonserializedCatalogue.length} onClick={addNonserializedLine}>Add non-serialized line</button>
      <button className="app-button-secondary" type="button" disabled={busy || !serializedCatalogue.length} onClick={addSerializedLine}>Add serialized line</button>
      {!serializedCatalogue.length ? <p>Serialized receipt entry requires an existing encrypted serialized-inventory reference for that product.</p> : null}
      <fieldset className="grid gap-2 border-t border-slate-200 pt-3"><legend>Initial payments (optional)</legend><p>Intended payments are encrypted with this receipt and are not server-confirmed financial history.</p>{initialPayments.map((payment, index) => <fieldset className="grid gap-2 border-t border-slate-100 pt-2" key={payment.key}><legend>Payment {index + 1}</legend><label>Amount<input required inputMode="decimal" pattern="^(0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$" value={payment.amount} onChange={(event) => setInitialPayments((current) => current.map((item) => item.key === payment.key ? { ...item, amount: event.target.value } : item))} /></label><label>Method<select value={payment.method} onChange={(event) => setInitialPayments((current) => current.map((item) => item.key === payment.key ? { ...item, method: event.target.value as InitialSupplierPaymentMethod } : item))}><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></label><label>Paid date<input required max={localBusinessDate()} type="date" value={payment.paidOn} onChange={(event) => setInitialPayments((current) => current.map((item) => item.key === payment.key ? { ...item, paidOn: event.target.value } : item))} /></label><label>Reference (optional)<input value={payment.reference} onChange={(event) => setInitialPayments((current) => current.map((item) => item.key === payment.key ? { ...item, reference: event.target.value } : item))} /></label><label>Payment notes (optional)<textarea value={payment.notes} onChange={(event) => setInitialPayments((current) => current.map((item) => item.key === payment.key ? { ...item, notes: event.target.value } : item))} /></label><button className="app-button-secondary" type="button" disabled={busy} onClick={() => setInitialPayments((current) => current.filter((item) => item.key !== payment.key))}>Remove payment</button></fieldset>)}<button className="app-button-secondary" type="button" disabled={busy} onClick={() => setInitialPayments((current) => [...current, newInitialPayment()])}>Add initial payment</button></fieldset>
      <button className="app-button-primary" type="submit" disabled={busy || !lines.length || !activeSuppliers.length}>{busy ? "Saving securelyâ€¦" : "Save receipt for synchronization"}</button>
    </form> : <p className="offline-mutation-notice">Offline purchase receipt entry is available only while disconnected. Reconnect to use the authoritative online procurement workflow.</p>}
    <div className="offline-workspace-list">
      {pending.map((receipt) => <article key={receipt.operationId}><div><strong>{activeSuppliers.find((supplier) => supplier.supplierId === receipt.supplierId)?.businessName ?? "Cached supplier unavailable"}</strong><span>Received {receipt.receivedOn} Â· {receipt.lines.length} pending line{receipt.lines.length === 1 ? "" : "s"} Â· {receipt.lines.reduce((count, line) => count + line.serializedUnits.length, 0)} pending serialized unit{receipt.lines.reduce((count, line) => count + line.serializedUnits.length, 0) === 1 ? "" : "s"}</span></div><div><strong>{reviewIds.has(receipt.operationId) ? "Needs review after reconnect" : "Pending synchronization"}</strong><span>Not server-confirmed. Cached stock, WAC, serialized inventory, payment history, and payable balances are not changed.</span></div><details><summary>Review encrypted pending intent</summary>{receipt.lines.map((line, index) => <p key={`${receipt.operationId}-${index}`}>Line {index + 1}: {line.quantity} unit{line.quantity === 1 ? "" : "s"}{line.serializedUnits.length ? `; ${line.serializedUnits.flatMap((unit) => unit.identifiers.map((identifier) => `${identifier.type}: ${identifier.value}`)).join(", ")}` : ""}</p>)}{receipt.initialPayments.map((payment, index) => <p key={`${receipt.operationId}-payment-${index}`}>Intended payment {index + 1}: {payment.amount} Â· {payment.method} Â· {payment.paidOn}{payment.reference ? ` Â· ${payment.reference}` : ""}{payment.notes ? ` Â· ${payment.notes}` : ""} Â· Not server-confirmed</p>)}</details></article>)}
      {reviews.filter((review) => review.state === "CONFLICT").map((review) => <article key={review.operationId}><div><strong>Purchase receipt needs review</strong><span>The server did not confirm this encrypted receipt. No cached inventory state was changed.</span></div><div><strong>Needs review after reconnect</strong><span>Resolve it from the authoritative online procurement workflow.</span></div></article>)}
    </div>
    {pending.length || reviews.length ? <button className="app-button-secondary" disabled={!online || busy} type="button" onClick={() => void synchronize()}>{busy ? "Synchronizingâ€¦" : online ? "Synchronize pending purchase receipts" : "Reconnect to synchronize"}</button> : null}
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
  </section>;
}
