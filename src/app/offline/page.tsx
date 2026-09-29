import Link from "next/link";

export default function OfflinePage() {
  return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>You are offline</h1><p>Locally available functionality will remain usable as modules are enabled. Unsynchronized changes will sync after reconnection.</p><p>Not every operational module is offline-ready yet.</p><Link className="app-button-primary offline-link-button" href="/offline/unlock">Unlock offline access</Link></section></main>;
}
