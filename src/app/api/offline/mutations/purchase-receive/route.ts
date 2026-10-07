import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const optionalText = z.string().trim().transform((value) => value || null).nullable().optional().transform((value) => value ?? null);
const canonicalMoney = z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/);
const initialPaymentSchema = z.object({
  amount: canonicalMoney.refine((value) => value !== "0.00"),
  method: z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]),
  paidOn: z.string().date(),
  reference: optionalText,
  notes: optionalText,
}).strict();
const identifierSchema = z.object({ type: z.enum(["IMEI_1", "IMEI_2", "SERIAL"]), value: z.string().trim().min(1) }).strict().superRefine((identifier, context) => {
  if ((identifier.type === "IMEI_1" || identifier.type === "IMEI_2") && !/^\d{14,16}$/.test(identifier.value)) context.addIssue({ code: "custom", message: "Invalid identifier." });
});
const serializedUnitSchema = z.object({
  acquisitionCostDecimal: canonicalMoney,
  warrantyStart: z.string().date().nullable(),
  warrantyExpiry: z.string().date().nullable(),
  identifiers: z.array(identifierSchema).min(1),
}).strict().superRefine((unit, context) => {
  if (unit.warrantyStart && unit.warrantyExpiry && unit.warrantyExpiry < unit.warrantyStart) context.addIssue({ code: "custom", message: "Invalid warranty." });
});
const nonserializedLineSchema = z.object({ productId: z.string().uuid(), variantId: z.string().uuid().nullable(), condition: z.string().trim().min(1), quantity: z.number().int().positive(), unitCostDecimal: canonicalMoney, notes: optionalText, serializedUnits: z.array(z.never()).length(0) }).strict();
const serializedLineSchema = z.object({ productId: z.string().uuid(), variantId: z.string().uuid().nullable(), condition: z.string().trim().min(1), quantity: z.number().int().positive(), unitCostDecimal: z.null(), notes: optionalText, serializedUnits: z.array(serializedUnitSchema).min(1) }).strict().superRefine((line, context) => {
  if (line.quantity !== line.serializedUnits.length) context.addIssue({ code: "custom", message: "Invalid serialized quantity." });
});
const requestSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  supplierId: z.string().uuid(),
  receivedOn: z.string().date(),
  supplierReference: optionalText,
  notes: optionalText,
  lines: z.array(z.union([nonserializedLineSchema, serializedLineSchema])).min(1),
  initialPayments: z.array(initialPaymentSchema),
}).strict();

function response(code: string, status: number) { return NextResponse.json({ code }, { status, headers: noStore }); }
function rpcFailure(error: { code?: string } | null) {
  if (error?.code === "42501") return response("AUTHORIZATION_REJECTED", 403);
  if (error?.code === "22023") return response("PURCHASE_RECEIVE_REJECTED", 422);
  if (error?.code === "23505" || error?.code === "P0001") return response("PURCHASE_RECEIVE_CONFLICT", 409);
  return response("PURCHASE_RECEIVE_UNAVAILABLE", 503);
}
function purchaseResult(data: unknown) {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" && "purchase_id" in value && typeof value.purchase_id === "string" ? value.purchase_id : null;
}

/** Authenticated Manager-only replay boundary; purchase_receive remains the financial authority. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("PURCHASE_RECEIVE_REJECTED", 400);
  const { profile } = await getAuthenticatedProfile();
  if (!profile || profile.role !== "MANAGER") return response("AUTHORIZATION_REJECTED", 403);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return response("PURCHASE_RECEIVE_UNAVAILABLE", 503);
  const { data, error } = await supabase.rpc("offline_purchase_receive", {
    // The established purchase reservation is keyed by the stable V4 idempotency key.
    p_request_id: parsed.data.idempotencyKey,
    p_supplier_id: parsed.data.supplierId,
    p_received_on: parsed.data.receivedOn,
    p_supplier_reference: parsed.data.supplierReference,
    p_notes: parsed.data.notes,
    p_lines: parsed.data.lines.map((line) => ({
      product_id: line.productId,
      variant_id: line.variantId,
      condition: line.condition,
      quantity: line.quantity,
      unit_cost: line.unitCostDecimal,
      notes: line.notes,
      serialized_units: line.serializedUnits.map((unit) => ({
        acquisition_cost: unit.acquisitionCostDecimal,
        condition: line.condition,
        warranty_start: unit.warrantyStart,
        warranty_expiry: unit.warrantyExpiry,
        identifiers: unit.identifiers.map((identifier) => ({ type: identifier.type, value: identifier.value })),
      })),
    })),
    p_initial_payments: parsed.data.initialPayments.map((payment) => ({
      amount: payment.amount,
      method: payment.method,
      paid_on: payment.paidOn,
      reference: payment.reference,
      notes: payment.notes,
    })),
  });
  if (error) return rpcFailure(error);
  const purchaseId = purchaseResult(data);
  if (!purchaseId) return response("PURCHASE_RECEIVE_UNAVAILABLE", 503);
  return NextResponse.json({ purchaseId }, { headers: noStore });
}
