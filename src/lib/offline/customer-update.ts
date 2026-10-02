import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type CustomerUpdatePayload = {
  customerId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  expectedVersion: string;
};
export type PendingCustomerUpdate = CustomerUpdatePayload & { operationId: string; state: "PENDING" | "SYNCING" };
export type CustomerUpdateReview = { customerId: string; operationId: string; state: "PENDING" | "SYNCING" | "CONFLICT" };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function optionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid customer payload.");
  return value.trim() || null;
}
function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID.`);
  return value;
}
function version(value: unknown) {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) throw new Error("expectedVersion must be a server timestamp.");
  return value;
}

export function parseCustomerUpdatePayload(value: JsonValue): CustomerUpdatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid customer payload.");
  const payload = value as Record<string, unknown>;
  return {
    customerId: uuid(payload.customerId, "customerId"),
    fullName: requiredText(payload.fullName, "Customer name"),
    phone: optionalText(payload.phone),
    email: optionalText(payload.email),
    expectedVersion: version(payload.expectedVersion),
  };
}

/** Uses the exact token returned by the authoritative encrypted reference snapshot. */
export function createCustomerUpdatePayload(fields: CustomerUpdatePayload): CustomerUpdatePayload {
  return parseCustomerUpdatePayload(fields);
}

/** No dependent update workflow exists for an unsynchronized create or another open edit. */
export function assertCustomerUpdateEligible(customerId: string, pendingCreateCustomerIds: readonly string[], openUpdateCustomerIds: readonly string[]) {
  if (pendingCreateCustomerIds.includes(customerId)) throw new Error("A customer pending creation cannot be edited until the server confirms it.");
  if (openUpdateCustomerIds.includes(customerId)) throw new Error("This customer already has an offline update that needs synchronization or review.");
}

export async function readPendingCustomerUpdates(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingCustomerUpdate[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter(
    (record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } =>
      record.mutationType === "CUSTOMER_UPDATE" && (record.state === "PENDING" || record.state === "SYNCING"),
  );
  return Promise.all(pending.map(async (record) => ({ ...parseCustomerUpdatePayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}

/** This exposes status-only review markers; customer proposals remain encrypted until decrypted for a pending projection. */
export async function readCustomerUpdateReviews(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<CustomerUpdateReview[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const reviews = records.filter((record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" | "CONFLICT" } =>
    record.mutationType === "CUSTOMER_UPDATE" && (record.state === "PENDING" || record.state === "SYNCING" || record.state === "CONFLICT"),
  );
  return Promise.all(reviews.map(async (record) => {
    const payload = parseCustomerUpdatePayload(await decryptEncryptedMutationPayload(identity, record));
    return { customerId: payload.customerId, operationId: record.operationId, state: record.state };
  }));
}

function statusCode(response: Response) {
  if (response.status === 409) return "CUSTOMER_UPDATE_CONFLICT";
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "CUSTOMER_UPDATE_REJECTED";
  return "CUSTOMER_UPDATE_TRANSIENT";
}

/** Calls only the narrow same-origin replay boundary and stores generic codes, never database messages. */
export async function submitCustomerUpdate(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "CUSTOMER_UPDATE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: CustomerUpdatePayload;
  try { payload = parseCustomerUpdatePayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "CUSTOMER_UPDATE_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/customer-update", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, ...payload }),
    });
    if (response.ok) return { kind: "APPLIED" };
    if (response.status === 409) return { kind: "CONFLICT", reasonCode: statusCode(response) };
    if (response.status >= 400 && response.status < 500) return { kind: "REJECTED", reasonCode: statusCode(response) };
    return { kind: "TRANSIENT", statusCode: statusCode(response) };
  } catch {
    return { kind: "TRANSIENT", statusCode: "CUSTOMER_UPDATE_TRANSIENT" };
  }
}

export const customerUpdateExecutor: MutationExecutor = (operation) => submitCustomerUpdate(operation);
