import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type CustomerCreatePayload = { customerId: string; fullName: string; phone: string | null; email: string | null };
export type PendingCustomerCreate = CustomerCreatePayload & { operationId: string; state: "PENDING" | "SYNCING" };
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
function createUuid() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure UUID generation is unavailable in this browser.");
  return id;
}

export function parseCustomerCreatePayload(value: JsonValue): CustomerCreatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid customer payload.");
  const payload = value as Record<string, unknown>;
  return { customerId: uuid(payload.customerId, "customerId"), fullName: requiredText(payload.fullName, "Customer name"), phone: optionalText(payload.phone), email: optionalText(payload.email) };
}

/** The customer UUID is generated once before encryption and survives every retry/replay. */
export function createCustomerCreatePayload(fields: { fullName: string; phone?: string | null; email?: string | null }, customerId = createUuid()): CustomerCreatePayload {
  return parseCustomerCreatePayload({ customerId, fullName: fields.fullName, phone: fields.phone ?? null, email: fields.email ?? null });
}

export async function readPendingCustomerCreates(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingCustomerCreate[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
 const pending = records.filter(
  (record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } =>
    record.mutationType === "CUSTOMER_CREATE" &&
    (record.state === "PENDING" || record.state === "SYNCING"),
);
  return Promise.all(pending.map(async (record) => ({ ...parseCustomerCreatePayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}

function statusCode(response: Response) {
  if (response.status === 409) return "CUSTOMER_CREATE_CONFLICT";
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "CUSTOMER_CREATE_REJECTED";
  return "CUSTOMER_CREATE_TRANSIENT";
}

/** Calls only the narrow same-origin replay boundary; it never exposes raw database errors to IndexedDB. */
export async function submitCustomerCreate(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "CUSTOMER_CREATE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: CustomerCreatePayload;
  try { payload = parseCustomerCreatePayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "CUSTOMER_CREATE_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/customer-create", {
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
    return { kind: "TRANSIENT", statusCode: "CUSTOMER_CREATE_TRANSIENT" };
  }
}

export const customerCreateExecutor: MutationExecutor = (operation) => submitCustomerCreate(operation);

/** Ensures only envelope ciphertext is decrypted, and only while its vault is unlocked. */
export async function decryptCustomerCreateForReplay(identity: MutationVaultIdentity, record: EncryptedMutationEnvelope) {
  return parseCustomerCreatePayload(await decryptEncryptedMutationPayload(identity, record));
}
