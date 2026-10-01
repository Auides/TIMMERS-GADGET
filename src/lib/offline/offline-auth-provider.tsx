"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DexieOfflineStore } from "./db";
import { getInstallationDevice } from "./device";
import { unlockOfflineAccess } from "./offline-auth";
import { fetchOfflineReadSnapshot, readOfflineReadCache, refreshOfflineReadCache } from "./business-cache";
import { createCustomerCreatePayload, readPendingCustomerCreates, type CustomerCreatePayload, type PendingCustomerCreate } from "./customer-create";
import { registeredOfflineMutationExecutors } from "./mutation-executors";
import { EncryptedMutationSyncEngine, enqueueEncryptedMutation, type MutationSyncResult, type ReplayAuthorization } from "./mutation-transport";
import { crossedLagosBusinessDate, millisecondsUntilNextLagosBusinessDate, OFFLINE_INACTIVITY_MS, requiresOperationalRelock } from "./session";
import { offlineReadRoles, type OfflineAuthProfile, type OfflineReadRole, type OfflineReadSnapshot } from "./types";

type UnlockedOfflineAccess = Pick<OfflineAuthProfile, "userId" | "displayName" | "role" | "deviceId" | "lastOnlineVerifiedAt"> & { unlockedAt: string; lastActivityAt: string };
type OfflineVaultContextValue = {
  unlocked: UnlockedOfflineAccess | null;
  isUnlocked: boolean;
  lock: () => void;
  unlock: (userId: string, passcode: string) => Promise<{ ok: boolean; reason?: "INVALID" | "THROTTLED" }>;
  readBusinessCache: () => Promise<OfflineReadSnapshot | null>;
  refreshBusinessCache: () => Promise<{ capturedAt: string; catalogueCount: number; serializedInventoryCount: number; customerCount: number; supplierCount: number }>;
  queueCustomerCreate: (fields: { fullName: string; phone?: string | null; email?: string | null }) => Promise<CustomerCreatePayload & { operationId: string }>;
  readPendingCustomerCreates: () => Promise<PendingCustomerCreate[]>;
  syncOfflineMutations: () => Promise<MutationSyncResult>;
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
  const readBusinessCache = useCallback(async () => {
    if (!unlocked || !vaultKey.current) return null;
    if (!(offlineReadRoles as readonly string[]).includes(unlocked.role)) return null;
    return readOfflineReadCache(new DexieOfflineStore(), { ...unlocked, role: unlocked.role as OfflineReadRole, vaultKey: vaultKey.current });
  }, [unlocked]);
  const refreshBusinessCache = useCallback(async () => {
    if (!unlocked || !vaultKey.current) throw new Error("Unlock offline access before refreshing local data.");
    if (!(offlineReadRoles as readonly string[]).includes(unlocked.role)) throw new Error("This role is not approved for offline business reads.");
    const snapshot = await fetchOfflineReadSnapshot();
    return refreshOfflineReadCache(new DexieOfflineStore(), { ...unlocked, role: unlocked.role as OfflineReadRole, vaultKey: vaultKey.current }, snapshot);
  }, [unlocked]);
  const queueCustomerCreate = useCallback(async (fields: { fullName: string; phone?: string | null; email?: string | null }) => {
    if (!unlocked || !vaultKey.current) throw new Error("Unlock offline access before adding a customer.");
    if (!(offlineReadRoles as readonly string[]).includes(unlocked.role)) throw new Error("This role is not approved for offline customer creation.");
    if (typeof navigator !== "undefined" && navigator.onLine) throw new Error("Customer creation is queued only while offline.");
    const payload = createCustomerCreatePayload(fields);
    const operation = await enqueueEncryptedMutation(new DexieOfflineStore(), { userId: unlocked.userId, deviceId: unlocked.deviceId, vaultKey: vaultKey.current }, { mutationType: "CUSTOMER_CREATE", payload });
    return { ...payload, operationId: operation.operationId };
  }, [unlocked]);
  const pendingCustomerCreates = useCallback(async () => {
    if (!unlocked || !vaultKey.current) return [];
    return readPendingCustomerCreates(new DexieOfflineStore(), { userId: unlocked.userId, deviceId: unlocked.deviceId, vaultKey: vaultKey.current });
  }, [unlocked]);
  const syncOfflineMutations = useCallback(async () => {
    if (!unlocked || !vaultKey.current) throw new Error("Unlock offline access before synchronizing local changes.");
    const identity = { userId: unlocked.userId, deviceId: unlocked.deviceId, vaultKey: vaultKey.current };
    const authorization = async (): Promise<ReplayAuthorization> => {
      try {
        const response = await fetch("/api/offline/mutations/replay-authorization", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return { hasAuthenticatedSession: false, hasActiveProfile: false };
        const body = await response.json() as { hasAuthenticatedSession?: unknown; hasActiveProfile?: unknown };
        return { hasAuthenticatedSession: body.hasAuthenticatedSession === true, hasActiveProfile: body.hasActiveProfile === true };
      } catch { return { hasAuthenticatedSession: false, hasActiveProfile: false }; }
    };
    const result = await new EncryptedMutationSyncEngine(new DexieOfflineStore(), () => identity, authorization, registeredOfflineMutationExecutors).synchronize();
    if (result.applied > 0 && (offlineReadRoles as readonly string[]).includes(unlocked.role)) {
      const snapshot = await fetchOfflineReadSnapshot();
      await refreshOfflineReadCache(new DexieOfflineStore(), { ...identity, role: unlocked.role as OfflineReadRole }, snapshot);
    }
    return result;
  }, [unlocked]);

  useEffect(() => {
    window.addEventListener("timmers-offline-access-revoked", lock);
    return () => window.removeEventListener("timmers-offline-access-revoked", lock);
  }, [lock]);

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

  const value = useMemo(() => ({ unlocked, isUnlocked: Boolean(unlocked), lock, unlock, readBusinessCache, refreshBusinessCache, queueCustomerCreate, readPendingCustomerCreates: pendingCustomerCreates, syncOfflineMutations }), [lock, unlock, unlocked, readBusinessCache, refreshBusinessCache, queueCustomerCreate, pendingCustomerCreates, syncOfflineMutations]);
  return <OfflineVaultContext.Provider value={value}>{children}</OfflineVaultContext.Provider>;
}

export function useOfflineVault() {
  const context = useContext(OfflineVaultContext);
  if (!context) throw new Error("useOfflineVault must be used inside OfflineVaultProvider.");
  return context;
}
