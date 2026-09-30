"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DexieOfflineStore } from "@/lib/offline/db";
import { getInstallationDevice } from "@/lib/offline/device";
import { changeOfflinePasscode, disableOfflineAccess, enrollOfflineAccess, type OnlineEnrollmentIdentity } from "@/lib/offline/offline-auth";
import type { OfflineAuthProfile } from "@/lib/offline/types";
import { useOfflineVault } from "@/lib/offline/offline-auth-provider";

function shortDeviceId(id: string) { return `${id.slice(0, 8)}…${id.slice(-4)}`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date(value)); }

export function OfflineAccessManager({ identity }: { identity: OnlineEnrollmentIdentity }) {
  const [deviceId, setDeviceId] = useState<string>();
  const [profile, setProfile] = useState<OfflineAuthProfile>();
  const [passcode, setPasscode] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPasscode, setCurrentPasscode] = useState("");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { lock } = useOfflineVault();
  const refresh = useCallback(async () => {
    const device = await getInstallationDevice();
    setDeviceId(device.id);
    setProfile(await new DexieOfflineStore().getOfflineAuthProfile(identity.profileUserId, device.id));
  }, [identity.profileUserId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh().catch(() => setMessage("Offline access is unavailable in this browser.")); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]); // The identity is server-authenticated for this page.
  const requirePasscode = () => {
    if (passcode.length < 8) throw new Error("Choose an offline passcode with at least 8 characters.");
    if (passcode !== confirmation) throw new Error("Offline passcodes do not match.");
  };
  const enable = async () => {
    try { requirePasscode(); setBusy(true); await enrollOfflineAccess(new DexieOfflineStore(), identity, deviceId!, passcode); setPasscode(""); setConfirmation(""); setMessage("Offline access is enabled for this device."); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : "Offline access could not be enabled."); } finally { setBusy(false); }
  };
  const change = async () => {
    try { requirePasscode(); setBusy(true); await changeOfflinePasscode(new DexieOfflineStore(), identity.profileUserId, deviceId!, currentPasscode, passcode); setCurrentPasscode(""); setPasscode(""); setConfirmation(""); setMessage("Your offline passcode has been changed."); await refresh(); } catch { setMessage("The current passcode could not be verified or the new passcode is invalid."); } finally { setBusy(false); }
  };
  const disable = async () => {
    if (!deviceId || !window.confirm("Disable offline access for your account on this device?")) return;
    setBusy(true);
    try { await disableOfflineAccess(new DexieOfflineStore(), identity.profileUserId, deviceId); lock(); setProfile(undefined); setMessage("Offline access has been disabled on this device."); } finally { setBusy(false); }
  };
  return <main className="app-page app-page-narrow"><div className="offline-access-heading"><div><p className="app-eyebrow">SECURE LOCAL ACCESS</p><h1 className="app-page-title">Offline access</h1><p className="app-page-subtitle">Manage encrypted, device-local offline access for your account only.</p></div></div>
    <section className="app-panel offline-access-panel"><h2>This device</h2><dl><div><dt>Device identifier</dt><dd>{deviceId ? shortDeviceId(deviceId) : "Preparing secure device identity…"}</dd></div><div><dt>Enrollment</dt><dd>{profile ? "Enabled" : "Not enabled"}</dd></div>{profile ? <><div><dt>Last online verification</dt><dd>{formatTime(profile.lastOnlineVerifiedAt)} (Africa/Lagos)</dd></div><div><dt>Role snapshot</dt><dd>{profile.role}</dd></div></> : null}</dl></section>
    <section className="app-panel offline-access-panel"><h2>{profile ? "Change offline passcode" : "Enable offline access"}</h2><p>This passcode unlocks offline data on this device. It is not your TIMMERS GADGET account password.</p>{profile ? <label>Current offline passcode<input autoComplete="current-password" type="password" value={currentPasscode} onChange={(event) => setCurrentPasscode(event.target.value)} /></label> : null}<label>New offline passcode<input autoComplete="new-password" minLength={8} type="password" value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label><label>Confirm new offline passcode<input autoComplete="new-password" minLength={8} type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button className="app-button-primary" type="button" disabled={!deviceId || busy} onClick={() => void (profile ? change() : enable())}>{profile ? "Change passcode" : "Enable offline access"}</button></section>
    {profile ? <section className="app-panel offline-access-panel"><h2>Read-only offline workspace</h2><p>Unlock your local vault to view the encrypted catalogue and inventory snapshot. Refreshing data requires an active online session; business changes remain online-only.</p><Link className="app-button-secondary inline-flex w-fit items-center px-3" href="/offline/workspace">Open offline workspace</Link></section> : null}
    {profile ? <section className="app-panel offline-access-panel offline-access-danger"><h2>Disable offline access</h2><p>This removes your local enrollment and encrypted key material from this device. It does not sign you out online.</p><button className="app-button-secondary app-button-danger" type="button" disabled={busy} onClick={() => void disable()}>Disable on this device</button></section> : null}
    {message ? <p className="offline-access-message" role="status">{message}</p> : null}
  </main>;
}
