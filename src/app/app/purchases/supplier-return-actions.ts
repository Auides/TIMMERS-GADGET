"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupplierReturnActionState } from "./supplier-return-state";

const optionalText = z.string().trim().transform((value) => value || null);
const paymentMethod = z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]);
const returnLineInput = z.object({
  purchase_item_id: z.string().uuid(),
  serialized_unit_id: z.string().uuid().nullable(),
  quantity: z.coerce.number().int().positive(),
});
const refundReceiptInput = z.object({
  amount: z.coerce.number().finite().positive(),
  method: paymentMethod,
  received_on: z.string().date(),
  reference: optionalText,
  notes: optionalText,
});
const returnInput = z.object({
  requestId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  returnedOn: z.string().date(),
  supplierReference: optionalText,
  reason: z.string().trim().min(1),
});

type ReturnFinancialSummary = { purchase_state: "ACTIVE" | "REVERSED" };

function errorState(message: string, submissionRequestId: string | null): SupplierReturnActionState {
  return { status: "error", message, submissionRequestId };
}

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function safeReturnMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) return "Access denied. You do not have permission to finalize supplier returns.";
  if (normalized.includes("non-future date and reason")) return "Enter a reason and a return date that is not in the future.";
  if (normalized.includes("at least one line")) return "Select at least one return line.";
  if (normalized.includes("purchase item and positive quantity")) return "Each selected return line needs a positive quantity.";
  if (normalized.includes("exceeds original purchase quantity")) return "A return quantity exceeds the remaining quantity on its original purchase line.";
  if (normalized.includes("current exact stock bucket quantity")) return "This return exceeds the current available stock for one of the selected lines.";
  if (normalized.includes("available exact purchase unit")) return "One selected serialized unit is no longer available for return from this purchase.";
  if (normalized.includes("initial refund receipt amount and date")) return "Each initial refund receipt needs an amount greater than zero and a date that is not in the future.";
  if (normalized.includes("initial refund receipt exceeds entitlement")) return "Initial refund receipts exceed the refund entitlement confirmed for this return.";
  if (normalized.includes("requires an active purchase")) return "This purchase is reversed or no longer available for a supplier return.";
  if (normalized.includes("already used") || normalized.includes("incomplete")) return "This submission conflicts with an earlier request. Review the details and try again.";
  return "We could not finalize this supplier return. Check your connection and try again.";
}

async function getProcurementClient() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("id,role,is_active").eq("id", user.id).maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || !canManageProcurement(profile.role)) return null;
  return { supabase };
}

function parseJsonArray(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function revalidateReturnPaths(purchaseId: string, supplierId: string) {
  revalidatePath("/app/purchases");
  revalidatePath(`/app/purchases/${purchaseId}`);
  revalidatePath(`/app/suppliers/${supplierId}`);
  revalidatePath("/app/inventory");
  revalidatePath("/app/inventory/serialized");
}

export async function finalizeSupplierReturn(_: SupplierReturnActionState, formData: FormData): Promise<SupplierReturnActionState> {
  const rawRequestId = formData.get("requestId");
  const submissionRequestId = typeof rawRequestId === "string" ? rawRequestId : null;
  const header = returnInput.safeParse(Object.fromEntries(formData));
  if (!header.success) return errorState("Enter a reason and a valid return date.", submissionRequestId);
  if (header.data.returnedOn > lagosToday()) return errorState("Return date cannot be in the future.", header.data.requestId);

  const lines = parseJsonArray(formData.get("lines"));
  const initialRefundReceipts = parseJsonArray(formData.get("initialRefundReceipts"));
  const parsedLines = z.array(returnLineInput).min(1).safeParse(lines);
  const parsedReceipts = z.array(refundReceiptInput).safeParse(initialRefundReceipts);
  if (!parsedLines.success) return errorState("Select at least one return line with a positive quantity.", header.data.requestId);
  if (!parsedReceipts.success) return errorState("Each initial refund receipt needs an amount greater than zero, method, and valid received date.", header.data.requestId);
  if (parsedReceipts.data.some((receipt) => receipt.received_on > lagosToday())) return errorState("Initial refund receipt dates cannot be in the future.", header.data.requestId);

  const serializedUnitIds = parsedLines.data.flatMap((line) => line.serialized_unit_id ? [line.serialized_unit_id] : []);
  if (new Set(serializedUnitIds).size !== serializedUnitIds.length) return errorState("A serialized unit can only be selected once.", header.data.requestId);

  let supplierId: string | null = null;
  try {
    const context = await getProcurementClient();
    if (!context) return errorState("Access denied. You do not have permission to finalize supplier returns.", header.data.requestId);

    const [{ data: purchase, error: purchaseError }, { data: financial, error: financialError }] = await Promise.all([
      context.supabase.from("purchases").select("supplier_id").eq("id", header.data.purchaseId).maybeSingle(),
      context.supabase.from("purchase_financial_summary").select("purchase_state").eq("purchase_id", header.data.purchaseId).maybeSingle(),
    ]);
    if (purchaseError || financialError) return errorState("Purchase details are temporarily unavailable. Check your connection and try again.", header.data.requestId);
    if (!purchase || !financial || (financial as ReturnFinancialSummary).purchase_state !== "ACTIVE") return errorState("This purchase is reversed or no longer available for a supplier return.", header.data.requestId);
    supplierId = purchase.supplier_id;

    const rpcArguments = {
      p_request_id: header.data.requestId,
      p_purchase_id: header.data.purchaseId,
      p_returned_on: header.data.returnedOn,
      p_supplier_reference: header.data.supplierReference,
      p_reason: header.data.reason,
      p_lines: parsedLines.data,
      p_initial_refund_receipts: parsedReceipts.data,
    };
    const { error } = await context.supabase.rpc("supplier_finalize_return", rpcArguments);
    if (error) return errorState(safeReturnMessage(error.message), header.data.requestId);
  } catch (error) {
    return errorState(safeReturnMessage(error instanceof Error ? error.message : ""), header.data.requestId);
  }

  revalidateReturnPaths(header.data.purchaseId, supplierId!);
  return { status: "success", message: "Supplier return finalized.", submissionRequestId: header.data.requestId };
}
