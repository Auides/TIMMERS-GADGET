import { NextResponse } from "next/server";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OfflineAdjustmentRequestStatus } from "@/lib/offline/types";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
function text(value: unknown): string;
function text(value: unknown, nullable: true): string | null;
function text(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value === "string" && value) return value;
  throw new Error("Invalid request-status projection.");
}
function row(value: Record<string, unknown>): OfflineAdjustmentRequestStatus {
  const quantity = Number(value.requested_quantity);
  const status = text(value.status);
  if (!Number.isSafeInteger(quantity) || !["OPEN", "RESOLVED", "REJECTED"].includes(status)) throw new Error("Invalid request-status projection.");
  return { adjustmentRequestId: text(value.adjustment_request_id), productId: text(value.product_id), variantId: text(value.variant_id, true), unitId: text(value.unit_id, true), condition: text(value.condition, true), requestedQuantity: quantity, reason: text(value.reason), status: status as OfflineAdjustmentRequestStatus["status"], requestedAt: text(value.requested_at), reviewedAt: text(value.reviewed_at, true), rejectionReason: text(value.rejection_reason, true) };
}
/** Server-authoritative request state only; no inventory or financial fields cross this boundary. */
export async function GET() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile || (profile.role !== "STAFF" && profile.role !== "MANAGER")) return NextResponse.json({ message: "Offline request statuses are not available for this profile." }, { status: 403, headers: noStore });
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ message: "Offline request-status service is unavailable." }, { status: 503, headers: noStore });
  try {
    const { data, error } = await supabase.rpc("offline_inventory_adjustment_request_status_snapshot");
    if (error) throw error;
    return NextResponse.json((data ?? []).map((value: unknown) => row(value as Record<string, unknown>)), { headers: noStore });
  } catch { return NextResponse.json({ message: "Offline request-status service is unavailable." }, { status: 503, headers: noStore }); }
}
