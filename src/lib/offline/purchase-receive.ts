import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

/** These values deliberately mirror the established database enum and add no new identifier kind. */
export const purchaseReceiveIdentifierTypes = ["IMEI_1", "IMEI_2", "SERIAL"] as const;
export type PurchaseReceiveIdentifierType = (typeof purchaseReceiveIdentifierTypes)[number];
export type SerializedPurchaseIdentifier = { type: PurchaseReceiveIdentifierType; value: string };
export type SerializedPurchaseUnit = {
  acquisitionCostDecimal: string;
  warrantyStart: string | null;
  warrantyExpiry: string | null;
  identifiers: SerializedPurchaseIdentifier[];
};
export type NonserializedPurchaseReceiveLine = {
  productId: string;
  variantId: string | null;
  condition: string;
  quantity: number;
  unitCostDecimal: string;
  notes: string | null;
  serializedUnits: [];
};
export type SerializedPurchaseReceiveLine = Omit<NonserializedPurchaseReceiveLine, "unitCostDecimal" | "serializedUnits"> & {
  unitCostDecimal: null;
  serializedUnits: [SerializedPurchaseUnit, ...SerializedPurchaseUnit[]];
};
export type PurchaseReceiveLine = NonserializedPurchaseReceiveLine | SerializedPurchaseReceiveLine;
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

const lineKeys = new Set(["productId", "variantId", "condition", "quantity", "unitCostDecimal", "notes", "serializedUnits"]);
const serializedUnitKeys = new Set(["acquisitionCostDecimal", "warrantyStart", "warrantyExpiry", "identifiers"]);
const identifierKeys = new Set(["type", "value"]);

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
function optionalDate(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
  return value;
}
function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, subject: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${subject} contains unsupported or authoritative fields.`);
}

/** Normalizes currency without converting it to a JavaScript number. */
export function canonicalDecimal(value: unknown) {
  if (typeof value !== "string") throw new Error("Unit acquisition cost must be a decimal string.");
  const trimmed = value.trim();
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error("Unit acquisition cost must be a non-negative canonical decimal with at most two decimal places.");
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}
function identifier(value: unknown): SerializedPurchaseIdentifier {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every serialized identifier must be an object.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, identifierKeys, "Serialized identifier");
  const type = requiredText(input.type, "Identifier type").toUpperCase();
  if (!(purchaseReceiveIdentifierTypes as readonly string[]).includes(type)) throw new Error("Unsupported serialized identifier type.");
  const identifierValue = requiredText(input.value, "Identifier value");
  if ((type === "IMEI_1" || type === "IMEI_2") && !/^\d{14,16}$/.test(identifierValue)) throw new Error("IMEI identifiers must contain 14 to 16 digits.");
  return { type: type as PurchaseReceiveIdentifierType, value: identifierValue };
}
function serializedUnit(value: unknown): SerializedPurchaseUnit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every serialized purchase unit must be an object.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, serializedUnitKeys, "Serialized purchase unit");
  const warrantyStart = optionalDate(input.warrantyStart, "Warranty start");
  const warrantyExpiry = optionalDate(input.warrantyExpiry, "Warranty expiry");
  if (warrantyStart && warrantyExpiry && warrantyExpiry < warrantyStart) throw new Error("Warranty expiry cannot be earlier than warranty start.");
  if (!Array.isArray(input.identifiers) || input.identifiers.length === 0) throw new Error("Every serialized purchase unit requires an identifier.");
  return { acquisitionCostDecimal: canonicalDecimal(input.acquisitionCostDecimal), warrantyStart, warrantyExpiry, identifiers: input.identifiers.map(identifier) };
}
function line(value: unknown): PurchaseReceiveLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every purchase receipt line must be an object.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, lineKeys, "Purchase receipt line");
  if (typeof input.quantity !== "number" || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error("Purchase receipt quantity must be a positive integer.");
  const base = {
    productId: uuid(input.productId, "productId"),
    variantId: input.variantId === null || input.variantId === undefined || input.variantId === "" ? null : uuid(input.variantId, "variantId"),
    condition: requiredText(input.condition, "Condition").toUpperCase(),
    quantity: input.quantity,
    notes: optionalText(input.notes),
  };
  if (input.serializedUnits === undefined) return { ...base, unitCostDecimal: canonicalDecimal(input.unitCostDecimal), serializedUnits: [] };
  if (!Array.isArray(input.serializedUnits)) throw new Error("Serialized purchase units must be an array.");
  if (input.serializedUnits.length === 0) return { ...base, unitCostDecimal: canonicalDecimal(input.unitCostDecimal), serializedUnits: [] };
  if (input.unitCostDecimal !== null && input.unitCostDecimal !== undefined && input.unitCostDecimal !== "") throw new Error("Serialized purchase lines cannot provide a line unit cost.");
  const serializedUnits = input.serializedUnits.map(serializedUnit);
  if (serializedUnits.length !== base.quantity) throw new Error("Serialized purchase quantity must equal the supplied serialized-unit count.");
  return { ...base, unitCostDecimal: null, serializedUnits: serializedUnits as [SerializedPurchaseUnit, ...SerializedPurchaseUnit[]] };
}

export function parsePurchaseReceivePayload(value: JsonValue): PurchaseReceivePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid purchase receipt payload.");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["supplierId", "receivedOn", "supplierReference", "notes", "lines", "initialPayments"]);
  rejectUnknownKeys(input, allowed, "Purchase receipt");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("At least one purchase line is required.");
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
  if (role !== "MANAGER") throw new Error("Only Managers can receive purchases while offline.");
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
