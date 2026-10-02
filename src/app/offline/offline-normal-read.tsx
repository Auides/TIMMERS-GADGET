"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import type { OfflineCustomerRecord, OfflineReadSnapshot } from "@/lib/offline/types";

export type OfflineNormalReadMode = "catalogue" | "inventory" | "customers" | "suppliers";

function formatTime(value: string) { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date(value)); }
function staleLabel(value: string) { const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(value)) / 60_000); return minutes < 1 ? "updated less than a minute ago" : minutes < 60 ? `updated ${minutes} minutes ago` : `updated ${Math.floor(minutes / 60)} hours ago`; }
function price(value: number | null) { return value === null ? "Price not configured" : `NGN ${value.toLocaleString()}`; }

function LockedOfflineData({ returnTo }: { returnTo: string }) {
  return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>Offline data is locked.</h1><p>Unlock local access before viewing this device&apos;s encrypted reference data.</p><Link className="app-button-primary offline-link-button" href={`/offline/unlock?returnTo=${encodeURIComponent(returnTo)}`}>Unlock offline access</Link></section></main>;
}

const labels: Record<OfflineNormalReadMode, string> = { catalogue: "Catalogue", inventory: "Inventory", customers: "Customers", suppliers: "Suppliers" };

export function OfflineNormalRead({ mode, returnTo }: { mode: OfflineNormalReadMode; returnTo: string }) {
  const { unlocked, lock, readBusinessCache, refreshBusinessCache, queueCustomerCreate, readPendingCustomerCreates, queueCustomerUpdate, readPendingCustomerUpdates, readCustomerUpdateReviews, syncOfflineMutations } = useOfflineVault();
  const [snapshot, setSnapshot] = useState<OfflineReadSnapshot | null>(null);
  const [message, setMessage] = useState("Loading encrypted local data…");
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCustomers, setPendingCustomers] = useState<Awaited<ReturnType<typeof readPendingCustomerCreates>>>([]);
  const [pendingCustomerUpdates, setPendingCustomerUpdates] = useState<Awaited<ReturnType<typeof readPendingCustomerUpdates>>>([]);
  const [customerUpdateReviews, setCustomerUpdateReviews] = useState<Awaited<ReturnType<typeof readCustomerUpdateReviews>>>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerBusy, setCustomerBusy] = useState(false);
  const [customerMessage, setCustomerMessage] = useState("");
  const [customerEdit, setCustomerEdit] = useState<OfflineCustomerRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  useEffect(() => { const update = () => setOnline(navigator.onLine); update(); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  useEffect(() => { if (!unlocked) return; let disposed = false; void readBusinessCache().then((cached) => { if (disposed) return; setSnapshot(cached); setMessage(cached ? "" : "No offline data is available on this device. Connect to the internet and refresh offline data first."); }).catch(() => { if (!disposed) setMessage("Encrypted local data could not be read. Refresh online after unlocking."); }); return () => { disposed = true; }; }, [readBusinessCache, unlocked]);
  const loadCustomerMutationProjection = async () => {
    try {
      const [creates, updates, reviews] = await Promise.all([readPendingCustomerCreates(), readPendingCustomerUpdates(), readCustomerUpdateReviews()]);
      setPendingCustomers(creates); setPendingCustomerUpdates(updates); setCustomerUpdateReviews(reviews);
    } catch { setCustomerMessage("Pending customer data could not be read until offline access is unlocked again."); }
  };
  useEffect(() => {
    if (mode !== "customers" || !unlocked) return;
    let disposed = false;
    void Promise.all([readPendingCustomerCreates(), readPendingCustomerUpdates(), readCustomerUpdateReviews()]).then(([creates, updates, reviews]) => {
      if (disposed) return;
      setPendingCustomers(creates); setPendingCustomerUpdates(updates); setCustomerUpdateReviews(reviews);
    }).catch(() => { if (!disposed) setCustomerMessage("Pending customer data could not be read until offline access is unlocked again."); });
    return () => { disposed = true; };
  }, [mode, unlocked, readPendingCustomerCreates, readPendingCustomerUpdates, readCustomerUpdateReviews]);
  const refresh = async () => { if (!online) { setMessage("Reconnect before refreshing. Existing encrypted data remains available."); return; } setRefreshing(true); try { await refreshBusinessCache(); const cached = await readBusinessCache(); setSnapshot(cached); setMessage(cached ? "Encrypted snapshot refreshed." : "The refreshed snapshot could not be read."); } catch { setMessage("The encrypted snapshot could not be refreshed."); } finally { setRefreshing(false); } };
  const query = search.trim().toLocaleLowerCase();
  const catalogue = useMemo(() => snapshot?.catalogue.filter((record) => !query || [record.productName, record.productSku, record.productBarcode, record.variantLabel, record.variantSku, record.variantBarcode].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const serialized = useMemo(() => snapshot?.serializedInventory.filter((record) => !query || [record.productName, record.productSku, record.identifierValue, record.variantLabel, record.variantSku].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const customers = useMemo(() => snapshot?.customers.filter((record) => !query || [record.fullName, record.phone, record.email].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const suppliers = useMemo(() => snapshot?.suppliers.filter((record) => !query || [record.businessName, record.contactName, record.phone, record.email].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const pendingUpdateByCustomer = useMemo(() => new Map(pendingCustomerUpdates.map((record) => [record.customerId, record])), [pendingCustomerUpdates]);
  const reviewByCustomer = useMemo(() => new Map(customerUpdateReviews.map((record) => [record.customerId, record])), [customerUpdateReviews]);
  const queueCustomer = async () => {
    setCustomerBusy(true); setCustomerMessage("");
    try { await queueCustomerCreate({ fullName: customerName, phone: customerPhone, email: customerEmail }); setCustomerName(""); setCustomerPhone(""); setCustomerEmail(""); await loadCustomerMutationProjection(); setCustomerMessage("Customer saved securely on this device and pending synchronization."); }
    catch (error) { setCustomerMessage(error instanceof Error ? error.message : "The customer could not be queued securely."); }
    finally { setCustomerBusy(false); }
  };
  const beginCustomerEdit = (record: OfflineCustomerRecord) => {
    setCustomerEdit(record); setEditName(record.fullName); setEditPhone(record.phone ?? ""); setEditEmail(record.email ?? ""); setCustomerMessage("");
  };
  const queueCustomerEdit = async () => {
    if (!customerEdit) return;
    setCustomerBusy(true); setCustomerMessage("");
    try {
      await queueCustomerUpdate({ customerId: customerEdit.customerId, fullName: editName, phone: editPhone, email: editEmail, expectedVersion: customerEdit.customerVersion });
      setCustomerEdit(null); await loadCustomerMutationProjection(); setCustomerMessage("Customer edit saved securely on this device and pending synchronization.");
    } catch (error) { setCustomerMessage(error instanceof Error ? error.message : "The customer edit could not be queued securely."); }
    finally { setCustomerBusy(false); }
  };
  const syncCustomers = async () => {
    if (!online) { setCustomerMessage("Reconnect before synchronizing pending customers."); return; }
    setCustomerBusy(true); setCustomerMessage("");
    try { const result = await syncOfflineMutations(); await loadCustomerMutationProjection(); setSnapshot(await readBusinessCache()); setCustomerMessage(result.applied ? "Pending customer change synchronized and local references refreshed." : result.rejected ? "A pending customer change was rejected by current server authorization or validation." : result.conflicted ? "A customer edit needs review after reconnect. The authoritative reference data was refreshed." : "No pending customer change was ready to synchronize."); }
    catch { setCustomerMessage("Pending customers could not be synchronized. They remain encrypted and will not be duplicated."); }
    finally { setCustomerBusy(false); }
  };
  if (!unlocked) return <LockedOfflineData returnTo={returnTo} />;
  if (unlocked.role === "ADMIN") return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>Offline read cache is unavailable</h1><p>Admin work remains online-only. Approved Admin offline functionality is future work.</p><button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button></section></main>;
  if (mode === "suppliers" && unlocked.role !== "MANAGER") return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>Supplier references are unavailable</h1><p>Your current role is not authorized to view supplier reference data.</p><button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button></section></main>;
  const placeholder = mode === "inventory" ? "Product, SKU, IMEI or serial" : mode === "catalogue" ? "Product, SKU or barcode" : mode === "customers" ? "Name, phone or email" : "Business, contact, phone or email";
  const description = mode === "inventory" ? "Inventory reflects this device's last synchronized state. It is not globally current stock." : mode === "catalogue" ? "Read-only catalogue data from this device's last synchronized state." : mode === "customers" ? "Read-only customer reference data from this device's last synchronized state." : "Read-only supplier reference data from this device's last synchronized state.";
  return <main className="offline-page"><section className="offline-panel offline-workspace-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>{labels[mode]}</h1><p>{description}</p>
    <div className="offline-workspace-toolbar"><div>{snapshot ? <><strong>Last synced: {formatTime(snapshot.capturedAt)}</strong><span>Offline data · {staleLabel(snapshot.capturedAt)} · Africa/Lagos</span></> : <span>No saved snapshot</span>}</div><button className="app-button-primary" disabled={!online || refreshing} type="button" onClick={() => void refresh()}>{refreshing ? "Refreshing…" : online ? "Refresh online" : "Offline"}</button></div>
    <label className="offline-workspace-search">Search saved {labels[mode].toLocaleLowerCase()}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={placeholder} /></label>
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
    {(mode === "catalogue" || mode === "inventory") ? <><section className="offline-workspace-section"><h2>{mode === "inventory" ? "Non-serialized stock" : "Products and variants"}</h2><div className="offline-workspace-list">{catalogue.map((record) => <article key={`${record.productId}-${record.variantId ?? "base"}-${record.condition}`}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.variantSku ?? record.productSku} · {record.condition}</span></div><div><strong>{price(record.sellingPrice)}</strong><span>{mode === "inventory" ? `Cached quantity ${record.quantity}` : `Stock ${record.quantity}`}</span></div></article>)}</div></section>{mode === "inventory" ? <section className="offline-workspace-section"><h2>Serialized inventory</h2><div className="offline-workspace-list">{serialized.map((record) => <article key={`${record.unitId}-${record.identifierType}-${record.identifierValue}`}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.identifierType}: {record.identifierValue} · {record.condition}</span></div><div><strong>{record.status}</strong><span>{price(record.sellingPrice)}</span></div></article>)}</div><p className="offline-mutation-notice">Opening stock, adjustment requests, direct adjustments, serialized adjustments, and every inventory write require an internet connection.</p></section> : <p className="offline-mutation-notice">Catalogue changes, prices, and archive actions require an internet connection.</p>}</> : null}
    {mode === "customers" ? <section className="offline-workspace-section">
      <h2>Customer references</h2>
      <div className="offline-workspace-list">
        {customers.map((record) => {
          const pendingUpdate = pendingUpdateByCustomer.get(record.customerId);
          const review = reviewByCustomer.get(record.customerId);
          return <article key={record.customerId}>
            <div><strong>{record.fullName}</strong><span>Authoritative cached record · {[record.phone, record.email].filter(Boolean).join(" · ") || "No contact details recorded."}</span></div>
            {pendingUpdate ? <div><strong>Pending synchronization</strong><span>Proposed offline edit: {pendingUpdate.fullName}</span></div> : null}
            {review?.state === "CONFLICT" ? <div><strong>Needs review after reconnect</strong><span>The server changed this customer before the offline edit could apply.</span></div> : null}
            {!online && !review ? <button className="app-button-secondary" disabled={customerBusy} type="button" onClick={() => beginCustomerEdit(record)}>Edit offline</button> : null}
          </article>;
        })}
        {pendingCustomers.map((record) => <article key={record.operationId}><div><strong>{record.fullName}</strong><span>{[record.phone, record.email].filter(Boolean).join(" · ") || "No contact details recorded."}</span></div><div><strong>Pending synchronization</strong><span>Not yet confirmed by the server; editing is unavailable until it is confirmed.</span></div></article>)}
      </div>
      {!online ? <>
        <form className="offline-customer-create" onSubmit={(event) => { event.preventDefault(); void queueCustomer(); }}>
          <h3>Add customer offline</h3><p>This customer is encrypted on this device and pending synchronization. It is not yet a server-confirmed customer.</p>
          <label>Full name<input required value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label><label>Phone (optional)<input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label><label>Email (optional)<input value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} /></label>
          <button className="app-button-primary" disabled={customerBusy} type="submit">{customerBusy ? "Saving securely…" : "Save for synchronization"}</button>
        </form>
        {customerEdit ? <form className="offline-customer-create" onSubmit={(event) => { event.preventDefault(); void queueCustomerEdit(); }}>
          <h3>Edit customer offline</h3><p>This is an encrypted proposed edit. It will apply only if the server customer still matches this snapshot&apos;s version.</p>
          <label>Full name<input required value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label>Phone (optional)<input value={editPhone} onChange={(event) => setEditPhone(event.target.value)} /></label><label>Email (optional)<input value={editEmail} onChange={(event) => setEditEmail(event.target.value)} /></label>
          <button className="app-button-primary" disabled={customerBusy} type="submit">{customerBusy ? "Saving securely…" : "Save edit for synchronization"}</button><button className="app-button-secondary" disabled={customerBusy} type="button" onClick={() => setCustomerEdit(null)}>Cancel</button>
        </form> : null}
      </> : <p className="offline-mutation-notice">Customer creation and editing are available only from this encrypted offline workspace while disconnected.</p>}
      {(pendingCustomers.length || pendingCustomerUpdates.length) ? <button className="app-button-secondary" disabled={!online || customerBusy} type="button" onClick={() => void syncCustomers()}>{customerBusy ? "Synchronizing…" : online ? "Synchronize pending customer changes" : "Reconnect to synchronize"}</button> : null}
      {customerMessage ? <p className="offline-access-message" role="status">{customerMessage}</p> : null}
    </section> : null}
    {mode === "suppliers" ? <section className="offline-workspace-section"><h2>Supplier references</h2><div className="offline-workspace-list">{suppliers.map((record) => <article key={record.supplierId}><div><strong>{record.businessName}</strong><span>{[record.contactName, record.phone, record.email].filter(Boolean).join(" · ") || "No contact details recorded."}</span></div><div><strong>{record.active ? "Active" : "Archived"}</strong></div></article>)}</div><p className="offline-mutation-notice">Supplier changes, purchases, payments, refunds, and all procurement writes require an internet connection.</p></section> : null}
    <button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button>
  </section></main>;
}

/** Appears only after an already rendered normal route detects lost connectivity. */
export function OfflineNormalRouteFallback({ mode, returnTo }: { mode: OfflineNormalReadMode; returnTo: string }) {
  const [online, setOnline] = useState(true);
  useEffect(() => { const update = () => setOnline(navigator.onLine); update(); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  return online ? null : <div className="offline-normal-fallback" style={{ position: "fixed", zIndex: 100, inset: 0, overflow: "auto", background: "var(--tg-canvas)" }}><OfflineNormalRead mode={mode} returnTo={returnTo} /></div>;
}
