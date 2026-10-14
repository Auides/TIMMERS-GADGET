"use client";

import { useEffect, useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import type { OfflineReadSnapshot } from "@/lib/offline/types";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date(value));
}

function formatPrice(value: number | null) {
  return value === null ? "Price not configured" : `₦${value.toLocaleString()}`;
}

function ageLabel(value: string) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "updated less than a minute ago";
  if (minutes < 60) return `updated ${minutes} minutes ago`;
  return `updated ${Math.floor(minutes / 60)} hours ago`;
}

export function OfflineReadWorkspace() {
  const { unlocked, lock, readBusinessCache, refreshBusinessCache } = useOfflineVault();
  const [snapshot, setSnapshot] = useState<OfflineReadSnapshot | null>(null);
  const [message, setMessage] = useState("Loading encrypted local data…");
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let disposed = false;
    void readBusinessCache().then((cached) => {
      if (disposed) return;
      setSnapshot(cached);
      setMessage(cached ? "" : "No encrypted catalogue and inventory snapshot has been saved for this user on this device.");
    }).catch(() => {
      if (!disposed) setMessage("Encrypted local data could not be read. Refresh online after unlocking.");
    });
    return () => { disposed = true; };
  }, [readBusinessCache]);

  const refresh = async () => {
    if (!navigator.onLine) { setMessage("Reconnect before refreshing. Existing encrypted data remains available."); return; }
    setRefreshing(true);
    try {
      await refreshBusinessCache();
      const cached = await readBusinessCache();
      setSnapshot(cached);
      setMessage(cached ? "Encrypted snapshot refreshed." : "The refreshed snapshot could not be read.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The encrypted snapshot could not be refreshed.");
    } finally { setRefreshing(false); }
  };

  const query = search.trim().toLocaleLowerCase();
  const catalogue = useMemo(() => snapshot?.catalogue.filter((record) => !query || [record.productName, record.productSku, record.productBarcode, record.variantLabel, record.variantSku, record.variantBarcode].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const serialized = useMemo(() => snapshot?.serializedInventory.filter((record) => !query || [record.productName, record.productSku, record.variantLabel, record.variantSku, ...record.identifiers.flatMap((identifier) => [identifier.identifierType, identifier.identifierValue])].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);

  if (!unlocked) return null;
  if (unlocked.role === "ADMIN") return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>Offline read cache is unavailable</h1><p>Admin work remains online-only. No catalogue or inventory data is stored for this profile.</p><button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button></section></main>;

  return <main className="offline-page"><section className="offline-panel offline-workspace-panel"><p className="app-eyebrow">OFFLINE READ WORKSPACE</p><h1>Catalogue and inventory</h1><p>Read-only encrypted local data for {unlocked.displayName}. Sales, stock, and every other business mutation remain online-only.</p>
    <div className="offline-workspace-toolbar"><div>{snapshot ? <><strong>Last sync: {formatTime(snapshot.capturedAt)}</strong><span>{ageLabel(snapshot.capturedAt)} · Africa/Lagos</span></> : <span>No saved snapshot</span>}</div><button className="app-button-primary" disabled={refreshing} type="button" onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh online"}</button></div>
    <label className="offline-workspace-search">Search saved catalogue and inventory<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, SKU, barcode or identifier" /></label>
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
    <section className="offline-workspace-section"><h2>Catalogue and non-serialized stock</h2><p>{snapshot ? `${catalogue.length} of ${snapshot.catalogue.length} saved rows` : "No saved rows"}</p><div className="offline-workspace-list">{catalogue.map((record) => <article key={`${record.productId}-${record.variantId ?? "base"}-${record.condition}`}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.variantSku ?? record.productSku} · {record.condition}</span></div><div><strong>{formatPrice(record.sellingPrice)}</strong><span>On hand {record.quantity}</span></div></article>)}</div></section>
    <section className="offline-workspace-section"><h2>Serialized inventory</h2><p>{snapshot ? `${serialized.length} of ${snapshot.serializedInventory.length} saved physical units` : "No saved physical units"}</p><div className="offline-workspace-list">{serialized.map((record) => <article key={record.unitId}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.identifiers.map((identifier) => `${identifier.identifierType}: ${identifier.identifierValue}`).join(" · ")} · {record.condition}</span></div><div><strong>{record.status}</strong><span>{formatPrice(record.sellingPrice)}</span></div></article>)}</div></section>
    <button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button>
  </section></main>;
}
