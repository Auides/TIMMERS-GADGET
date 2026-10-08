import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export const inventoryAdjustmentRequestKinds = ["NON_SERIALIZED", "SERIALIZED"] as const;
export type InventoryAdjustmentRequestKind = (typeof inventoryAdjustmentRequestKinds)[number];
export const inventoryAdjustmentConditions = ["NEW", "USED", "REFURBISHED"] as const;
export type InventoryAdjustmentCondition = (typeof inventoryAdjustmentConditions)[number];
export type InventoryAdjustmentRequestPayload = {
  kind: InventoryAdjustmentRequestKind;
  productId: string;
  variantId: string | null;
  condition: InventoryAdjustmentCondition | null;
  unitId: string | null;
  requestedQuantity: number;
  reason: string;
};
export type PendingInventoryAdjustmentRequest = InventoryAdjustmentRequestPayload & { operationId: string; state: "PENDING" | "SYNCING" };
export type InventoryAdjustmentRequestReview = { operationId: string; state: "PENDING" | "SYNCING" | "CONFLICT" };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const payloadKeys = new Set(["kind", "productId", "variantId", "condition", "unitId", "requestedQuantity", "reason"]);
function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`);
  return value;
}
function nullableUuid(value: unknown, name: string) { return value === null ? null : uuid(value, name); }
function rejectUnknownFields(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => !payloadKeys.has(key))) throw new Error("Adjustment request contains unsupported or authoritative fields.");
}

/** Client validation restricts intent only; authoritative product, variant, unit, and status checks run again at replay. */
export function parseInventoryAdjustmentRequestPayload(value: JsonValue): InventoryAdjustmentRequestPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid adjustment request payload.");
  const input = value as Record<string, unknown>;
  rejectUnknownFields(input);
  if (typeof input.kind !== "string" || !(inventoryAdjustmentRequestKinds as readonly string[]).includes(input.kind)) throw new Error("Unsupported adjustment request kind.");
  if (typeof input.requestedQuantity !== "number" || !Number.isSafeInteger(input.requestedQuantity) || input.requestedQuantity === 0) throw new Error("Requested quantity must be a non-zero integer.");
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new Error("A reason is required.");
  const kind = input.kind as InventoryAdjustmentRequestKind;
  const payload = {
    kind,
    productId: uuid(input.productId, "productId"),
    variantId: nullableUuid(input.variantId, "variantId"),
    condition: input.condition === null ? null : typeof input.condition === "string" && (inventoryAdjustmentConditions as readonly string[]).includes(input.condition) ? input.condition as InventoryAdjustmentCondition : (() => { throw new Error("Unsupported inventory condition."); })(),
    unitId: nullableUuid(input.unitId, "unitId"),
    requestedQuantity: input.requestedQuantity,
    reason: input.reason.trim(),
  };
  if (kind === "NON_SERIALIZED" && (payload.unitId !== null || payload.condition === null)) throw new Error("Non-serialized requests require a condition and no unit.");
  if (kind === "SERIALIZED" && (payload.unitId === null || payload.condition !== null || payload.requestedQuantity !== -1)) throw new Error("Serialized requests require one unit, no condition, and quantity -1.");
  return payload;
}
export function createInventoryAdjustmentRequestPayload(fields: InventoryAdjustmentRequestPayload) { return parseInventoryAdjustmentRequestPayload(fields); }
export function assertInventoryAdjustmentRequestEligible(role: string) {
  if (role !== "STAFF" && role !== "MANAGER") throw new Error("Only Staff or Managers can create offline inventory adjustment requests.");
}

export async function readPendingInventoryAdjustmentRequests(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingInventoryAdjustmentRequest[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } => record.mutationType === "INVENTORY_ADJUSTMENT_REQUEST_CREATE" && (record.state === "PENDING" || record.state === "SYNCING"));
  return Promise.all(pending.map(async (record) => ({ ...parseInventoryAdjustmentRequestPayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}
export async function readInventoryAdjustmentRequestReviews(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<InventoryAdjustmentRequestReview[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  return records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" | "CONFLICT" } => record.mutationType === "INVENTORY_ADJUSTMENT_REQUEST_CREATE" && (record.state === "PENDING" || record.state === "SYNCING" || record.state === "CONFLICT")).map((record) => ({ operationId: record.operationId, state: record.state }));
}
function statusCode(response: Response) {
  if (response.status === 409) return "INVENTORY_ADJUSTMENT_REQUEST_CONFLICT";
  if (response.status >= 400 && response.status < 500) return "INVENTORY_ADJUSTMENT_REQUEST_REJECTED";
  return "INVENTORY_ADJUSTMENT_REQUEST_TRANSIENT";
}
/** V4 encrypted transport only. A request is pending approval and never changes cached stock. */
export async function submitInventoryAdjustmentRequest(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "INVENTORY_ADJUSTMENT_REQUEST_CREATE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: InventoryAdjustmentRequestPayload;
  try { payload = parseInventoryAdjustmentRequestPayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "INVENTORY_ADJUSTMENT_REQUEST_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/inventory-adjustment-request", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, ...payload }) });
    if (response.ok) return { kind: "APPLIED" };
    if (response.status === 409) return { kind: "CONFLICT", reasonCode: statusCode(response) };
    if (response.status >= 400 && response.status < 500) return { kind: "REJECTED", reasonCode: statusCode(response) };
    return { kind: "TRANSIENT", statusCode: statusCode(response) };
  } catch { return { kind: "TRANSIENT", statusCode: "INVENTORY_ADJUSTMENT_REQUEST_TRANSIENT" }; }
}
export const inventoryAdjustmentRequestExecutor: MutationExecutor = (operation) => submitInventoryAdjustmentRequest(operation);
