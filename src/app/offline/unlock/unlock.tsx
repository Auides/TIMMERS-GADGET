"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DexieOfflineStore } from "@/lib/offline/db";
import { getInstallationDevice } from "@/lib/offline/device";
import type { OfflineAuthProfile } from "@/lib/offline/types";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";

const SAFE_RETURN_ROUTES = ["/offline/workspace", "/offline/catalogue", "/offline/inventory", "/offline/customers", "/offline/suppliers", "/offline/purchases", "/app/catalogue", "/app/inventory", "/app/suppliers", "/app/purchases"];

function getSafeReturnTo() {
  if (typeof window === "undefined") return "/offline/workspace";

  const requested = new URLSearchParams(window.location.search).get("returnTo");

  return requested && SAFE_RETURN_ROUTES.includes(requested)
    ? requested
    : "/offline/workspace";
}

export function OfflineUnlock() {
  const [profiles, setProfiles] = useState<OfflineAuthProfile[]>([]);
  const [selected, setSelected] = useState("");
  const [passcode, setPasscode] = useState("");
  const [message, setMessage] = useState("Preparing local offline access…");
  const [busy, setBusy] = useState(false);
  const { unlock } = useOfflineVault();
  const router = useRouter();
  useEffect(() => { void (async () => {
    try {
      const device = await getInstallationDevice();
      const available = await new DexieOfflineStore().listOfflineAuthProfiles(device.id);
      setProfiles(available); setSelected(available[0]?.userId ?? ""); setMessage(available.length ? "" : "No local offline access has been enabled on this device.");
    } catch { setMessage("Offline access is unavailable in this browser."); }
  })(); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await unlock(selected, passcode);
      setPasscode("");
      if (!result.ok) { setMessage(result.reason === "THROTTLED" ? "Please wait before trying again." : "The passcode could not unlock offline access."); return; }
     router.replace(getSafeReturnTo());
    } catch { setMessage("The passcode could not unlock offline access."); } finally { setBusy(false); }
  };
  return <main className="offline-page"><section className="offline-panel"><p className="app-eyebrow">TIMMERS GADGET</p><h1>Unlock offline access</h1><p>This passcode unlocks offline data on this device. It is not your TIMMERS GADGET account password.</p>{profiles.length ? <form className="offline-unlock-form" onSubmit={(event) => void submit(event)}>{profiles.length > 1 ? <label>Local user<select value={selected} onChange={(event) => setSelected(event.target.value)}>{profiles.map((profile) => <option key={profile.userId} value={profile.userId}>{profile.displayName} ({profile.role})</option>)}</select></label> : <p>Unlocking local access for <strong>{profiles[0]?.displayName}</strong>.</p>}<label>Offline passcode<input autoComplete="current-password" autoFocus type="password" minLength={8} required value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label><button className="app-button-primary" disabled={busy} type="submit">Unlock</button></form> : null}{message ? <p role="status">{message}</p> : null}<p><Link href="/offline">Return to offline information</Link></p></section></main>;
}
