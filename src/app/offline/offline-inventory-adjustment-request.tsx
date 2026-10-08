"use client";

import { useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import type { OfflineReadSnapshot } from "@/lib/offline/types";

export function OfflineInventoryAdjustmentRequest({ snapshot, online }: { snapshot: OfflineReadSnapshot | null; online: boolean }) {
  const { unlocked, queueInventoryAdjustmentRequest, readPendingInventoryAdjustmentRequests, readInventoryAdjustmentRequestReviews, syncOfflineMutations } = useOfflineVault();
  const [kind, setKind] = useState<"NON_SERIALIZED" | "SERIALIZED">("NON_SERIALIZED");
  const [selection, setSelection] = useState("");
  const [quantity, setQuantity] = useState("-1");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const options = useMemo(() => kind === "NON_SERIALIZED"
    ? (snapshot?.catalogue ?? []).map((record) => ({ key: `${record.productId}|${record.variantId ?? ""}|${record.condition}`, label: `${record.productName}${record.variantLabel ? ` — ${record.variantLabel}` : ""} · ${record.condition}`, productId: record.productId, variantId: record.variantId, condition: record.condition }))
    : (snapshot?.serializedInventory ?? []).filter((record) => record.status === "AVAILABLE").map((record) => ({ key: record.unitId, label: `${record.productName}${record.variantLabel ? ` — ${record.variantLabel}` : ""} · ${record.identifierType}: ${record.identifierValue}`, productId: record.productId, variantId: record.variantId, unitId: record.unitId })), [kind, snapshot]);
  const refreshProjection = async () => {
    const [pending, reviews] = await Promise.all([readPendingInventoryAdjustmentRequests(), readInventoryAdjustmentRequestReviews()]);
    setPendingCount(pending.length); setReviewCount(reviews.filter((review) => review.state === "CONFLICT").length);
  };
  if (!unlocked || unlocked.role === "ADMIN") return null;
  const queue = async () => {
    const selected = options.find((option) => option.key === selection);
    if (!selected) { setMessage("Select an item from this encrypted snapshot."); return; }
    setBusy(true); setMessage("");
    try {
      if (kind === "NON_SERIALIZED") {
        if (!("condition" in selected)) throw new Error("Select a non-serialized stock item.");
        await queueInventoryAdjustmentRequest({ kind, productId: selected.productId, variantId: selected.variantId, condition: selected.condition as "NEW" | "USED" | "REFURBISHED", unitId: null, requestedQuantity: Number(quantity), reason });
      } else {
        if (!("unitId" in selected)) throw new Error("Select an available serialized unit.");
        await queueInventoryAdjustmentRequest({ kind, productId: selected.productId, variantId: selected.variantId, condition: null, unitId: selected.unitId, requestedQuantity: -1, reason });
      }
      await refreshProjection(); setReason(""); setMessage("Pending request; Not approved; No stock change.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The encrypted request could not be saved."); }
    finally { setBusy(false); }
  };
  const synchronize = async () => {
    if (!online) { setMessage("Reconnect before synchronizing pending requests."); return; }
    setBusy(true); setMessage("");
    try { const result = await syncOfflineMutations(); await refreshProjection(); setMessage(result.applied ? "Request sent for approval. Pending request; Not approved; No stock change." : result.conflicted ? "A request needs review after reconnect." : result.rejected ? "A request was rejected by current server authorization or validation." : "No pending request was ready to synchronize."); }
    catch { setMessage("Pending requests could not be synchronized. They remain encrypted."); }
    finally { setBusy(false); }
  };
  return <section className="offline-workspace-section">
    <h2>Offline adjustment request</h2>
    <p>Creates a pending request only. Approval, rejection, and every inventory execution remain online-only Admin work.</p>
    <div className="offline-form-grid">
      <label>Request type<select value={kind} disabled={busy || online} onChange={(event) => { setKind(event.target.value as typeof kind); setSelection(""); }}><option value="NON_SERIALIZED">Non-serialized stock</option><option value="SERIALIZED">Serialized unit out</option></select></label>
      <label>{kind === "NON_SERIALIZED" ? "Stock item and condition" : "Available serialized unit"}<select value={selection} disabled={busy || online} onChange={(event) => setSelection(event.target.value)}><option value="">Select from saved data</option>{options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
      {kind === "NON_SERIALIZED" ? <label>Signed quantity<input inputMode="numeric" value={quantity} disabled={busy || online} onChange={(event) => setQuantity(event.target.value)} /></label> : <p>Serialized requests are always for exactly one unit out (−1).</p>}
      <label>Reason<textarea value={reason} disabled={busy || online} onChange={(event) => setReason(event.target.value)} /></label>
    </div>
    <div className="offline-workspace-toolbar"><button className="app-button-primary" type="button" disabled={busy || online} onClick={() => void queue()}>{online ? "Offline only" : busy ? "Saving…" : "Save pending request"}</button><button className="app-button-secondary" type="button" disabled={busy || !online} onClick={() => void synchronize()}>{busy ? "Synchronizing…" : "Synchronize pending requests"}</button></div>
    <p className="offline-mutation-notice">{pendingCount ? `${pendingCount} pending encrypted request${pendingCount === 1 ? "" : "s"}. Pending request; Not approved; No stock change.` : "No pending offline adjustment requests."}{reviewCount ? ` ${reviewCount} request${reviewCount === 1 ? " needs" : "s need"} review after reconnect.` : ""}</p>
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
  </section>;
}
