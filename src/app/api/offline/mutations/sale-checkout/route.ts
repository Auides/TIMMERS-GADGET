import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const money = z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/);
const optionalText = z.string().trim().transform((value) => value || null).nullable().optional().transform((value) => value ?? null);
const quote = z.object({ cataloguePriceId: z.string().uuid(), priceRevision: z.number().int().positive(), quotedSellingPrice: money }).strict();
const line = z.object({ productId: z.string().uuid(), variantId: z.string().uuid().nullable(), condition: z.enum(["NEW", "USED", "REFURBISHED"]), quantity: z.number().int().positive(), serializedUnitIds: z.array(z.string().uuid()), quote }).strict().superRefine((value, context) => {
  if (value.serializedUnitIds.length !== 0 && value.serializedUnitIds.length !== value.quantity) context.addIssue({ code: z.ZodIssueCode.custom, message: "Serialized unit count must equal quantity." });
  if (new Set(value.serializedUnitIds).size !== value.serializedUnitIds.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate serialized unit." });
});
const requestSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  schemaVersion: z.literal(1),
  businessDate: z.string().date(),
  customerId: z.string().uuid().nullable(),
  notes: optionalText,
  lines: z.array(line).min(1),
  payment: z.object({ method: z.literal("CASH"), amount: money.refine((value) => value !== "0.00") }).strict(),
  dependencies: z.array(z.string().uuid()),
}).strict().superRefine((value, context) => {
  const unitIds = value.lines.flatMap((item) => item.serializedUnitIds);
  if (new Set(unitIds).size !== unitIds.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate serialized unit." });
});

function response(code: string, status: number) { return NextResponse.json({ code }, { status, headers: noStore }); }
function rpcFailure(error: { code?: string; message?: string } | null) {
  const message = error?.message?.toUpperCase() ?? "";
  if (error?.code === "42501") return response("AUTHORIZATION_REJECTED", 403);
  if (message.includes("OFFLINE_SALE_CHECKOUT_CONFLICT") || message.includes("INSUFFICIENT_STOCK") || message.includes("PRICE") || message.includes("UNAVAILABLE") || error?.code === "P0001") return response("SALE_CHECKOUT_CONFLICT", 409);
  if (error?.code === "22023") return response("SALE_CHECKOUT_REJECTED", 422);
  return response("SALE_CHECKOUT_UNAVAILABLE", 503);
}

/** Narrow Staff/Manager-only replay boundary. The RPC owns exact quotes and every sale-side write. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("SALE_CHECKOUT_REJECTED", 400);
  const { profile } = await getAuthenticatedProfile();
  if (!profile || !["STAFF", "MANAGER"].includes(profile.role)) return response("AUTHORIZATION_REJECTED", 403);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return response("SALE_CHECKOUT_UNAVAILABLE", 503);
  const { data, error } = await supabase.rpc("offline_sales_checkout", {
    p_operation_id: parsed.data.operationId,
    p_request_id: parsed.data.idempotencyKey,
    p_business_date: parsed.data.businessDate,
    p_customer_id: parsed.data.customerId,
    p_notes: parsed.data.notes,
    p_lines: parsed.data.lines.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId,
      condition: item.condition,
      quantity: item.quantity,
      serialized_unit_ids: [...item.serializedUnitIds].sort(),
      quote: { catalogue_price_id: item.quote.cataloguePriceId, price_revision: item.quote.priceRevision, quoted_selling_price: item.quote.quotedSellingPrice },
    })),
    p_payment: { method: "CASH", amount: parsed.data.payment.amount },
  });
  if (error || !data) return rpcFailure(error);
  return NextResponse.json({ sale: data }, { headers: noStore });
}
