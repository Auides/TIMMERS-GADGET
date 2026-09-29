"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DexieOfflineStore } from "./db";
import { getInstallationDevice } from "./device";
import { unlockOfflineAccess } from "./offline-auth";
import { crossedLagosBusinessDate, millisecondsUntilNextLagosBusinessDate, OFFLINE_INACTIVITY_MS, requiresOperationalRelock } from "./session";
import type { OfflineAuthProfile } from "./types";

type UnlockedOfflineAccess = Pick<OfflineAuthProfile, "userId" | "displayName" | "role" | "deviceId" | "lastOnlineVerifiedAt"> & { unlockedAt: string; lastActivityAt: string };
type OfflineVaultContextValue = {
  unlocked: UnlockedOfflineAccess | null;
  isUnlocked: boolean;
  lock: () => void;
  unlock: (userId: string, passcode: string) => Promise<{ ok: boolean; reason?: "INVALID" | "THROTTLED" }>;
};
const OfflineVaultContext = createContext<OfflineVaultContextValue | undefined>(undefined);

export function OfflineVaultProvider({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<UnlockedOfflineAccess | null>(null);
  const vaultKey = useRef<CryptoKey | null>(null);
  const lock = useCallback(() => { vaultKey.current = null; setUnlocked(null); }, []);
  const unlock = useCallback(async (userId: string, passcode: string) => {
    const device = await getInstallationDevice();
    const result = await unlockOfflineAccess(new DexieOfflineStore(), userId, device.id, passcode);
    if (!result.ok) return { ok: false, reason: result.reason };
    const now = new Date().toISOString();
    // The unwrapped DEK has only this memory reference; it is never written to IndexedDB or localStorage.
    vaultKey.current = result.vaultKey;
    setUnlocked({ userId: result.profile.userId, displayName: result.profile.displayName, role: result.profile.role, deviceId: result.profile.deviceId, lastOnlineVerifiedAt: result.profile.lastOnlineVerifiedAt, unlockedAt: now, lastActivityAt: now });
    return { ok: true };
  }, []);

  useEffect(() => {
    if (!unlocked || unlocked.role === "ADMIN") return;
    const refreshActivity = () => {
      const now = new Date().toISOString();
      if (crossedLagosBusinessDate(unlocked.role, unlocked.unlockedAt, now)) { lock(); return; }
      setUnlocked((current) => current ? { ...current, lastActivityAt: now } : current);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart", "focus"];
    events.forEach((event) => window.addEventListener(event, refreshActivity));
    return () => events.forEach((event) => window.removeEventListener(event, refreshActivity));
  }, [lock, unlocked]);

  useEffect(() => {
    if (!unlocked || unlocked.role === "ADMIN") return;
    const now = new Date().toISOString();
    if (crossedLagosBusinessDate(unlocked.role, unlocked.unlockedAt, now) || requiresOperationalRelock(unlocked.role, unlocked.lastActivityAt, now)) {
      const timer = window.setTimeout(lock, 0);
      return () => window.clearTimeout(timer);
    }
    const inactivityWait = Math.max(0, Date.parse(unlocked.lastActivityAt) + OFFLINE_INACTIVITY_MS - Date.now());
    const boundaryWait = millisecondsUntilNextLagosBusinessDate(now);
    const wait = Math.min(inactivityWait, boundaryWait);
    const timer = window.setTimeout(lock, wait);
    return () => window.clearTimeout(timer);
  }, [lock, unlocked]);

  const value = useMemo(() => ({ unlocked, isUnlocked: Boolean(unlocked), lock, unlock }), [lock, unlock, unlocked]);
  return <OfflineVaultContext.Provider value={value}>{children}</OfflineVaultContext.Provider>;
}

export function useOfflineVault() {
  const context = useContext(OfflineVaultContext);
  if (!context) throw new Error("useOfflineVault must be used inside OfflineVaultProvider.");
  return context;
}
