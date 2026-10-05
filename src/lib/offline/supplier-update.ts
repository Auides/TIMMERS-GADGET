import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type SupplierUpdatePayload = { supplierId: string; businessName: string; contactName: string | null; phone: string | null; email: string | null; expectedVersion: string };
export type PendingSupplierUpdate = SupplierUpdatePayload & { operationId: string; state: "PENDING" | "SYNCING" };
export type SupplierUpdateReview = { supplierId: string; operationId: string; state: "PENDING" | "SYNCING" | "CONFLICT" };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function optionalText(value: unknown) { if (value === null || value === undefined) return null; if (typeof value !== "string") throw new Error("Invalid supplier payload."); return value.trim() || null; }
function requiredText(value: unknown, name: string) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); }
function uuid(value: unknown, name: string) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`); return value; }
function version(value: unknown) { if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) throw new Error("expectedVersion must be a server timestamp."); return value; }

export function parseSupplierUpdatePayload(value: JsonValue): SupplierUpdatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supplier payload.");
  const payload = value as Record<string, unknown>;
  return { supplierId: uuid(payload.supplierId, "supplierId"), businessName: requiredText(payload.businessName, "Supplier business name"), contactName: optionalText(payload.contactName), phone: optionalText(payload.phone), email: optionalText(payload.email), expectedVersion: version(payload.expectedVersion) };
}

/** Uses the exact server-managed updated_at token supplied in the encrypted Manager snapshot. */
export function createSupplierUpdatePayload(fields: SupplierUpdatePayload): SupplierUpdatePayload { return parseSupplierUpdatePayload(fields); }

/** A locally-created supplier and a supplier with any open edit cannot receive another offline edit. */
export function assertSupplierUpdateEligible(supplierId: string, pendingCreateSupplierIds: readonly string[], openUpdateSupplierIds: readonly string[]) {
  if (pendingCreateSupplierIds.includes(supplierId)) throw new Error("A supplier pending creation cannot be edited until the server confirms it.");
  if (openUpdateSupplierIds.includes(supplierId)) throw new Error("This supplier already has an offline update that needs synchronization or review.");
}

export async function readPendingSupplierUpdates(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingSupplierUpdate[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } => record.mutationType === "SUPPLIER_UPDATE" && (record.state === "PENDING" || record.state === "SYNCING"));
  return Promise.all(pending.map(async (record) => ({ ...parseSupplierUpdatePayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}

/** Status-only markers prevent concurrent edits while keeping proposals encrypted except for the pending projection. */
export async function readSupplierUpdateReviews(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<SupplierUpdateReview[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const reviews = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" | "CONFLICT" } => record.mutationType === "SUPPLIER_UPDATE" && (record.state === "PENDING" || record.state === "SYNCING" || record.state === "CONFLICT"));
  return Promise.all(reviews.map(async (record) => { const payload = parseSupplierUpdatePayload(await decryptEncryptedMutationPayload(identity, record)); return { supplierId: payload.supplierId, operationId: record.operationId, state: record.state }; }));
}

function statusCode(response: Response) { if (response.status === 409) return "SUPPLIER_UPDATE_CONFLICT"; if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "SUPPLIER_UPDATE_REJECTED"; return "SUPPLIER_UPDATE_TRANSIENT"; }

/** Replays only the narrow same-origin Manager RPC boundary and never retains database detail. */
export async function submitSupplierUpdate(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "SUPPLIER_UPDATE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: SupplierUpdatePayload;
  try { payload = parseSupplierUpdatePayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "SUPPLIER_UPDATE_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/supplier-update", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, ...payload }) });
    if (response.ok) return { kind: "APPLIED" };
    if (response.status === 409) return { kind: "CONFLICT", reasonCode: statusCode(response) };
    if (response.status >= 400 && response.status < 500) return { kind: "REJECTED", reasonCode: statusCode(response) };
    return { kind: "TRANSIENT", statusCode: statusCode(response) };
  } catch { return { kind: "TRANSIENT", statusCode: "SUPPLIER_UPDATE_TRANSIENT" }; }
}

export const supplierUpdateExecutor: MutationExecutor = (operation) => submitSupplierUpdate(operation);
