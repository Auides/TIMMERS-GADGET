import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type PurchaseReceiveLine = {
  productId: string;
  variantId: string | null;
  condition: string;
  quantity: number;
  unitCostDecimal: string;
  notes: string | null;
};
export type PurchaseReceivePayload = {
  supplierId: string;
  receivedOn: string;
  supplierReference: string | null;
  notes: string | null;
  lines: PurchaseReceiveLine[];
  /** This offline operation has no payment path. It is always the exact empty array. */
  initialPayments: [];
};
export type PendingPurchaseReceive = PurchaseReceivePayload & { operationId: string; state: "PENDING" | "SYNCING" };
export type PurchaseReceiveReview = { operationId: string; state: "PENDING" | "SYNCING" | "CONFLICT" };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function optionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid purchase receipt payload.");
  return value.trim() || null;
}
function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`);
  return value;
}
function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
function receivedOn(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Received date must use YYYY-MM-DD.");
  return value;
}

/** Normalizes currency without converting it to a JavaScript number. */
export function canonicalDecimal(value: unknown) {
  if (typeof value !== "string") throw new Error("Unit acquisition cost must be a decimal string.");
  const trimmed = value.trim();
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error("Unit acquisition cost must be a non-negative canonical decimal with at most two decimal places.");
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}
function line(value: unknown): PurchaseReceiveLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every purchase receipt line must be an object.");
  const input = value as Record<string, unknown>;
  if ("serializedUnits" in input || "serialized_units" in input) throw new Error("Offline purchase receiving does not support serialized units.");
  if (typeof input.quantity !== "number" || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error("Purchase receipt quantity must be a positive integer.");
  return {
    productId: uuid(input.productId, "productId"),
    variantId: input.variantId === null || input.variantId === undefined || input.variantId === "" ? null : uuid(input.variantId, "variantId"),
    condition: requiredText(input.condition, "Condition").toUpperCase(),
    quantity: input.quantity,
    unitCostDecimal: canonicalDecimal(input.unitCostDecimal),
    notes: optionalText(input.notes),
  };
}

export function parsePurchaseReceivePayload(value: JsonValue): PurchaseReceivePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid purchase receipt payload.");
  const input = value as Record<string, unknown>;
  if ("serializedUnits" in input || "serialized_units" in input) throw new Error("Offline purchase receiving does not support serialized units.");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("At least one non-serialized purchase line is required.");
  if (!Array.isArray(input.initialPayments) || input.initialPayments.length !== 0) throw new Error("Offline purchase receiving does not support payments.");
  return {
    supplierId: uuid(input.supplierId, "supplierId"),
    receivedOn: receivedOn(input.receivedOn),
    supplierReference: optionalText(input.supplierReference),
    notes: optionalText(input.notes),
    lines: input.lines.map(line),
    initialPayments: [],
  };
}

export function createPurchaseReceivePayload(fields: PurchaseReceivePayload) { return parsePurchaseReceivePayload(fields); }
export function assertPurchaseReceiveEligible(role: string) {
  if (role !== "MANAGER") throw new Error("Only Managers can receive non-serialized purchases while offline.");
}

/** Pending receipt details are decrypted only into the active Manager vault's memory. */
export async function readPendingPurchaseReceives(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingPurchaseReceive[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } => record.mutationType === "PURCHASE_RECEIVE" && (record.state === "PENDING" || record.state === "SYNCING"));
  return Promise.all(pending.map(async (record) => ({ ...parsePurchaseReceivePayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}

export async function readPurchaseReceiveReviews(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PurchaseReceiveReview[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  return records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" | "CONFLICT" } => record.mutationType === "PURCHASE_RECEIVE" && (record.state === "PENDING" || record.state === "SYNCING" || record.state === "CONFLICT")).map((record) => ({ operationId: record.operationId, state: record.state }));
}

function statusCode(response: Response) {
  if (response.status === 409) return "PURCHASE_RECEIVE_CONFLICT";
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "PURCHASE_RECEIVE_REJECTED";
  return "PURCHASE_RECEIVE_TRANSIENT";
}

/** Replays only the narrow Manager boundary; neither cost nor server detail is persisted outside ciphertext. */
export async function submitPurchaseReceive(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "PURCHASE_RECEIVE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: PurchaseReceivePayload;
  try { payload = parsePurchaseReceivePayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "PURCHASE_RECEIVE_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/purchase-receive", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, ...payload }),
    });
    if (response.ok) return { kind: "APPLIED" };
    if (response.status === 409) return { kind: "CONFLICT", reasonCode: statusCode(response) };
    if (response.status >= 400 && response.status < 500) return { kind: "REJECTED", reasonCode: statusCode(response) };
    return { kind: "TRANSIENT", statusCode: statusCode(response) };
  } catch { return { kind: "TRANSIENT", statusCode: "PURCHASE_RECEIVE_TRANSIENT" }; }
}

export const purchaseReceiveExecutor: MutationExecutor = (operation) => submitPurchaseReceive(operation);
