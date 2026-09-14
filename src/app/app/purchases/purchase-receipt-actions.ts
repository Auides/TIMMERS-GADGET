"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PurchaseReceiptActionState, PurchaseReceiptRecovery } from "./purchase-receipt-state";

const optionalText = z.string().trim().transform((value) => value || null);
const optionalDate = z.union([z.string().date(), z.literal("")]).transform((value) => value || null);
const optionalCost = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}, z.number().finite().nonnegative().nullable());
const condition = z.enum(["NEW", "USED", "REFURBISHED"]);
const paymentMethod = z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]);
const identifier = z.object({ imei1: optionalText, imei2: optionalText, serial: optionalText });
const serializedUnit = z.object({ acquisitionCost: z.coerce.number().finite().nonnegative(), warrantyStart: optionalDate, warrantyExpiry: optionalDate }).and(identifier);
const receiptSchema = z.object({
  requestId: z.string().uuid(),
  supplierId: z.string().uuid(),
  receivedOn: z.string().date(),
  supplierReference: optionalText,
  notes: optionalText,
  lines: z.array(z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    condition,
    quantity: z.coerce.number().int().positive(),
    unitCost: optionalCost,
    notes: optionalText,
    serializedUnits: z.array(serializedUnit),
  })).min(1),
  initialPayments: z.array(z.object({ amount: z.coerce.number().finite().positive(), method: paymentMethod, paidOn: z.string().date(), reference: optionalText, notes: optionalText })),
});

function errorState(message: string, recovery: PurchaseReceiptRecovery | null = null): PurchaseReceiptActionState {
  return { status: "error", message, recovery, submissionRequestId: recovery?.requestId || null };
}

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function parseJsonField(formData: FormData, field: string) {
  const value = formData.get(field);
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function recoveryCondition(value: unknown): "NEW" | "USED" | "REFURBISHED" {
  return value === "USED" || value === "REFURBISHED" ? value : "NEW";
}

function recoveryPaymentMethod(value: unknown): "CASH" | "POS" | "BANK_TRANSFER" | "OTHER" {
  return value === "POS" || value === "BANK_TRANSFER" || value === "OTHER" ? value : "CASH";
}

function recoveryFromForm(formData: FormData): PurchaseReceiptRecovery {
  const rawLines = parseJsonField(formData, "lines");
  const rawPayments = parseJsonField(formData, "initialPayments");
  const lines = Array.isArray(rawLines) ? rawLines.flatMap((value) => {
    const line = recordValue(value);
    if (!line) return [];
    const rawUnits = Array.isArray(line.serializedUnits) ? line.serializedUnits : [];
    return [{
      productId: textValue(line.productId), variantId: textValue(line.variantId), condition: recoveryCondition(line.condition),
      quantity: textValue(line.quantity), unitCost: textValue(line.unitCost), notes: textValue(line.notes),
      serializedUnits: rawUnits.flatMap((unitValue) => {
        const unit = recordValue(unitValue);
        return unit ? [{ acquisitionCost: textValue(unit.acquisitionCost), imei1: textValue(unit.imei1), imei2: textValue(unit.imei2), serial: textValue(unit.serial), warrantyStart: textValue(unit.warrantyStart), warrantyExpiry: textValue(unit.warrantyExpiry) }] : [];
      }),
    }];
  }) : [];
  const initialPayments = Array.isArray(rawPayments) ? rawPayments.flatMap((value) => {
    const payment = recordValue(value);
    return payment ? [{ amount: textValue(payment.amount), method: recoveryPaymentMethod(payment.method), paidOn: textValue(payment.paidOn), reference: textValue(payment.reference), notes: textValue(payment.notes) }] : [];
  }) : [];
  return {
    requestId: textValue(formData.get("requestId")), supplierId: textValue(formData.get("supplierId")), receivedOn: textValue(formData.get("receivedOn")),
    supplierReference: textValue(formData.get("supplierReference")), notes: textValue(formData.get("notes")), lines, initialPayments,
  };
}

function invalidPayloadMessage(issues: Array<{ path: PropertyKey[] }>) {
  const path = issues[0]?.path ?? [];
  if (path[0] === "initialPayments") return "Check each initial payment amount, method, and paid date.";
  if (path[0] === "lines" && path.includes("serializedUnits")) return "Check the serialized unit costs, identifiers, and warranty dates.";
  if (path[0] === "lines") return "Check each purchase line product, variant, quantity, and cost.";
  if (path[0] === "receivedOn") return "Choose a valid received date.";
  return "Check the purchase header, lines, and initial payments before submitting.";
}

function normalizedIdentifier(value: string) { return value.trim().toUpperCase(); }

function safePurchaseReceiptMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) return "Access denied. You do not have permission to record purchases.";
  if (normalized.includes("active supplier")) return "Select an active supplier for this purchase.";
  if (normalized.includes("at least one line")) return "Add at least one purchase line.";
  if (normalized.includes("identifier") || normalized.includes("unique") || normalized.includes("duplicate")) return "That IMEI or serial number is already recorded.";
  if (normalized.includes("warranty")) return "Warranty end cannot be earlier than warranty start.";
  if (normalized.includes("serialized purchase")) return "Each serialized line needs one or more complete serialized units.";
  if (normalized.includes("active product")) return "One or more products are no longer active. Refresh and choose an active product.";
  if (normalized.includes("active matching variant") || normalized.includes("variant")) return "Choose the required active variant for each applicable product.";
  if (normalized.includes("positive quantity")) return "Each purchase line requires a quantity greater than zero.";
  if (normalized.includes("non-negative unit cost") || normalized.includes("acquisition")) return "Each purchase line requires a cost of zero or more.";
  if (normalized.includes("received date") || normalized.includes("future")) return "Received and payment dates cannot be in the future.";
  if (normalized.includes("initial supplier payment") || normalized.includes("initial payments")) return "Each initial payment needs a positive amount, method, and non-future paid date.";
  if (normalized.includes("cannot exceed the purchase total")) return "Initial payments cannot exceed the purchase total, and zero-total purchases cannot accept payment.";
  if (normalized.includes("already used") || normalized.includes("incomplete")) return "This submission conflicts with an earlier request. Review the receipt and submit it again.";
  return "We could not record the purchase. Check your connection and try again.";
}

async function getPurchaseManagerClient() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("id,role,is_active").eq("id", user.id).maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || !canManageProcurement(profile.role)) return null;
  return { supabase };
}

function returnedPurchaseId(data: unknown) {
  if (!data || typeof data !== "object" || !("purchase_id" in data) || typeof data.purchase_id !== "string") return null;
  return data.purchase_id;
}

export async function receivePurchase(_: PurchaseReceiptActionState, formData: FormData): Promise<PurchaseReceiptActionState> {
  const recovery = recoveryFromForm(formData);
  const parsed = receiptSchema.safeParse({
    requestId: formData.get("requestId"), supplierId: formData.get("supplierId"), receivedOn: formData.get("receivedOn"),
    supplierReference: formData.get("supplierReference") ?? "", notes: formData.get("notes") ?? "",
    lines: parseJsonField(formData, "lines"), initialPayments: parseJsonField(formData, "initialPayments"),
  });
  if (!parsed.success) return errorState(invalidPayloadMessage(parsed.error.issues), recovery);
  if (parsed.data.receivedOn > lagosToday() || parsed.data.initialPayments.some((payment) => payment.paidOn > lagosToday())) return errorState("Received and payment dates cannot be in the future.", recovery);

  let purchaseId: string | null = null;
  try {
    const context = await getPurchaseManagerClient();
    if (!context) return errorState("Access denied. You do not have permission to record purchases.", recovery);

    const productIds = [...new Set(parsed.data.lines.map((line) => line.productId))];
    const [supplierResult, productsResult, variantsResult] = await Promise.all([
      context.supabase.from("suppliers").select("id").eq("id", parsed.data.supplierId).eq("active", true).maybeSingle(),
      context.supabase.from("products").select("id,serialized").in("id", productIds).eq("active", true),
      context.supabase.from("product_variants").select("id,product_id").in("product_id", productIds).eq("active", true),
    ]);
    if (supplierResult.error || productsResult.error || variantsResult.error) return errorState("Purchase entry is temporarily unavailable. Check your connection and try again.", recovery);
    if (!supplierResult.data) return errorState("Select an active supplier for this purchase.", recovery);

    const productsById = new Map((productsResult.data ?? []).map((product) => [product.id, product]));
    const activeVariantsByProduct = new Map<string, string[]>();
    for (const variant of variantsResult.data ?? []) activeVariantsByProduct.set(variant.product_id, [...(activeVariantsByProduct.get(variant.product_id) ?? []), variant.id]);

    let estimatedTotal = 0;
    const identifierValues = new Set<string>();
    for (const line of parsed.data.lines) {
      const product = productsById.get(line.productId);
      if (!product) return errorState("One or more products are no longer active. Refresh and choose an active product.", recovery);
      const activeVariants = activeVariantsByProduct.get(line.productId) ?? [];
      if ((activeVariants.length > 0 && !line.variantId) || (activeVariants.length === 0 && line.variantId) || (line.variantId && !activeVariants.includes(line.variantId))) return errorState("Choose the required active variant for each applicable product.", recovery);

      if (!product.serialized) {
        if (line.unitCost === null || line.serializedUnits.length !== 0) return errorState("Each nonserialized line requires a unit cost and cannot include serialized units.", recovery);
        estimatedTotal += line.quantity * line.unitCost;
        continue;
      }

      if (line.unitCost !== null || line.serializedUnits.length === 0 || line.serializedUnits.length !== line.quantity) return errorState("Each serialized line needs one or more complete serialized units.", recovery);
      for (const unit of line.serializedUnits) {
        if (unit.warrantyStart && unit.warrantyExpiry && unit.warrantyExpiry < unit.warrantyStart) return errorState("Warranty end cannot be earlier than warranty start.", recovery);
        const identifiers = [unit.imei1, unit.imei2, unit.serial].filter((value): value is string => Boolean(value));
        if (identifiers.length === 0) return errorState("Each serialized unit requires at least one IMEI or serial number.", recovery);
        for (const identifierValue of identifiers) {
          const normalized = normalizedIdentifier(identifierValue);
          if (identifierValues.has(normalized)) return errorState("Each IMEI or serial number can be used only once in this receipt.", recovery);
          identifierValues.add(normalized);
        }
        estimatedTotal += unit.acquisitionCost;
      }
    }

    const initialPaymentTotal = parsed.data.initialPayments.reduce((total, payment) => total + payment.amount, 0);
    if (initialPaymentTotal > estimatedTotal || (estimatedTotal === 0 && initialPaymentTotal !== 0)) return errorState("Initial payments cannot exceed the purchase total, and zero-total purchases cannot accept payment.", recovery);

    const rpcArguments = {
      p_request_id: parsed.data.requestId, p_supplier_id: parsed.data.supplierId, p_received_on: parsed.data.receivedOn,
      p_supplier_reference: parsed.data.supplierReference, p_notes: parsed.data.notes,
      p_lines: parsed.data.lines.map((line) => {
        const product = productsById.get(line.productId);
        return product?.serialized ? {
          product_id: line.productId, variant_id: line.variantId, condition: line.condition, quantity: line.serializedUnits.length, unit_cost: null, notes: line.notes,
          serialized_units: line.serializedUnits.map((unit) => ({
            acquisition_cost: unit.acquisitionCost, condition: line.condition, warranty_start: unit.warrantyStart, warranty_expiry: unit.warrantyExpiry,
            identifiers: [
              unit.imei1 ? { type: "IMEI_1", value: normalizedIdentifier(unit.imei1) } : null,
              unit.imei2 ? { type: "IMEI_2", value: normalizedIdentifier(unit.imei2) } : null,
              unit.serial ? { type: "SERIAL", value: normalizedIdentifier(unit.serial) } : null,
            ].filter((entry): entry is { type: "IMEI_1" | "IMEI_2" | "SERIAL"; value: string } => entry !== null),
          })),
        } : {
          product_id: line.productId, variant_id: line.variantId, condition: line.condition, quantity: line.quantity,
          unit_cost: line.unitCost, notes: line.notes, serialized_units: [],
        };
      }),
      p_initial_payments: parsed.data.initialPayments.map((payment) => ({ amount: payment.amount, method: payment.method, paid_on: payment.paidOn, reference: payment.reference, notes: payment.notes })),
    };
    const { data, error } = await context.supabase.rpc("purchase_receive", rpcArguments);
    if (error) return errorState(safePurchaseReceiptMessage(error.message), recovery);
    purchaseId = returnedPurchaseId(data);
    if (!purchaseId) return errorState("The purchase was received, but confirmation could not be completed. Review the purchase list before retrying.", recovery);
  } catch (error) {
    return errorState(safePurchaseReceiptMessage(error instanceof Error ? error.message : ""), recovery);
  }

  revalidatePath("/app/purchases");
  revalidatePath(`/app/purchases/${purchaseId}`);
  revalidatePath("/app/suppliers");
  revalidatePath(`/app/suppliers/${parsed.data.supplierId}`);
  revalidatePath("/app/inventory");
  redirect(`/app/purchases/${purchaseId}`);
}
