"use client";

import Link from "next/link";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";
import { OfflineReadWorkspace } from "./offline-read-workspace";

export default function OfflineWorkspacePage() {
  const { unlocked } = useOfflineVault();
  if (!unlocked) return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>Offline access is locked</h1><p>Unlock local access before continuing.</p><Link className="app-button-primary offline-link-button" href="/offline/unlock">Unlock offline access</Link></section></main>;
  return <OfflineReadWorkspace />;
}
