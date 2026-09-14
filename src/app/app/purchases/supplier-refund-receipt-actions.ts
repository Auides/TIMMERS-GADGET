"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupplierRefundReceiptActionState } from "./supplier-refund-receipt-state";

const optionalText = z.string().trim().transform((value) => value || null);
const paymentMethod = z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]);
const refundReceiptInput = z.object({
  requestId: z.string().uuid(),
  supplierReturnId: z.string().uuid(),
  amount: z.coerce.number().finite().positive(),
  method: paymentMethod,
  receivedOn: z.string().date(),
  reference: optionalText,
  notes: optionalText,
});
const reversalInput = z.object({
  requestId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  refundReceiptId: z.string().uuid(),
  reason: z.string().trim().min(1),
  confirmation: z.literal("yes"),
});

type ReturnFinancialSummary = {
  purchase_id: string;
  remaining_refund_due: number | string;
  refund_status: "NO_REFUND_DUE" | "REFUND_DUE" | "PARTIALLY_REFUNDED" | "REFUNDED";
};

function errorState(message: string, submissionRequestId: string | null): SupplierRefundReceiptActionState {
  return { status: "error", message, submissionRequestId };
}

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function safeRefundReceiptMessage(message: string, operation: "record" | "reverse") {
  const normalized = message.toLowerCase();
  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) {
    return operation === "reverse" ? "Access denied. Only an administrator can reverse supplier refund receipts." : "Access denied. You do not have permission to record supplier refunds.";
  }
  if (normalized.includes("amount and non-future received date")) return "Enter a refund amount greater than zero and a received date that is not in the future.";
  if (normalized.includes("exceeds current refund entitlement")) return "The refund amount exceeds the current remaining refund due.";
  if (normalized.includes("requires an active supplier return and purchase")) return "This supplier return is reversed or no longer eligible for a refund receipt.";
  if (normalized.includes("refund receipt does not exist") || normalized.includes("already reversed or does not exist")) return "This refund receipt is already reversed or no longer available.";
  if (normalized.includes("refund receipt reversal reason")) return "Enter a reason for reversing this refund receipt.";
  if (normalized.includes("already used") || normalized.includes("incomplete")) return "This submission conflicts with an earlier request. Review the details and try again.";
  return operation === "reverse" ? "We could not reverse this refund receipt. Check your connection and try again." : "We could not record the refund receipt. Check your connection and try again.";
}

async function getProcurementClient(adminOnly = false) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("id,role,is_active").eq("id", user.id).maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || (adminOnly ? profile.role !== "ADMIN" : !canManageProcurement(profile.role))) return null;
  return { supabase };
}

function revalidateRefundReceiptPaths(purchaseId: string, supplierId: string | null) {
  revalidatePath("/app/purchases");
  revalidatePath(`/app/purchases/${purchaseId}`);
  if (supplierId) revalidatePath(`/app/suppliers/${supplierId}`);
}

async function supplierIdForPurchase(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, purchaseId: string) {
  if (!supabase) return null;
  const { data: purchase } = await supabase.from("purchases").select("supplier_id").eq("id", purchaseId).maybeSingle();
  return purchase?.supplier_id ?? null;
}

export async function recordSupplierRefundReceipt(_: SupplierRefundReceiptActionState, formData: FormData): Promise<SupplierRefundReceiptActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = refundReceiptInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Enter a refund amount greater than zero, method, and valid received date.", submissionRequestId);
  if (parsed.data.receivedOn > lagosToday()) return errorState("Received date cannot be in the future.", parsed.data.requestId);

  let purchaseId: string | null = null;
  let supplierId: string | null = null;
  try {
    const context = await getProcurementClient();
    if (!context) return errorState("Access denied. You do not have permission to record supplier refunds.", parsed.data.requestId);

    const { data: financial, error: financialError } = await context.supabase
      .from("supplier_return_financial_summary")
      .select("purchase_id,remaining_refund_due,refund_status")
      .eq("supplier_return_id", parsed.data.supplierReturnId)
      .maybeSingle();
    if (financialError) return errorState("Refund details are temporarily unavailable. Check your connection and try again.", parsed.data.requestId);
    if (!financial) return errorState("This supplier return is reversed or no longer eligible for a refund receipt.", parsed.data.requestId);

    const currentFinancial = financial as ReturnFinancialSummary;
    purchaseId = currentFinancial.purchase_id;
    if (currentFinancial.refund_status === "NO_REFUND_DUE" || currentFinancial.refund_status === "REFUNDED" || Number(currentFinancial.remaining_refund_due) <= 0) {
      return errorState("This supplier return has no remaining refund due.", parsed.data.requestId);
    }
    if (parsed.data.amount > Number(currentFinancial.remaining_refund_due)) return errorState("The refund amount exceeds the current remaining refund due.", parsed.data.requestId);

    const rpcArguments = {
      p_request_id: parsed.data.requestId,
      p_supplier_return_id: parsed.data.supplierReturnId,
      p_amount: parsed.data.amount,
      p_method: parsed.data.method,
      p_received_on: parsed.data.receivedOn,
      p_reference: parsed.data.reference,
      p_notes: parsed.data.notes,
    };
    const { error } = await context.supabase.rpc("supplier_record_refund_receipt", rpcArguments);
    if (error) return errorState(safeRefundReceiptMessage(error.message, "record"), parsed.data.requestId);
    supplierId = await supplierIdForPurchase(context.supabase, purchaseId);
  } catch (error) {
    return errorState(safeRefundReceiptMessage(error instanceof Error ? error.message : "", "record"), parsed.data.requestId);
  }

  revalidateRefundReceiptPaths(purchaseId!, supplierId);
  return { status: "success", message: "Supplier refund recorded.", submissionRequestId: parsed.data.requestId };
}

export async function reverseSupplierRefundReceipt(_: SupplierRefundReceiptActionState, formData: FormData): Promise<SupplierRefundReceiptActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = reversalInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Confirm the reversal and enter a reason.", submissionRequestId);

  let supplierId: string | null = null;
  try {
    const context = await getProcurementClient(true);
    if (!context) return errorState("Access denied. Only an administrator can reverse supplier refund receipts.", parsed.data.requestId);

    const rpcArguments = {
      p_request_id: parsed.data.requestId,
      p_supplier_refund_receipt_id: parsed.data.refundReceiptId,
      p_reason: parsed.data.reason,
    };
    const { error } = await context.supabase.rpc("supplier_reverse_refund_receipt", rpcArguments);
    if (error) return errorState(safeRefundReceiptMessage(error.message, "reverse"), parsed.data.requestId);
    supplierId = await supplierIdForPurchase(context.supabase, parsed.data.purchaseId);
  } catch (error) {
    return errorState(safeRefundReceiptMessage(error instanceof Error ? error.message : "", "reverse"), parsed.data.requestId);
  }

  revalidateRefundReceiptPaths(parsed.data.purchaseId, supplierId);
  return { status: "success", message: "Supplier refund receipt reversed.", submissionRequestId: parsed.data.requestId };
}
