import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const optionalText = z.string().trim().transform((value) => value || null).nullable().optional().transform((value) => value ?? null);
const requestSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  supplierId: z.string().uuid(),
  businessName: z.string().trim().min(1),
  contactName: optionalText,
  phone: optionalText,
  email: optionalText,
});

function response(code: string, status: number) { return NextResponse.json({ code }, { status, headers: noStore }); }
function rpcFailure(error: { code?: string } | null) {
  if (error?.code === "42501") return response("AUTHORIZATION_REJECTED", 403);
  if (error?.code === "22023") return response("SUPPLIER_CREATE_REJECTED", 422);
  if (error?.code === "23505" || error?.code === "P0001") return response("SUPPLIER_CREATE_CONFLICT", 409);
  return response("SUPPLIER_CREATE_UNAVAILABLE", 503);
}
function supplierResult(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" && "supplier_id" in row && typeof row.supplier_id === "string" ? row.supplier_id : null;
}

/** Authenticated Manager-only boundary for the sole Phase 6A supplier command. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("SUPPLIER_CREATE_REJECTED", 400);
  const { profile } = await getAuthenticatedProfile();
  if (!profile || profile.role !== "MANAGER") return response("AUTHORIZATION_REJECTED", 403);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return response("SUPPLIER_CREATE_UNAVAILABLE", 503);
  const { data, error } = await supabase.rpc("offline_supplier_create", {
    p_operation_id: parsed.data.operationId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_supplier_id: parsed.data.supplierId,
    p_business_name: parsed.data.businessName,
    p_contact_name: parsed.data.contactName,
    p_phone: parsed.data.phone,
    p_email: parsed.data.email,
  });
  if (error) return rpcFailure(error);
  const supplierId = supplierResult(data);
  if (!supplierId) return response("SUPPLIER_CREATE_UNAVAILABLE", 503);
  return NextResponse.json({ supplierId }, { headers: noStore });
}
