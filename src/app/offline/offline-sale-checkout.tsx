"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { OfflineCatalogueRecord } from "@/lib/offline/types";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";

type CartLine = OfflineCatalogueRecord & { quantity: number };
function lineKey(record: Pick<OfflineCatalogueRecord, "productId" | "variantId" | "condition">) { return `${record.productId}:${record.variantId ?? "base"}:${record.condition}`; }
function lagosDate() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function money(value: number) { return `₦${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

/** Offline-only surface. It records encrypted provisional intent; it never changes cached stock. */
export function OfflineSaleCheckout() {
  const { unlocked, readBusinessCache, queueOfflineSaleCheckout, readPendingSaleCheckouts, readSaleCheckoutReviews, lock } = useOfflineVault();
  const [records, setRecords] = useState<OfflineCatalogueRecord[]>([]);
  const [hasSnapshot, setHasSnapshot] = useState<boolean | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof readPendingSaleCheckouts>>>([]);
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof readSaleCheckoutReviews>>>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      const [snapshot, pendingSales, saleReviews] = await Promise.all([readBusinessCache(), readPendingSaleCheckouts(), readSaleCheckoutReviews()]);
      if (!live) return;
      setRecords(snapshot?.catalogue ?? []); setHasSnapshot(Boolean(snapshot)); setPending(pendingSales); setReviews(saleReviews);
    };
    void load();
    return () => { live = false; };
  }, [readBusinessCache, readPendingSaleCheckouts, readSaleCheckoutReviews]);
  const filtered = useMemo(() => {
    const candidate = search.trim().toLowerCase();
    return records.filter((record) => !candidate || [record.productName, record.productSku, record.productBarcode, record.variantSku, record.variantBarcode].filter(Boolean).some((value) => value!.toLowerCase().includes(candidate)));
  }, [records, search]);
  const total = cart.reduce((sum, record) => sum + record.sellingPrice * record.quantity, 0);
  const add = (record: OfflineCatalogueRecord) => setCart((current) => {
    const key = lineKey(record); const existing = current.find((item) => lineKey(item) === key);
    return existing ? current.map((item) => lineKey(item) === key ? { ...item, quantity: item.quantity + 1 } : item) : [...current, { ...record, quantity: 1 }];
  });
  const updateQuantity = (key: string, quantity: number) => setCart((current) => quantity > 0 ? current.map((item) => lineKey(item) === key ? { ...item, quantity } : item) : current.filter((item) => lineKey(item) !== key));
  const save = async () => {
    if (!cart.length) { setMessage("Add at least one non-serialized item before recording a local sale."); return; }
    setBusy(true); setMessage("");
    try {
      const result = await queueOfflineSaleCheckout({
        schemaVersion: 1, businessDate: lagosDate(), customerId: null, notes: null, dependencies: [],
        lines: cart.map((record) => ({ productId: record.productId, variantId: record.variantId, condition: record.condition as "NEW" | "USED" | "REFURBISHED", quantity: record.quantity, quote: { cataloguePriceId: record.cataloguePriceId, priceRevision: record.priceRevision, quotedSellingPrice: record.sellingPrice.toFixed(2) } })),
        payment: { method: "CASH", amount: total.toFixed(2) },
      });
      setCart([]); setPending(await readPendingSaleCheckouts()); setReviews(await readSaleCheckoutReviews());
      setMessage(`Local pending sale recorded securely. Provisional reference OFFLINE-${result.operationId.slice(0, 8).toUpperCase()} awaits synchronization.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The local sale could not be recorded securely."); }
    finally { setBusy(false); }
  };
  if (!unlocked) return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE SALES</p><h1>Offline data is locked.</h1><p>Unlock local access before recording a provisional cash sale.</p><Link className="app-button-primary offline-link-button" href="/offline/unlock?returnTo=%2Foffline%2Fsales">Unlock offline access</Link></section></main>;
  if (unlocked.role === "ADMIN") return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE SALES</p><h1>Offline checkout is unavailable</h1><p>Admin offline checkout is not approved for this phase.</p></section></main>;
  if (hasSnapshot === false) return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE SALES</p><h1>No offline data is available</h1><p>Connect to the internet and refresh offline data before recording a provisional sale. No stock is being shown as zero.</p></section></main>;
  return <main className="offline-page"><section className="offline-panel offline-workspace-panel"><p className="app-eyebrow">OFFLINE SALES</p><h1>Provisional cash sale</h1><p>Local pending sale. Cached stock and prices are advisory; the server must confirm the exact quote and stock after synchronization.</p>
    <p className="offline-mutation-notice">Non-serialized items only · One CASH payment only · No discounts, credit, split payments, or serialized units.</p>
    <label className="offline-workspace-search">Search cached catalogue<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Product, SKU or barcode" /></label>
    <section className="offline-workspace-section"><h2>Cached sellable items</h2><div className="offline-workspace-list">{filtered.map((record) => <article key={lineKey(record)}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.variantSku ?? record.productSku} · {record.condition} · cached quantity {record.quantity}</span></div><div><strong>{money(record.sellingPrice)}</strong><button className="app-button-secondary" type="button" onClick={() => add(record)}>Add</button></div></article>)}</div></section>
    <section className="offline-workspace-section"><h2>Cash sale</h2>{cart.length ? <div className="offline-workspace-list">{cart.map((record) => <article key={lineKey(record)}><div><strong>{record.productName}</strong><span>{money(record.sellingPrice)} each · exact cached quote</span></div><label>Quantity<input aria-label={`Quantity for ${record.productName}`} type="number" min="1" value={record.quantity} onChange={(event) => updateQuantity(lineKey(record), Number(event.target.value))} /></label></article>)}</div> : <p>No items selected.</p>}<p><strong>Provisional cash tendered: {money(total)}</strong></p><button className="app-button-primary" type="button" disabled={busy || !cart.length} onClick={() => void save()}>{busy ? "Saving securely…" : "Record local pending sale"}</button></section>
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
    {pending.map((sale) => <p key={sale.operationId} className="offline-mutation-notice"><strong>Local pending sale</strong> · OFFLINE-{sale.operationId.slice(0, 8).toUpperCase()} · Awaiting synchronization.</p>)}
    {reviews.filter((sale) => sale.state === "CONFLICT" || sale.state === "REJECTED").map((sale) => <p key={sale.operationId} className="offline-access-message"><strong>{sale.state === "CONFLICT" ? "Conflict requiring review" : "Rejected"}</strong> · OFFLINE-{sale.operationId.slice(0, 8).toUpperCase()} · {sale.reasonCode === "SALE_CHECKOUT_CONFLICT" ? "Price changed, stock is insufficient, or an item is unavailable. No price or quantity was changed automatically." : "The local sale could not be accepted under current authorization or validation."}</p>)}
    <button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button>
  </section></main>;
}

/** Mounted on the normal POS route after it detects disconnection; no authenticated HTML is cached. */
export function OfflineSalesRouteFallback() {
  const [online, setOnline] = useState(true);
  useEffect(() => { const update = () => setOnline(navigator.onLine); update(); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  return online ? null : <div className="offline-normal-fallback" style={{ position: "fixed", zIndex: 100, inset: 0, overflow: "auto", background: "var(--tg-canvas)" }}><OfflineSaleCheckout /></div>;
}
