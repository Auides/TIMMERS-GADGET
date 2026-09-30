"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import type { OfflineReadSnapshot } from "@/lib/offline/types";

export type OfflineNormalReadMode = "catalogue" | "inventory";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date(value));
}

function staleLabel(value: string) {
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(value)) / 60_000);
  return minutes < 1 ? "updated less than a minute ago" : minutes < 60 ? `updated ${minutes} minutes ago` : `updated ${Math.floor(minutes / 60)} hours ago`;
}

function price(value: number | null) {
  return value === null ? "Price not configured" : `NGN ${value.toLocaleString()}`;
}

function LockedOfflineData({ returnTo }: { returnTo: string }) {
  return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>Offline data is locked.</h1><p>Unlock local access before viewing this device&apos;s encrypted catalogue or inventory data.</p><Link className="app-button-primary offline-link-button" href={`/offline/unlock?returnTo=${encodeURIComponent(returnTo)}`}>Unlock offline access</Link></section></main>;
}

export function OfflineNormalRead({ mode, returnTo }: { mode: OfflineNormalReadMode; returnTo: string }) {
  const { unlocked, lock, readBusinessCache, refreshBusinessCache } = useOfflineVault();
  const [snapshot, setSnapshot] = useState<OfflineReadSnapshot | null>(null);
  const [message, setMessage] = useState("Loading encrypted local data…");
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); };
  }, []);
  useEffect(() => {
    if (!unlocked) return;
    let disposed = false;
    void readBusinessCache().then((cached) => {
      if (disposed) return;
      setSnapshot(cached);
      setMessage(cached ? "" : "No offline data is available on this device. Connect to the internet and refresh offline data first.");
    }).catch(() => { if (!disposed) setMessage("Encrypted local data could not be read. Refresh online after unlocking."); });
    return () => { disposed = true; };
  }, [readBusinessCache, unlocked]);

  const refresh = async () => {
    if (!online) { setMessage("Reconnect before refreshing. Existing encrypted data remains available."); return; }
    setRefreshing(true);
    try {
      await refreshBusinessCache();
      const cached = await readBusinessCache();
      setSnapshot(cached);
      setMessage(cached ? "Encrypted snapshot refreshed." : "The refreshed snapshot could not be read.");
    } catch { setMessage("The encrypted snapshot could not be refreshed."); } finally { setRefreshing(false); }
  };

  const query = search.trim().toLocaleLowerCase();
  const catalogue = useMemo(() => snapshot?.catalogue.filter((record) => !query || [record.productName, record.productSku, record.productBarcode, record.variantLabel, record.variantSku, record.variantBarcode].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const serialized = useMemo(() => snapshot?.serializedInventory.filter((record) => !query || [record.productName, record.productSku, record.identifierValue, record.variantLabel, record.variantSku].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query))) ?? [], [query, snapshot]);
  const isInventory = mode === "inventory";

  if (!unlocked) return <LockedOfflineData returnTo={returnTo} />;
  if (unlocked.role === "ADMIN") return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>Offline read cache is unavailable</h1><p>Admin work remains online-only. Approved Admin offline functionality is future work.</p><button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button></section></main>;

  return <main className="offline-page"><section className="offline-panel offline-workspace-panel"><p className="app-eyebrow">OFFLINE DATA</p><h1>{isInventory ? "Inventory" : "Catalogue"}</h1><p>{isInventory ? "Inventory reflects this device's last synchronized state. It is not globally current stock." : "Read-only catalogue data from this device's last synchronized state."}</p>
    <div className="offline-workspace-toolbar"><div>{snapshot ? <><strong>Last synced: {formatTime(snapshot.capturedAt)}</strong><span>Offline data · {staleLabel(snapshot.capturedAt)} · Africa/Lagos</span></> : <span>No saved snapshot</span>}</div><button className="app-button-primary" disabled={!online || refreshing} type="button" onClick={() => void refresh()}>{refreshing ? "Refreshing…" : online ? "Refresh online" : "Offline"}</button></div>
    <label className="offline-workspace-search">Search saved {isInventory ? "inventory" : "catalogue"}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={isInventory ? "Product, SKU, IMEI or serial" : "Product, SKU or barcode"} /></label>
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
    <section className="offline-workspace-section"><h2>{isInventory ? "Non-serialized stock" : "Products and variants"}</h2><div className="offline-workspace-list">{catalogue.map((record) => <article key={`${record.productId}-${record.variantId ?? "base"}-${record.condition}`}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.variantSku ?? record.productSku} · {record.condition}</span></div><div><strong>{price(record.sellingPrice)}</strong><span>{isInventory ? `Cached quantity ${record.quantity}` : `Stock ${record.quantity}`}</span></div></article>)}</div></section>
    {isInventory ? <section className="offline-workspace-section"><h2>Serialized inventory</h2><div className="offline-workspace-list">{serialized.map((record) => <article key={`${record.unitId}-${record.identifierType}-${record.identifierValue}`}><div><strong>{record.productName}{record.variantLabel ? ` — ${record.variantLabel}` : ""}</strong><span>{record.identifierType}: {record.identifierValue} · {record.condition}</span></div><div><strong>{record.status}</strong><span>{price(record.sellingPrice)}</span></div></article>)}</div><p className="offline-mutation-notice">Opening stock, adjustment requests, direct adjustments, serialized adjustments, and every inventory write require an internet connection.</p></section> : <p className="offline-mutation-notice">Catalogue changes, prices, and archive actions require an internet connection.</p>}
    <button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button>
  </section></main>;
}

/** Appears only after an already rendered normal route detects lost connectivity. */
export function OfflineNormalRouteFallback({ mode, returnTo }: { mode: OfflineNormalReadMode; returnTo: string }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); };
  }, []);
  return online ? null : <div className="offline-normal-fallback" style={{ position: "fixed", zIndex: 100, inset: 0, overflow: "auto", background: "var(--tg-canvas)" }}><OfflineNormalRead mode={mode} returnTo={returnTo} /></div>;
}
