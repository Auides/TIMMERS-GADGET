"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ProcurementReversalActionState } from "./procurement-reversal-state";

const returnReversalInput = z.object({
  requestId: z.string().uuid(),
  supplierReturnId: z.string().uuid(),
  reason: z.string().trim().min(1),
  confirmation: z.literal("yes"),
});
const purchaseReversalInput = z.object({
  requestId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  reason: z.string().trim().min(1),
  confirmation: z.literal("yes"),
});

function errorState(message: string, submissionRequestId: string | null): ProcurementReversalActionState {
  return { status: "error", message, submissionRequestId };
}

function safeReversalMessage(message: string, operation: "return" | "purchase") {
  const normalized = message.toLowerCase();
  const prefix = operation === "return" ? "supplier return" : "purchase";
  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) return `Access denied. Only an administrator can reverse this ${prefix}.`;
  if (normalized.includes("reversal reason")) return `Enter a reason for reversing this ${prefix}.`;
  if (normalized.includes("reverse active refund receipts")) return "Active refund receipts must be reversed before this supplier return can be reversed.";
  if (normalized.includes("supplier return must be active") || normalized.includes("supplier return does not exist")) return "This supplier return is already reversed or no longer available.";
  if (normalized.includes("later bucket movement")) return operation === "return" ? "This reversal is blocked because inventory changed after the supplier return." : "This reversal is blocked because inventory changed after the purchase.";
  if (normalized.includes("later lifecycle transition")) return "This reversal is blocked because a serialized unit changed after the supplier return.";
  if (normalized.includes("permanently blocked by supplier-return history")) return "This purchase cannot be reversed because it has supplier-return history.";
  if (normalized.includes("pre-existing supplier payment reversal")) return "This purchase cannot be reversed because a supplier payment was already reversed independently.";
  if (normalized.includes("acquired serialized unit") || normalized.includes("receipt lifecycle state")) return "This reversal is blocked because a purchased serialized unit is no longer at its receipt state.";
  if (normalized.includes("purchase must be active")) return "This purchase is already reversed or no longer available.";
  if (normalized.includes("already used") || normalized.includes("incomplete")) return "This submission conflicts with an earlier request. Review the details and try again.";
  return operation === "return" ? "We could not reverse this supplier return. Check your connection and try again." : "We could not reverse this purchase. Check your connection and try again.";
}

async function getAdminProcurementClient() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("id,role,is_active").eq("id", user.id).maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || profile.role !== "ADMIN") return null;
  return { supabase };
}

function revalidateReversalPaths(purchaseId: string, supplierId: string | null) {
  revalidatePath("/app/purchases");
  revalidatePath(`/app/purchases/${purchaseId}`);
  if (supplierId) revalidatePath(`/app/suppliers/${supplierId}`);
  revalidatePath("/app/inventory");
  revalidatePath("/app/inventory/serialized");
}

async function getPurchaseContext(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, purchaseId: string) {
  if (!supabase) return null;
  const { data: purchase, error } = await supabase.from("purchases").select("id,supplier_id").eq("id", purchaseId).maybeSingle();
  if (error || !purchase) return null;
  return purchase;
}

export async function reverseSupplierReturn(_: ProcurementReversalActionState, formData: FormData): Promise<ProcurementReversalActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = returnReversalInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Confirm the reversal and enter a reason.", submissionRequestId);

  let purchaseId: string | null = null;
  let supplierId: string | null = null;
  try {
    const context = await getAdminProcurementClient();
    if (!context) return errorState("Access denied. Only an administrator can reverse this supplier return.", parsed.data.requestId);
    const { data: supplierReturn, error: returnError } = await context.supabase.from("supplier_returns").select("purchase_id").eq("id", parsed.data.supplierReturnId).maybeSingle();
    if (returnError || !supplierReturn) return errorState("This supplier return is already reversed or no longer available.", parsed.data.requestId);
    const returnPurchaseId = supplierReturn.purchase_id;
    purchaseId = returnPurchaseId;
    const purchase = await getPurchaseContext(context.supabase, returnPurchaseId);
    if (!purchase) return errorState("This supplier return is already reversed or no longer available.", parsed.data.requestId);
    supplierId = purchase.supplier_id;

    const { error } = await context.supabase.rpc("supplier_reverse_return", {
      p_request_id: parsed.data.requestId,
      p_supplier_return_id: parsed.data.supplierReturnId,
      p_reason: parsed.data.reason,
    });
    if (error) return errorState(safeReversalMessage(error.message, "return"), parsed.data.requestId);
  } catch (error) {
    return errorState(safeReversalMessage(error instanceof Error ? error.message : "", "return"), parsed.data.requestId);
  }

  revalidateReversalPaths(purchaseId!, supplierId);
  return { status: "success", message: "Supplier return reversed.", submissionRequestId: parsed.data.requestId };
}

export async function reversePurchase(_: ProcurementReversalActionState, formData: FormData): Promise<ProcurementReversalActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = purchaseReversalInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Confirm the reversal and enter a reason.", submissionRequestId);

  let supplierId: string | null = null;
  try {
    const context = await getAdminProcurementClient();
    if (!context) return errorState("Access denied. Only an administrator can reverse this purchase.", parsed.data.requestId);
    const purchase = await getPurchaseContext(context.supabase, parsed.data.purchaseId);
    if (!purchase) return errorState("This purchase is already reversed or no longer available.", parsed.data.requestId);
    supplierId = purchase.supplier_id;

    const { error } = await context.supabase.rpc("purchase_reverse", {
      p_request_id: parsed.data.requestId,
      p_purchase_id: parsed.data.purchaseId,
      p_reason: parsed.data.reason,
    });
    if (error) return errorState(safeReversalMessage(error.message, "purchase"), parsed.data.requestId);
  } catch (error) {
    return errorState(safeReversalMessage(error instanceof Error ? error.message : "", "purchase"), parsed.data.requestId);
  }

  revalidateReversalPaths(parsed.data.purchaseId, supplierId);
  return { status: "success", message: "Purchase reversed.", submissionRequestId: parsed.data.requestId };
}
