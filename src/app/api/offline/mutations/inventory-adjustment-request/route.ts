import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const base = { operationId: z.string().uuid(), idempotencyKey: z.string().uuid(), productId: z.string().uuid(), variantId: z.string().uuid().nullable(), requestedQuantity: z.number().int(), reason: z.string().trim().min(1) };
const requestSchema = z.union([
  z.object({ ...base, kind: z.literal("NON_SERIALIZED"), condition: z.enum(["NEW", "USED", "REFURBISHED"]), unitId: z.null() }).strict().refine((value) => value.requestedQuantity !== 0),
  z.object({ ...base, kind: z.literal("SERIALIZED"), condition: z.null(), unitId: z.string().uuid(), requestedQuantity: z.literal(-1) }).strict(),
]);
function response(code: string, status: number) { return NextResponse.json({ code }, { status, headers: noStore }); }
function rpcFailure(error: { code?: string } | null) {
  if (error?.code === "42501") return response("AUTHORIZATION_REJECTED", 403);
  if (error?.code === "22023") return response("INVENTORY_ADJUSTMENT_REQUEST_REJECTED", 422);
  if (error?.code === "23505" || error?.code === "P0001") return response("INVENTORY_ADJUSTMENT_REQUEST_CONFLICT", 409);
  return response("INVENTORY_ADJUSTMENT_REQUEST_UNAVAILABLE", 503);
}
function adjustmentRequestResult(data: unknown) {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" && "adjustment_request_id" in value && typeof value.adjustment_request_id === "string" ? value.adjustment_request_id : null;
}

/** Replays a narrow request-creation command. Inventory execution and approval remain online-only Admin workflows. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("INVENTORY_ADJUSTMENT_REQUEST_REJECTED", 400);
  const { profile } = await getAuthenticatedProfile();
  if (!profile || (profile.role !== "STAFF" && profile.role !== "MANAGER")) return response("AUTHORIZATION_REJECTED", 403);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return response("INVENTORY_ADJUSTMENT_REQUEST_UNAVAILABLE", 503);
  const { data, error } = await supabase.rpc("offline_inventory_adjustment_request_create", {
    p_operation_id: parsed.data.operationId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_kind: parsed.data.kind,
    p_product_id: parsed.data.productId,
    p_variant_id: parsed.data.variantId,
    p_condition: parsed.data.condition,
    p_unit_id: parsed.data.unitId,
    p_requested_quantity: parsed.data.requestedQuantity,
    p_reason: parsed.data.reason,
  });
  if (error) return rpcFailure(error);
  if (!adjustmentRequestResult(data)) return response("INVENTORY_ADJUSTMENT_REQUEST_UNAVAILABLE", 503);
  return NextResponse.json({ adjustmentRequestId: adjustmentRequestResult(data) }, { headers: noStore });
}
