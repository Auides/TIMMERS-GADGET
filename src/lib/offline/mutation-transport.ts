import { decryptVaultValue, encryptVaultValue } from "./crypto.ts";
import { compareEncryptedMutationEnvelopes } from "./db.ts";
import { ENCRYPTED_MUTATION_SCHEMA_VERSION, type EncryptedMutationConflict, type EncryptedMutationEnvelope, type EncryptedMutationState, type EncryptedMutationStore, type JsonValue } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_RETRY_DELAY_SECONDS = 60 * 60;

/** Identifiers are intentionally non-sensitive and do not grant any authority. */
export const futureMutationTypes = ["CUSTOMER_CREATE", "CUSTOMER_UPDATE", "SUPPLIER_CREATE", "SUPPLIER_UPDATE", "INVENTORY_ADJUSTMENT_REQUEST", "SALE_CREATE"] as const;
export type FutureMutationType = (typeof futureMutationTypes)[number];
export type MutationVaultIdentity = { userId: string; deviceId: string; vaultKey: CryptoKey };
export type EncryptedMutationInput = { mutationType: FutureMutationType; payload: JsonValue };
type Dependencies = { now?: () => string; createId?: () => string };

export type ReplayAuthorization = {
  /** These are prerequisites only; every executor must still use server-side authorization. */
  hasAuthenticatedSession: boolean;
  hasActiveProfile: boolean;
};

export type MutationExecutionOutcome =
  | { kind: "APPLIED" }
  | { kind: "TRANSIENT"; statusCode?: string }
  | { kind: "CONFLICT"; reasonCode: string; encryptedContext?: JsonValue }
  | { kind: "REJECTED"; reasonCode: string };
export type MutationExecutor = (operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }) => Promise<MutationExecutionOutcome>;
export type MutationExecutorRegistry = ReadonlyMap<string, MutationExecutor>;
export const noBusinessMutationExecutors: MutationExecutorRegistry = new Map();

export type MutationSyncResult = {
  processed: number;
  applied: number;
  retried: number;
  conflicted: number;
  rejected: number;
  recovered: number;
  locked: boolean;
  authorizationUnavailable: boolean;
};

const transitions: Readonly<Record<EncryptedMutationState, readonly EncryptedMutationState[]>> = {
  // A server-confirmed deactivation can reject an unstarted operation without decrypting it.
  PENDING: ["SYNCING", "REJECTED"],
  SYNCING: ["PENDING", "APPLIED", "CONFLICT", "REJECTED"],
  APPLIED: [],
  CONFLICT: [],
  REJECTED: [],
};

function createUuid() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure UUID generation is unavailable in this browser.");
  return id;
}
function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}
function nowFrom(dependencies: Dependencies) { return (dependencies.now ?? (() => new Date().toISOString()))(); }
function idFrom(dependencies: Dependencies) { return dependencies.createId ?? createUuid; }

/** AES-GCM AAD prevents an encrypted request from being substituted into another operation or scope. */
export function encryptedMutationContext(record: Pick<EncryptedMutationEnvelope, "userId" | "deviceId" | "operationId" | "mutationType" | "schemaVersion">) {
  return encoder.encode(JSON.stringify({ cryptoVersion: "v1", userId: record.userId, deviceId: record.deviceId, operationId: record.operationId, mutationType: record.mutationType, schemaVersion: record.schemaVersion }));
}
function encryptedConflictContext(record: Pick<EncryptedMutationEnvelope, "userId" | "deviceId" | "operationId" | "mutationType" | "schemaVersion">) {
  return encoder.encode(JSON.stringify({ cryptoVersion: "v1", recordType: "mutation-conflict", userId: record.userId, deviceId: record.deviceId, operationId: record.operationId, mutationType: record.mutationType, schemaVersion: record.schemaVersion }));
}

export async function createEncryptedMutationEnvelope(identity: MutationVaultIdentity, input: EncryptedMutationInput, dependencies: Dependencies = {}): Promise<EncryptedMutationEnvelope> {
  const createId = idFrom(dependencies);
  const record = {
    operationId: createId(),
    idempotencyKey: createId(),
    userId: nonEmpty(identity.userId, "userId"),
    deviceId: nonEmpty(identity.deviceId, "deviceId"),
    mutationType: nonEmpty(input.mutationType, "mutationType"),
    schemaVersion: ENCRYPTED_MUTATION_SCHEMA_VERSION,
    createdAt: nowFrom(dependencies),
    state: "PENDING" as const,
    retryCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    statusCode: null,
  };
  const encrypted = await encryptVaultValue(identity.vaultKey, encoder.encode(JSON.stringify(input.payload)), encryptedMutationContext(record));
  return { ...record, ...encrypted };
}

export async function enqueueEncryptedMutation(store: EncryptedMutationStore, identity: MutationVaultIdentity, input: EncryptedMutationInput, dependencies: Dependencies = {}) {
  const record = await createEncryptedMutationEnvelope(identity, input, dependencies);
  await store.addEncryptedMutation(record);
  return record;
}

export async function decryptEncryptedMutationPayload(identity: MutationVaultIdentity, record: EncryptedMutationEnvelope): Promise<JsonValue> {
  if (identity.userId !== record.userId || identity.deviceId !== record.deviceId) throw new Error("Encrypted mutation scope does not match the unlocked vault.");
  const plaintext = await decryptVaultValue(identity.vaultKey, { ciphertext: record.ciphertext, iv: record.iv }, encryptedMutationContext(record));
  return JSON.parse(decoder.decode(plaintext)) as JsonValue;
}

export function canTransitionEncryptedMutation(from: EncryptedMutationState, to: EncryptedMutationState) {
  return transitions[from].includes(to);
}
function transition(record: EncryptedMutationEnvelope, state: EncryptedMutationState, now: string, updates: Partial<Omit<EncryptedMutationEnvelope, "operationId" | "idempotencyKey" | "userId" | "deviceId" | "mutationType" | "schemaVersion" | "createdAt" | "ciphertext" | "iv" | "state">> = {}) {
  if (!canTransitionEncryptedMutation(record.state, state)) throw new Error(`Invalid encrypted mutation transition: ${record.state} to ${state}.`);
  return { ...record, ...updates, state, lastAttemptAt: now };
}

export function recoverStaleEncryptedMutation(record: EncryptedMutationEnvelope, now: string, staleBefore: string) {
  if (record.state !== "SYNCING" || !record.lastAttemptAt || record.lastAttemptAt >= staleBefore) return record;
  return transition(record, "PENDING", now, { nextAttemptAt: now, statusCode: "RECOVERED_STALE_SYNCING" });
}

export function retryDelaySeconds(retryCount: number) {
  return Math.min(MAX_RETRY_DELAY_SECONDS, 5 * 2 ** Math.min(Math.max(retryCount, 0), 10));
}
export function retryEncryptedMutation(record: EncryptedMutationEnvelope, now: string, statusCode = "TRANSIENT_FAILURE") {
  const retryCount = record.retryCount + 1;
  const nextAttemptAt = new Date(Date.parse(now) + retryDelaySeconds(retryCount) * 1_000).toISOString();
  return transition(record, "PENDING", now, { retryCount, nextAttemptAt, statusCode });
}

function isDue(record: EncryptedMutationEnvelope, now: string) {
  return record.state === "PENDING" && (!record.nextAttemptAt || record.nextAttemptAt <= now);
}
async function encryptedConflict(identity: MutationVaultIdentity, record: EncryptedMutationEnvelope, reasonCode: string, detectedAt: string, context: JsonValue | undefined): Promise<EncryptedMutationConflict> {
  const encrypted = context === undefined ? null : await encryptVaultValue(identity.vaultKey, encoder.encode(JSON.stringify(context)), encryptedConflictContext(record));
  return { operationId: record.operationId, userId: record.userId, deviceId: record.deviceId, mutationType: record.mutationType, schemaVersion: record.schemaVersion, state: "CONFLICT", reasonCode: nonEmpty(reasonCode, "reasonCode"), detectedAt, ciphertext: encrypted?.ciphertext ?? null, iv: encrypted?.iv ?? null };
}

/** Application-controlled, single-flight dispatcher. This phase registers no business executor and makes no network calls. */
export class EncryptedMutationSyncEngine {
  private inFlight: Promise<MutationSyncResult> | undefined;
  private readonly store: EncryptedMutationStore;
  private readonly getUnlockedIdentity: () => MutationVaultIdentity | null;
  private readonly getReplayAuthorization: () => Promise<ReplayAuthorization>;
  private readonly executors: MutationExecutorRegistry;
  private readonly dependencies: Dependencies & { staleSyncingAfterMs?: number };

  constructor(
    store: EncryptedMutationStore,
    getUnlockedIdentity: () => MutationVaultIdentity | null,
    getReplayAuthorization: () => Promise<ReplayAuthorization>,
    executors: MutationExecutorRegistry = noBusinessMutationExecutors,
    dependencies: Dependencies & { staleSyncingAfterMs?: number } = {},
  ) {
    this.store = store;
    this.getUnlockedIdentity = getUnlockedIdentity;
    this.getReplayAuthorization = getReplayAuthorization;
    this.executors = executors;
    this.dependencies = dependencies;
  }

  synchronize() {
    this.inFlight ??= this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(): Promise<MutationSyncResult> {
    const result: MutationSyncResult = { processed: 0, applied: 0, retried: 0, conflicted: 0, rejected: 0, recovered: 0, locked: false, authorizationUnavailable: false };
    const identity = this.getUnlockedIdentity();
    if (!identity) { result.locked = true; return result; }
    const now = nowFrom(this.dependencies);
    const staleBefore = new Date(Date.parse(now) - (this.dependencies.staleSyncingAfterMs ?? 5 * 60_000)).toISOString();
    const all = await this.store.listEncryptedMutations(identity.userId, identity.deviceId);
    for (const record of all) {
      const recovered = recoverStaleEncryptedMutation(record, now, staleBefore);
      if (recovered !== record) { await this.store.updateEncryptedMutation(recovered); result.recovered += 1; }
    }
    const authorization = await this.getReplayAuthorization();
    if (!authorization.hasAuthenticatedSession) { result.authorizationUnavailable = true; return result; }
    if (!authorization.hasActiveProfile) {
      for (const record of await this.store.listEncryptedMutations(identity.userId, identity.deviceId)) {
        if (record.state === "PENDING") {
          await this.store.updateEncryptedMutation(transition(record, "REJECTED", now, { statusCode: "AUTHORIZATION_REJECTED" }));
          result.rejected += 1;
        }
      }
      return result;
    }
    const pending = (await this.store.listEncryptedMutations(identity.userId, identity.deviceId)).filter((record) => isDue(record, now)).sort(compareEncryptedMutationEnvelopes);
    for (const record of pending) await this.process(identity, record, result);
    return result;
  }

  private async process(identity: MutationVaultIdentity, record: EncryptedMutationEnvelope, result: MutationSyncResult) {
    const now = nowFrom(this.dependencies);
    const syncing = transition(record, "SYNCING", now, { nextAttemptAt: null, statusCode: null });
    await this.store.updateEncryptedMutation(syncing);
    result.processed += 1;
    const executor = this.executors.get(syncing.mutationType);
    if (!executor) {
      await this.store.updateEncryptedMutation(transition(syncing, "REJECTED", now, { statusCode: "MUTATION_TYPE_NOT_IMPLEMENTED" }));
      result.rejected += 1;
      return;
    }
    let outcome: MutationExecutionOutcome;
    try {
      const payload = await decryptEncryptedMutationPayload(identity, syncing);
      outcome = await executor({ operationId: syncing.operationId, idempotencyKey: syncing.idempotencyKey, mutationType: syncing.mutationType, payload });
    } catch {
      outcome = { kind: "TRANSIENT", statusCode: "TRANSPORT_UNAVAILABLE" };
    }
    if (outcome.kind === "APPLIED") {
      await this.store.updateEncryptedMutation(transition(syncing, "APPLIED", now, { statusCode: "APPLIED" })); result.applied += 1; return;
    }
    if (outcome.kind === "TRANSIENT") {
      await this.store.updateEncryptedMutation(retryEncryptedMutation(syncing, now, outcome.statusCode ?? "TRANSIENT_FAILURE")); result.retried += 1; return;
    }
    if (outcome.kind === "CONFLICT") {
      await this.store.updateEncryptedMutation(transition(syncing, "CONFLICT", now, { statusCode: outcome.reasonCode }));
      await this.store.addEncryptedMutationConflict(await encryptedConflict(identity, syncing, outcome.reasonCode, now, outcome.encryptedContext));
      result.conflicted += 1; return;
    }
    await this.store.updateEncryptedMutation(transition(syncing, "REJECTED", now, { statusCode: outcome.reasonCode }));
    result.rejected += 1;
  }
}
