"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupplierPaymentActionState } from "./supplier-payment-state";

const optionalText = z.string().trim().transform((value) => value || null);
const paymentMethod = z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]);
const paymentInput = z.object({
  requestId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  amount: z.coerce.number().finite().positive(),
  method: paymentMethod,
  paidOn: z.string().date(),
  reference: optionalText,
  notes: optionalText,
});
const reversalInput = z.object({
  requestId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(1),
  confirmation: z.literal("yes"),
});

type PaymentFinancialSummary = {
  supplier_id: string;
  purchase_state: "ACTIVE" | "REVERSED";
  historical_original_total: number | string;
  amount_still_payable: number | string;
};

function errorState(message: string, submissionRequestId: string | null): SupplierPaymentActionState {
  return { status: "error", message, submissionRequestId };
}

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function safePaymentMessage(message: string, operation: "record" | "reverse") {
  const normalized = message.toLowerCase();
  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) {
    return operation === "reverse" ? "Access denied. Only an administrator can reverse supplier payments." : "Access denied. You do not have permission to record supplier payments.";
  }
  if (normalized.includes("amount and non-future paid date")) return "Enter an amount greater than zero and a paid date that is not in the future.";
  if (normalized.includes("exceeds current remaining payable")) return "The payment amount exceeds the current remaining payable balance.";
  if (normalized.includes("supplier payment does not exist")) return "This payment is already reversed or no longer available.";
  if (normalized.includes("requires an active purchase") || normalized.includes("purchase unreversed")) return operation === "reverse" ? "This payment is already reversed or its purchase is no longer active." : "This purchase is reversed or no longer available for payment.";
  if (normalized.includes("payment reversal reason")) return "Enter a reason for reversing this payment.";
  if (normalized.includes("refund receipts would exceed")) return "This reversal is blocked because it would conflict with completed refund receipts.";
  if (normalized.includes("already used") || normalized.includes("incomplete")) return "This submission conflicts with an earlier request. Review the details and try again.";
  return operation === "reverse" ? "We could not reverse this payment. Check your connection and try again." : "We could not record the payment. Check your connection and try again.";
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

function revalidatePaymentPaths(purchaseId: string, supplierId: string | null = null) {
  revalidatePath("/app/purchases");
  revalidatePath(`/app/purchases/${purchaseId}`);
  if (supplierId) revalidatePath(`/app/suppliers/${supplierId}`);
}

export async function recordSupplierPayment(_: SupplierPaymentActionState, formData: FormData): Promise<SupplierPaymentActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = paymentInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Enter a payment amount greater than zero, method, and valid paid date.", submissionRequestId);
  if (parsed.data.paidOn > lagosToday()) return errorState("Paid date cannot be in the future.", parsed.data.requestId);

  let supplierId: string | null = null;
  try {
    const context = await getProcurementClient();
    if (!context) return errorState("Access denied. You do not have permission to record supplier payments.", parsed.data.requestId);

    const { data: financial, error: financialError } = await context.supabase
      .from("purchase_financial_summary")
      .select("supplier_id,purchase_state,historical_original_total,amount_still_payable")
      .eq("purchase_id", parsed.data.purchaseId)
      .maybeSingle();
    if (financialError) return errorState("Payment details are temporarily unavailable. Check your connection and try again.", parsed.data.requestId);
    if (!financial) return errorState("This purchase is reversed or no longer available for payment.", parsed.data.requestId);

    const currentFinancial = financial as PaymentFinancialSummary;
    supplierId = currentFinancial.supplier_id;
    if (currentFinancial.purchase_state !== "ACTIVE") return errorState("This purchase is reversed or no longer available for payment.", parsed.data.requestId);
    if (Number(currentFinancial.historical_original_total) === 0) return errorState("Zero-total purchases cannot accept supplier payments.", parsed.data.requestId);
    if (Number(currentFinancial.amount_still_payable) <= 0) return errorState("This purchase has no remaining payable balance.", parsed.data.requestId);
    if (parsed.data.amount > Number(currentFinancial.amount_still_payable)) return errorState("The payment amount exceeds the current remaining payable balance.", parsed.data.requestId);

    const rpcArguments = {
      p_request_id: parsed.data.requestId,
      p_purchase_id: parsed.data.purchaseId,
      p_amount: parsed.data.amount,
      p_method: parsed.data.method,
      p_paid_on: parsed.data.paidOn,
      p_reference: parsed.data.reference,
      p_notes: parsed.data.notes,
    };
    const { error } = await context.supabase.rpc("supplier_record_payment", rpcArguments);
    if (error) return errorState(safePaymentMessage(error.message, "record"), parsed.data.requestId);
  } catch (error) {
    return errorState(safePaymentMessage(error instanceof Error ? error.message : "", "record"), parsed.data.requestId);
  }

  revalidatePaymentPaths(parsed.data.purchaseId, supplierId);
  return { status: "success", message: "Supplier payment recorded.", submissionRequestId: parsed.data.requestId };
}

export async function reverseSupplierPayment(_: SupplierPaymentActionState, formData: FormData): Promise<SupplierPaymentActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const parsed = reversalInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Confirm the reversal and enter a reason.", submissionRequestId);

  let supplierId: string | null = null;
  try {
    const context = await getProcurementClient(true);
    if (!context) return errorState("Access denied. Only an administrator can reverse supplier payments.", parsed.data.requestId);

    const rpcArguments = {
      p_request_id: parsed.data.requestId,
      p_supplier_payment_id: parsed.data.paymentId,
      p_reason: parsed.data.reason,
    };
    const { error } = await context.supabase.rpc("supplier_reverse_payment", rpcArguments);
    if (error) return errorState(safePaymentMessage(error.message, "reverse"), parsed.data.requestId);

    const { data: purchase } = await context.supabase.from("purchases").select("supplier_id").eq("id", parsed.data.purchaseId).maybeSingle();
    supplierId = purchase?.supplier_id ?? null;
  } catch (error) {
    return errorState(safePaymentMessage(error instanceof Error ? error.message : "", "reverse"), parsed.data.requestId);
  }

  revalidatePaymentPaths(parsed.data.purchaseId, supplierId);
  return { status: "success", message: "Supplier payment reversed.", submissionRequestId: parsed.data.requestId };
}
