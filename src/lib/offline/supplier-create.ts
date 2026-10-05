import type { MutationExecutionOutcome, MutationExecutor, MutationVaultIdentity } from "./mutation-transport.ts";
import { decryptEncryptedMutationPayload } from "./mutation-transport.ts";
import type { EncryptedMutationEnvelope, EncryptedMutationStore, JsonValue } from "./types.ts";

export type SupplierCreatePayload = { supplierId: string; businessName: string; contactName: string | null; phone: string | null; email: string | null };
export type PendingSupplierCreate = SupplierCreatePayload & { operationId: string; state: "PENDING" | "SYNCING" };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function optionalText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid supplier payload.");
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

export function parseSupplierCreatePayload(value: JsonValue): SupplierCreatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supplier payload.");
  const payload = value as Record<string, unknown>;
  return {
    supplierId: uuid(payload.supplierId, "supplierId"),
    businessName: requiredText(payload.businessName, "Supplier business name"),
    contactName: optionalText(payload.contactName),
    phone: optionalText(payload.phone),
    email: optionalText(payload.email),
  };
}

/** The supplier UUID is generated once before encryption and survives every retry/replay. */
export function createSupplierCreatePayload(fields: { businessName: string; contactName?: string | null; phone?: string | null; email?: string | null }, supplierId = createUuid()): SupplierCreatePayload {
  return parseSupplierCreatePayload({ supplierId, businessName: fields.businessName, contactName: fields.contactName ?? null, phone: fields.phone ?? null, email: fields.email ?? null });
}

export function assertSupplierCreateEligible(role: string) {
  if (role !== "MANAGER") throw new Error("Only Managers can add suppliers while offline.");
}

/** Pending supplier details are projected only by decrypting this user's active V4 queue in memory. */
export async function readPendingSupplierCreates(store: EncryptedMutationStore, identity: MutationVaultIdentity): Promise<PendingSupplierCreate[]> {
  const records = await store.listEncryptedMutations(identity.userId, identity.deviceId);
  const pending = records.filter(
    (record): record is EncryptedMutationEnvelope & { state: "PENDING" | "SYNCING" } =>
      record.mutationType === "SUPPLIER_CREATE" && (record.state === "PENDING" || record.state === "SYNCING"),
  );
  return Promise.all(pending.map(async (record) => ({ ...parseSupplierCreatePayload(await decryptEncryptedMutationPayload(identity, record)), operationId: record.operationId, state: record.state })));
}

function statusCode(response: Response) {
  if (response.status === 409) return "SUPPLIER_CREATE_CONFLICT";
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) return "SUPPLIER_CREATE_REJECTED";
  return "SUPPLIER_CREATE_TRANSIENT";
}

/** Calls only the narrow Manager replay boundary and never persists raw database detail. */
export async function submitSupplierCreate(operation: { operationId: string; idempotencyKey: string; mutationType: string; payload: JsonValue }, fetcher: FetchLike = fetch): Promise<MutationExecutionOutcome> {
  if (operation.mutationType !== "SUPPLIER_CREATE") return { kind: "REJECTED", reasonCode: "MUTATION_TYPE_NOT_IMPLEMENTED" };
  let payload: SupplierCreatePayload;
  try { payload = parseSupplierCreatePayload(operation.payload); } catch { return { kind: "REJECTED", reasonCode: "SUPPLIER_CREATE_REJECTED" }; }
  try {
    const response = await fetcher("/api/offline/mutations/supplier-create", {
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
    return { kind: "TRANSIENT", statusCode: "SUPPLIER_CREATE_TRANSIENT" };
  }
}

export const supplierCreateExecutor: MutationExecutor = (operation) => submitSupplierCreate(operation);
