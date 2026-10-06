"use client";

import { useEffect, useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import type { OfflineCatalogueRecord, OfflineReadSnapshot } from "@/lib/offline/types";

type DraftLine = { key: string; selection: string; quantity: string; unitCostDecimal: string; notes: string };
type ProductSelection = Pick<OfflineCatalogueRecord, "productId" | "variantId" | "condition" | "productName" | "productSku" | "variantLabel" | "variantSku">;

function choiceKey(record: ProductSelection) { return `${record.productId}|${record.variantId ?? ""}|${record.condition}`; }
function localBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: "year" | "month" | "day") => parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Manager-only encrypted intent UI. It intentionally has neither payments nor local stock/WAC projection. */
export function OfflinePurchaseReceipt({ snapshot, online, onSnapshotUpdated }: { snapshot: OfflineReadSnapshot | null; online: boolean; onSnapshotUpdated: (snapshot: OfflineReadSnapshot | null) => void }) {
  const { queuePurchaseReceive, readPendingPurchaseReceives, readPurchaseReceiveReviews, readBusinessCache, syncOfflineMutations } = useOfflineVault();
  const [supplierId, setSupplierId] = useState("");
  const [receivedOn, setReceivedOn] = useState(localBusinessDate);
  const [supplierReference, setSupplierReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof readPendingPurchaseReceives>>>([]);
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof readPurchaseReceiveReviews>>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const catalogue = useMemo<ProductSelection[]>(() => snapshot?.catalogue.map((record) => ({ productId: record.productId, variantId: record.variantId, condition: record.condition, productName: record.productName, productSku: record.productSku, variantLabel: record.variantLabel, variantSku: record.variantSku })) ?? [], [snapshot]);
  const selections = useMemo(() => new Map(catalogue.map((record) => [choiceKey(record), record])), [catalogue]);
  const activeSuppliers = useMemo(() => snapshot?.suppliers.filter((supplier) => supplier.active) ?? [], [snapshot]);
  const addLine = () => setLines((current) => [...current, { key: globalThis.crypto.randomUUID(), selection: catalogue[0] ? choiceKey(catalogue[0]) : "", quantity: "1", unitCostDecimal: "", notes: "" }]);
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

  const updateLine = (key: string, changes: Partial<DraftLine>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...changes } : line));
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
          if (!selected) throw new Error("Select a cached non-serialized product for every line.");
          const quantity = Number(draft.quantity);
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Each receipt quantity must be a positive integer.");
          return { productId: selected.productId, variantId: selected.variantId, condition: selected.condition, quantity, unitCostDecimal: draft.unitCostDecimal, notes: draft.notes };
        }),
        initialPayments: [] as [],
      };
      await queuePurchaseReceive(payload);
      setSupplierReference(""); setNotes(""); setLines([]); await loadProjection();
      setMessage("Non-serialized receipt saved securely on this device and pending server confirmation. It does not change cached quantity or WAC.");
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
    <h2>Non-serialized purchase receipt</h2>
    <p>Only non-serialized items can be received offline. Payments, serialized units, purchase totals, WAC, and stock projections are unavailable here. Server confirmation remains authoritative.</p>
    {!online ? <form className="offline-customer-create" onSubmit={(event) => { event.preventDefault(); void queue(); }}>
      <label>Supplier<select required value={supplierId || activeSuppliers[0]?.supplierId || ""} onChange={(event) => setSupplierId(event.target.value)}><option value="">Select cached active supplier</option>{activeSuppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.businessName}</option>)}</select></label>
      <label>Received on<input required type="date" value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} /></label>
      <label>Supplier reference (optional)<input value={supplierReference} onChange={(event) => setSupplierReference(event.target.value)} /></label>
      <label>Receipt notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <h3>Receipt lines</h3>
      {lines.map((line, index) => <fieldset key={line.key} className="grid gap-2 border-t border-slate-200 pt-3"><legend>Line {index + 1}</legend>
        <label>Cached non-serialized product<select required value={line.selection} onChange={(event) => updateLine(line.key, { selection: event.target.value })}><option value="">Select product</option>{catalogue.map((record) => <option key={choiceKey(record)} value={choiceKey(record)}>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""} · {record.variantSku ?? record.productSku} · {record.condition}</option>)}</select></label>
        <label>Quantity<input required min="1" step="1" inputMode="numeric" type="number" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} /></label>
        <label>Unit acquisition cost<input required inputMode="decimal" pattern="^(0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$" value={line.unitCostDecimal} onChange={(event) => updateLine(line.key, { unitCostDecimal: event.target.value })} /></label>
        <label>Line notes (optional)<input value={line.notes} onChange={(event) => updateLine(line.key, { notes: event.target.value })} /></label>
        <button className="app-button-secondary" type="button" disabled={lines.length === 1 || busy} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>Remove line</button>
      </fieldset>)}
      <button className="app-button-secondary" type="button" disabled={busy || !catalogue.length} onClick={addLine}>Add non-serialized line</button>
      <button className="app-button-primary" type="submit" disabled={busy || !lines.length || !activeSuppliers.length || !catalogue.length}>{busy ? "Saving securely…" : "Save receipt for synchronization"}</button>
    </form> : <p className="offline-mutation-notice">Offline purchase receipt entry is available only while disconnected. Payments and serialized receiving require an internet connection.</p>}
    <div className="offline-workspace-list">
      {pending.map((receipt) => <article key={receipt.operationId}><div><strong>{activeSuppliers.find((supplier) => supplier.supplierId === receipt.supplierId)?.businessName ?? "Cached supplier unavailable"}</strong><span>Received {receipt.receivedOn} · {receipt.lines.length} non-serialized line{receipt.lines.length === 1 ? "" : "s"}</span></div><div><strong>{reviewIds.has(receipt.operationId) ? "Needs review" : "Pending synchronization"}</strong><span>Not server-confirmed. Cached stock and WAC are not changed.</span></div></article>)}
      {reviews.filter((review) => review.state === "CONFLICT").map((review) => <article key={review.operationId}><div><strong>Purchase receipt needs review</strong><span>The server did not confirm this encrypted receipt. No cached inventory state was changed.</span></div><div><strong>Needs review after reconnect</strong><span>Resolve it from the authoritative online procurement workflow.</span></div></article>)}
    </div>
    {pending.length || reviews.length ? <button className="app-button-secondary" disabled={!online || busy} type="button" onClick={() => void synchronize()}>{busy ? "Synchronizing…" : online ? "Synchronize pending purchase receipts" : "Reconnect to synchronize"}</button> : null}
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
  </section>;
}
