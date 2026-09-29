import assert from "node:assert/strict";
import test from "node:test";
import { PBKDF2_ITERATIONS, createOfflineCryptoService, decryptVaultValue, encryptVaultValue, offlineCryptoContext } from "../src/lib/offline/crypto.ts";
import { changeOfflinePasscode, createOfflineEnrollment, disableOfflineAccess, enrollOfflineAccess, reverifyOfflineAccess, unlockOfflineAccess } from "../src/lib/offline/offline-auth.ts";
import { crossedLagosBusinessDate, lagosBusinessDate, millisecondsUntilNextLagosBusinessDate, requiresOperationalRelock } from "../src/lib/offline/session.ts";
import type { OfflineAuthProfile, OfflineAuthStore } from "../src/lib/offline/types.ts";

class MemoryAuthStore implements OfflineAuthStore {
  readonly profiles = new Map<string, OfflineAuthProfile>();
  key(userId: string, deviceId: string) { return `${userId}:${deviceId}`; }
  async getOfflineAuthProfile(userId: string, deviceId: string) { return this.profiles.get(this.key(userId, deviceId)); }
  async listOfflineAuthProfiles(deviceId: string) { return [...this.profiles.values()].filter((profile) => profile.deviceId === deviceId); }
  async saveOfflineAuthProfile(profile: OfflineAuthProfile) { this.profiles.set(this.key(profile.userId, profile.deviceId), profile); }
  async deleteOfflineAuthProfile(userId: string, deviceId: string) { this.profiles.delete(this.key(userId, deviceId)); }
}

const crypto = createOfflineCryptoService(1_000);
const deviceId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000101";
const userTwoId = "00000000-0000-4000-8000-000000000102";
const now = () => "2026-09-29T10:00:00.000Z";
const identity = (overrides = {}) => ({ authenticatedUserId: userId, profileUserId: userId, displayName: "Ada Staff", role: "STAFF" as const, active: true, ...overrides });
const enrollmentDependencies = { crypto, now };

test("production PBKDF2 policy remains 600,000 iterations", () => assert.equal(PBKDF2_ITERATIONS, 600_000));

test("enrollment requires an eligible, active, matching authenticated profile", async () => {
  await assert.rejects(() => createOfflineEnrollment(identity({ active: false }), deviceId, "eight-char", enrollmentDependencies));
  await assert.rejects(() => createOfflineEnrollment(identity({ authenticatedUserId: userTwoId }), deviceId, "eight-char", enrollmentDependencies));
  await assert.rejects(() => createOfflineEnrollment({ ...identity(), role: "OTHER" as never }, deviceId, "eight-char", enrollmentDependencies));
});

test("enrollment is stably associated with its device UUID and persists no passcode", async () => {
  const result = await createOfflineEnrollment(identity(), deviceId, "eight-char", enrollmentDependencies);
  assert.equal(result.profile.deviceId, deviceId);
  assert.equal(result.profile.userId, userId);
  assert.equal(JSON.stringify(result.profile).includes("eight-char"), false);
  assert.equal(result.profile.activeSnapshot, true);
});

test("the random vault key is encrypted at rest with distinct salts and IVs", async () => {
  const first = await createOfflineEnrollment(identity(), deviceId, "eight-char", enrollmentDependencies);
  const second = await createOfflineEnrollment(identity(), deviceId, "eight-char", enrollmentDependencies);
  assert.notEqual(first.profile.kdfSalt, second.profile.kdfSalt);
  assert.notEqual(first.profile.wrapIv, second.profile.wrapIv);
  assert.notEqual(first.profile.wrappedVaultKey, "eight-char");
  assert.match(first.profile.wrappedVaultKey, /^[A-Za-z0-9+/]+=*$/);
});

test("a correct passcode unlocks locally and an incorrect passcode does not", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  assert.equal((await unlockOfflineAccess(store, userId, deviceId, "wrong-pass", enrollmentDependencies)).ok, false);
  const unlocked = await unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies);
  assert.equal(unlocked.ok, true);
});

test("different shared-device users cannot unlock each other's vault", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  await enrollOfflineAccess(store, { ...identity(), authenticatedUserId: userTwoId, profileUserId: userTwoId, displayName: "Bola Manager", role: "MANAGER" }, deviceId, "other-pass", enrollmentDependencies);
  assert.equal((await unlockOfflineAccess(store, userTwoId, deviceId, "eight-char", enrollmentDependencies)).ok, false);
  assert.equal((await unlockOfflineAccess(store, userId, deviceId, "other-pass", enrollmentDependencies)).ok, false);
});

test("changing a passcode preserves the underlying vault key", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  const before = await unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies);
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const encrypted = await encryptVaultValue(before.vaultKey, new TextEncoder().encode("future encrypted record"), offlineCryptoContext(userId, deviceId));
  await changeOfflinePasscode(store, userId, deviceId, "eight-char", "different-pass", enrollmentDependencies);
  assert.equal((await unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies)).ok, false);
  const after = await unlockOfflineAccess(store, userId, deviceId, "different-pass", enrollmentDependencies);
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(new TextDecoder().decode(await decryptVaultValue(after.vaultKey, encrypted, offlineCryptoContext(userId, deviceId))), "future encrypted record");
});

test("disabling enrollment removes local unlock capability", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  await disableOfflineAccess(store, userId, deviceId);
  await assert.rejects(() => unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies));
});

test("failed unlocks are tracked, throttled, and reset after success", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  await unlockOfflineAccess(store, userId, deviceId, "wrong-pass", enrollmentDependencies);
  await unlockOfflineAccess(store, userId, deviceId, "wrong-pass", enrollmentDependencies);
  const third = await unlockOfflineAccess(store, userId, deviceId, "wrong-pass", enrollmentDependencies);
  assert.equal(third.ok, false);
  const profile = await store.getOfflineAuthProfile(userId, deviceId);
  assert.equal(profile?.failedUnlockAttempts, 3);
  assert.notEqual(profile?.nextUnlockAllowedAt, null);
  assert.equal((await unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies)).ok, false);
  const later = () => "2026-09-29T10:01:00.000Z";
  const success = await unlockOfflineAccess(store, userId, deviceId, "eight-char", { crypto, now: later });
  assert.equal(success.ok, true);
  assert.equal((await store.getOfflineAuthProfile(userId, deviceId))?.failedUnlockAttempts, 0);
});

test("online revalidation refreshes role snapshot and revokes a deactivated enrollment", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  const refreshed = await reverifyOfflineAccess(store, { ...identity(), displayName: "Ada Manager", role: "MANAGER" }, deviceId, enrollmentDependencies);
  assert.equal(refreshed.kind, "REFRESHED");
  assert.equal((await store.getOfflineAuthProfile(userId, deviceId))?.role, "MANAGER");
  const revoked = await reverifyOfflineAccess(store, identity({ active: false }), deviceId, enrollmentDependencies);
  assert.equal(revoked.kind, "REVOKED");
  assert.equal(await store.getOfflineAuthProfile(userId, deviceId), undefined);
});

test("Staff and Manager require a one-hour inactivity relock while Admin does not", () => {
  const before = "2026-09-29T09:00:00.000Z";
  const hourLater = "2026-09-29T10:00:00.000Z";
  assert.equal(requiresOperationalRelock("STAFF", before, hourLater), true);
  assert.equal(requiresOperationalRelock("MANAGER", before, hourLater), true);
  assert.equal(requiresOperationalRelock("ADMIN", before, hourLater), false);
});

test("Africa/Lagos business-date crossings require Staff and Manager fresh unlocks", () => {
  const beforeMidnight = "2026-09-29T22:59:00.000Z";
  const afterMidnight = "2026-09-29T23:01:00.000Z";
  assert.equal(lagosBusinessDate(beforeMidnight), "2026-09-29");
  assert.equal(lagosBusinessDate(afterMidnight), "2026-09-30");
  assert.equal(millisecondsUntilNextLagosBusinessDate(beforeMidnight), 60_000);
  assert.equal(crossedLagosBusinessDate("STAFF", beforeMidnight, afterMidnight), true);
  assert.equal(crossedLagosBusinessDate("MANAGER", beforeMidnight, afterMidnight), true);
  assert.equal(crossedLagosBusinessDate("ADMIN", beforeMidnight, afterMidnight), false);
});

test("offline unlocking depends only on the local enrollment store and Web Crypto", async () => {
  const store = new MemoryAuthStore();
  await enrollOfflineAccess(store, identity(), deviceId, "eight-char", enrollmentDependencies);
  assert.equal((await unlockOfflineAccess(store, userId, deviceId, "eight-char", enrollmentDependencies)).ok, true);
});
