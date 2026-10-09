import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type OfflineSaleQuote = { cataloguePriceId: string; priceRevision: number; quotedSellingPrice: string };
export type OfflineSaleCheckoutLine = { productId: string; variantId: string | null; condition: "NEW" | "USED" | "REFURBISHED"; quantity: number; quote: OfflineSaleQuote };
export type OfflineSaleCheckoutPayload = {
  schemaVersion: 1;
  businessDate: string;
  customerId: string | null;
  notes: string | null;
  lines: OfflineSaleCheckoutLine[];
  payment: { method: "CASH"; amount: string };
  /** Encrypted operation IDs whose successful replay is required first. */
  dependencies: string[];
};
export type PendingSaleCheckout = OfflineSaleCheckoutPayload & { operationId: string; state: "PENDING" | "SYNCING" };
export type SaleCheckoutReview = { operationId: string; state: "PENDING" | "SYNCING" | "CONFLICT" | "REJECTED"; reasonCode: string | null };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimalPattern = /^(0|[1-9]\d{0,11})\.(\d{2})$/;
const payloadKeys = new Set(["schemaVersion", "businessDate", "customerId", "notes", "lines", "payment", "dependencies"]);
const lineKeys = new Set(["productId", "variantId", "condition", "quantity", "quote"]);
const quoteKeys = new Set(["cataloguePriceId", "priceRevision", "quotedSellingPrice"]);
const paymentKeys = new Set(["method", "amount"]);

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, subject: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${subject} contains unsupported or authoritative fields.`);
}
function uuid(value: unknown, field: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(`${field} must be a UUID.`);
  return value;
}
function optionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid offline sale text.");
  return value.trim() || null;
}
function canonicalMoney(value: unknown, field: string) {
  if (typeof value !== "string" || !decimalPattern.test(value.trim())) throw new Error(`${field} must be a canonical NGN decimal.`);
  return value.trim();
}
function cents(value: string) { return Number(value.replace(".", "")); }
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Business date must use YYYY-MM-DD.");
  return value;
}
function quote(value: unknown): OfflineSaleQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every offline sale line requires a quote.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, quoteKeys, "Quote");
  if (typeof input.priceRevision !== "number" || !Number.isSafeInteger(input.priceRevision) || input.priceRevision < 1) throw new Error("Quote revision is invalid.");
  return { cataloguePriceId: uuid(input.cataloguePriceId, "cataloguePriceId"), priceRevision: input.priceRevision, quotedSellingPrice: canonicalMoney(input.quotedSellingPrice, "Quoted selling price") };
}
function line(value: unknown): OfflineSaleCheckoutLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Every offline sale line must be an object.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, lineKeys, "Offline sale line");
  const condition = typeof input.condition === "string" ? input.condition.trim().toUpperCase() : "";
  if (!( ["NEW", "USED", "REFURBISHED"] as const).includes(condition as "NEW" | "USED" | "REFURBISHED")) throw new Error("Inventory condition is invalid.");
  if (typeof input.quantity !== "number" || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error("Sale quantity must be a positive integer.");
  return {
    productId: uuid(input.productId, "productId"),
    variantId: input.variantId === null || input.variantId === undefined ? null : uuid(input.variantId, "variantId"),
    condition: condition as OfflineSaleCheckoutLine["condition"],
    quantity: input.quantity,
    quote: quote(input.quote),
  };
}
function payment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Offline sale payment is invalid.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, paymentKeys, "Offline sale payment");
  if (input.method !== "CASH") throw new Error("Only one CASH payment is supported offline.");
  const amount = canonicalMoney(input.amount, "Cash payment");
  if (amount === "0.00") throw new Error("Cash payment must be greater than zero.");
  return { method: "CASH" as const, amount };
}

/** Strictly local validation: server validation remains the authoritative boundary. */
export function parseOfflineSaleCheckoutPayload(value: JsonValue): OfflineSaleCheckoutPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid offline sale payload.");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, payloadKeys, "Offline sale");
  if (input.schemaVersion !== 1) throw new Error("Unsupported offline sale schema.");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("At least one sale line is required.");
  if (!Array.isArray(input.dependencies)) throw new Error("Sale dependencies are required.");
  const lines = input.lines.map(line).sort((left, right) => `${left.productId}:${left.variantId ?? ""}:${left.condition}`.localeCompare(`${right.productId}:${right.variantId ?? ""}:${right.condition}`));
  if (new Set(lines.map((item) => `${item.productId}:${item.variantId ?? ""}:${item.condition}`)).size !== lines.length) throw new Error("Duplicate offline sale lines are not supported.");
  const dependencies = input.dependencies.map((dependency) => uuid(dependency, "dependency"));
  if (new Set(dependencies).size !== dependencies.length) throw new Error("Duplicate sale dependencies are not supported.");
  const parsedPayment = payment(input.payment);
  const total = lines.reduce((sum, item) => sum + cents(item.quote.quotedSellingPrice) * item.quantity, 0);
  if (cents(parsedPayment.amount) !== total) throw new Error("Cash payment must exactly equal the quoted sale total.");
  return {
    schemaVersion: 1,
    businessDate: date(input.businessDate),
    customerId: input.customerId === null || input.customerId === undefined ? null : uuid(input.customerId, "customerId"),
    notes: optionalText(input.notes),
    lines,
    payment: parsedPayment,
    dependencies,
  };
}

export function createOfflineSaleCheckoutPayload(fields: OfflineSaleCheckoutPayload) { return parseOfflineSaleCheckoutPayload(fields); }
export function assertOfflineSaleCheckoutEligible(role: string) {
  if (role !== "STAFF" && role !== "MANAGER") throw new Error("Only Staff and Managers can create offline cash sales.");
}

export async function readPendingSaleCheckouts(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingSaleCheckout[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } => record.mutationType === "SALE_CHECKOUT" && (record.state === "PENDING" || record.state === "SYNCING"));
  return Promise.all(pending.map(async (record) => ({ ...parseOfflineSaleCheckoutPayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}
export async function readSaleCheckoutReviews(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<SaleCheckoutReview[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  return records.filter((record) => record.mutationType === "SALE_CHECKOUT" && ["PENDING", "SYNCING", "CONFLICT", "REJECTED"].includes(record.state)).map((record) => ({ operationId: record.operationId, state: record.state as SaleCheckoutReview["state"], reasonCode: record.statusCode }));
}

function statusCode(response: Response) {
  if (response.status === 409) return "SALE_CHECKOUT_CONFLICT";
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "SALE_CHECKOUT_REJECTED";
  return "SALE_CHECKOUT_TRANSIENT";
}

/** Calls the narrow same-origin replay endpoint; server SQL remains sale authority. */
export async function submitOfflineSaleCheckout(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "SALE_CHECKOUT") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: OfflineSaleCheckoutPayload;
  try { payload = parseOfflineSaleCheckoutPayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "SALE_CHECKOUT_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/sale-checkout", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, ...payload }),
    });
    if (response.ok) return { kind: "APPLIED" };
    if (response.status === 409) return { kind: "CONFLICT", reasonCode: statusCode(response) };
    if (response.status >= 400 && response.status < 500) return { kind: "REJECTED", reasonCode: statusCode(response) };
    return { kind: "TRANSIENT", statusCode: statusCode(response) };
  } catch { return { kind: "TRANSIENT", statusCode: "SALE_CHECKOUT_TRANSIENT" }; }
}

export const offlineSaleCheckoutExecutor: MutationExecutor = (operation) => submitOfflineSaleCheckout(operation);
