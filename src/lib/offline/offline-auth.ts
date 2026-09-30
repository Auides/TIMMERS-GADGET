import { offlineCryptoContext, OFFLINE_CRYPTO_VERSION, productionOfflineCrypto, type OfflineCryptoService } from "./crypto.ts";
import { offlineRoles, type OfflineAuthProfile, type OfflineAuthStore, type OfflineRole } from "./types.ts";

export type OnlineEnrollmentIdentity = {
  authenticatedUserId: string;
  profileUserId: string;
  displayName: string;
  role: OfflineRole;
  active: boolean;
};
type Dependencies = { now?: () => string; crypto?: OfflineCryptoService };
export type UnlockResult =
  | { ok: true; vaultKey: CryptoKey; profile: OfflineAuthProfile }
  | { ok: false; reason: "INVALID" | "THROTTLED"; profile: OfflineAuthProfile };

const defaultNow = () => new Date().toISOString();

function isEligibleIdentity(identity: OnlineEnrollmentIdentity) {
  return identity.active && identity.authenticatedUserId === identity.profileUserId && offlineRoles.includes(identity.role) && Boolean(identity.displayName.trim());
}

function requireEligibleIdentity(identity: OnlineEnrollmentIdentity) {
  if (!isEligibleIdentity(identity)) throw new Error("Offline access can only be enabled by the active signed-in employee.");
}

export function unlockDelayMs(failures: number) {
  if (failures < 3) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (failures - 3));
}

export async function createOfflineEnrollment(identity: OnlineEnrollmentIdentity, deviceId: string, passcode: string, dependencies: Dependencies = {}) {
  requireEligibleIdentity(identity);
  const now = (dependencies.now ?? defaultNow)();
  const crypto = dependencies.crypto ?? productionOfflineCrypto;
  const material = await crypto.createEnrollmentMaterial(passcode, offlineCryptoContext(identity.profileUserId, deviceId));
  const profile: OfflineAuthProfile = {
    userId: identity.profileUserId,
    deviceId,
    displayName: identity.displayName.trim(),
    role: identity.role,
    activeSnapshot: true,
    enrolledAt: now,
    lastOnlineVerifiedAt: now,
    cryptoVersion: OFFLINE_CRYPTO_VERSION,
    kdfAlgorithm: "PBKDF2-SHA-256",
    kdfIterations: crypto.iterations,
    kdfSalt: material.kdfSalt,
    wrappedVaultKey: material.wrappedVaultKey,
    wrapIv: material.wrapIv,
    failedUnlockAttempts: 0,
    nextUnlockAllowedAt: null,
    updatedAt: now,
  };
  return { profile, vaultKey: material.vaultKey };
}

export async function enrollOfflineAccess(store: OfflineAuthStore, identity: OnlineEnrollmentIdentity, deviceId: string, passcode: string, dependencies: Dependencies = {}) {
  const enrollment = await createOfflineEnrollment(identity, deviceId, passcode, dependencies);
  await store.saveOfflineAuthProfile(enrollment.profile);
  return enrollment.profile;
}

export async function unlockOfflineAccess(store: OfflineAuthStore, userId: string, deviceId: string, passcode: string, dependencies: Dependencies = {}): Promise<UnlockResult> {
  const profile = await store.getOfflineAuthProfile(userId, deviceId);
  if (!profile || !profile.activeSnapshot) throw new Error("Offline access is unavailable for this user on this device.");
  const now = (dependencies.now ?? defaultNow)();
  if (profile.nextUnlockAllowedAt && profile.nextUnlockAllowedAt > now) return { ok: false, reason: "THROTTLED", profile };
  try {
    const vaultKey = await (dependencies.crypto ?? productionOfflineCrypto).unwrapVaultKey(passcode, profile, offlineCryptoContext(userId, deviceId));
    const reset = { ...profile, failedUnlockAttempts: 0, nextUnlockAllowedAt: null, updatedAt: now };
    await store.saveOfflineAuthProfile(reset);
    return { ok: true, vaultKey, profile: reset };
  } catch {
    const failures = profile.failedUnlockAttempts + 1;
    const delay = unlockDelayMs(failures);
    const updated = { ...profile, failedUnlockAttempts: failures, nextUnlockAllowedAt: delay ? new Date(Date.parse(now) + delay).toISOString() : null, updatedAt: now };
    await store.saveOfflineAuthProfile(updated);
    return { ok: false, reason: "INVALID", profile: updated };
  }
}

export async function changeOfflinePasscode(store: OfflineAuthStore, userId: string, deviceId: string, currentPasscode: string, nextPasscode: string, dependencies: Dependencies = {}) {
  const unlocked = await unlockOfflineAccess(store, userId, deviceId, currentPasscode, dependencies);
  if (!unlocked.ok) throw new Error("Current offline passcode could not unlock this device.");
  const crypto = dependencies.crypto ?? productionOfflineCrypto;
  const material = await crypto.rewrapVaultKey(unlocked.vaultKey, nextPasscode, offlineCryptoContext(userId, deviceId));
  const now = (dependencies.now ?? defaultNow)();
  const updated = { ...unlocked.profile, ...material, kdfIterations: crypto.iterations, failedUnlockAttempts: 0, nextUnlockAllowedAt: null, updatedAt: now };
  await store.saveOfflineAuthProfile(updated);
  return updated;
}

export async function disableOfflineAccess(store: OfflineAuthStore, userId: string, deviceId: string) {
  if (store.deleteOfflineAccess) return store.deleteOfflineAccess(userId, deviceId);
  await store.purgeOfflineBusinessCache?.(userId, deviceId);
  // Enrolment removal/deactivation discards unreplayable encrypted operations.
  await store.purgeEncryptedMutationTransport?.(userId, deviceId);
  await store.deleteOfflineAuthProfile(userId, deviceId);
}

/** Refreshes the local authorization snapshot only after the server has authenticated this employee. */
export async function reverifyOfflineAccess(store: OfflineAuthStore, identity: OnlineEnrollmentIdentity, deviceId: string, dependencies: Dependencies = {}) {
  const existing = await store.getOfflineAuthProfile(identity.profileUserId, deviceId);
  if (!existing) return { kind: "MISSING" as const };
  if (!isEligibleIdentity(identity)) {
    await disableOfflineAccess(store, existing.userId, deviceId);
    return { kind: "REVOKED" as const };
  }
  const cachePurged = existing.role !== identity.role;
  if (cachePurged) await store.purgeOfflineBusinessCache?.(existing.userId, deviceId);
  const now = (dependencies.now ?? defaultNow)();
  const profile = { ...existing, displayName: identity.displayName.trim(), role: identity.role, activeSnapshot: true, lastOnlineVerifiedAt: now, updatedAt: now };
  await store.saveOfflineAuthProfile(profile);
  return { kind: "REFRESHED" as const, profile, cachePurged };
}
