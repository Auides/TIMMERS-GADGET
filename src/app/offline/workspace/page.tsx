"use client";

import Link from "next/link";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";

export default function OfflineWorkspacePage() {
  const { unlocked, lock } = useOfflineVault();
  if (!unlocked) return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>Offline access is locked</h1><p>Unlock local access before continuing.</p><Link className="app-button-primary offline-link-button" href="/offline/unlock">Unlock offline access</Link></section></main>;
  return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>Offline access unlocked</h1><p>Business modules will become available here as offline data is enabled.</p><p>Your local vault is unlocked for {unlocked.displayName}. No business data is cached on this device yet.</p><button className="app-button-secondary" type="button" onClick={lock}>Lock offline access</button></section></main>;
}
