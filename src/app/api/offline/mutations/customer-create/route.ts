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
  customerId: z.string().uuid(),
  fullName: z.string().trim().min(1),
  phone: optionalText,
  email: optionalText,
});

function response(message: string, status: number) { return NextResponse.json({ code: message }, { status, headers: noStore }); }
function rpcFailure(error: { code?: string } | null) {
  if (error?.code === "42501") return response("AUTHORIZATION_REJECTED", 403);
  if (error?.code === "22023") return response("CUSTOMER_CREATE_REJECTED", 422);
  if (error?.code === "23505" || error?.code === "P0001") return response("CUSTOMER_CREATE_CONFLICT", 409);
  return response("CUSTOMER_CREATE_UNAVAILABLE", 503);
}
function customerResult(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" && "customer_id" in row && typeof row.customer_id === "string" ? row.customer_id : null;
}

/** Authenticated server boundary for the sole Phase 5A offline business command. */
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response("CUSTOMER_CREATE_REJECTED", 400);
  const { profile } = await getAuthenticatedProfile();
  if (!profile || !["ADMIN", "MANAGER", "STAFF"].includes(profile.role)) return response("AUTHORIZATION_REJECTED", 403);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return response("CUSTOMER_CREATE_UNAVAILABLE", 503);
  const { data, error } = await supabase.rpc("offline_customer_create", {
    p_operation_id: parsed.data.operationId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_customer_id: parsed.data.customerId,
    p_full_name: parsed.data.fullName,
    p_phone: parsed.data.phone,
    p_email: parsed.data.email,
  });
  if (error) return rpcFailure(error);
  const customerId = customerResult(data);
  if (!customerId) return response("CUSTOMER_CREATE_UNAVAILABLE", 503);
  return NextResponse.json({ customerId }, { headers: noStore });
}
