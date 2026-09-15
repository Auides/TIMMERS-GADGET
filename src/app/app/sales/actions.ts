"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SaleCheckoutResult, SerializedSaleUnit, SerializedSearchResult } from "./action-state";

const uuid = z.string().uuid();
const condition = z.enum(["NEW", "USED", "REFURBISHED"]);
const paymentMethod = z.enum(["CASH", "POS", "BANK_TRANSFER", "OTHER"]);

const checkoutInput = z.object({
  requestId: uuid,
  transactionOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).optional().default(""),
  lines: z.array(z.object({
    productId: uuid,
    variantId: uuid.nullable(),
    condition,
    quantity: z.number().int().positive(),
    serializedUnitIds: z.array(uuid),
  })).min(1),
  payments: z.array(z.object({
    amount: z.number().positive(),
    method: paymentMethod,
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reference: z.string().nullable(),
    notes: z.string().nullable(),
  })).min(1),
});

type SalesContext = {
  supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;
};

async function salesContext(): Promise<SalesContext | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || !hasPermission(profile.role, "sell")) return null;
  return { supabase };
}

function safeCheckoutError(message: string, code?: string) {
  const value = message.toUpperCase();
  if (code === "42501" || value.includes("UNAUTHENTICATED") || value.includes("ACTOR_NOT_ACTIVE") || value.includes("FORBIDDEN")) {
    return "Access denied. Sign in again and retry.";
  }
  if (value.includes("ORDINARY_SALE_MUST_BE_FULLY_PAID")) return "Payment total must exactly match the current sale total. Refresh the cart total and try again.";
  if (value.includes("INSUFFICIENT_STOCK")) return "One or more items no longer have enough stock. Refresh and adjust the cart.";
  if (value.includes("SERIALIZED_UNIT_UNAVAILABLE") || value.includes("SERIALIZED_UNIT_NOT_FOUND")) return "A selected serialized unit is no longer available. Search and select another unit.";
  if (value.includes("PRICE_NOT_FOUND") || value.includes("PRODUCT_UNAVAILABLE") || value.includes("VARIANT_INVALID")) return "A product, variant, or current selling price changed. Refresh the checkout page and try again.";
  if (value.includes("FUTURE") || value.includes("INVALID_CHECKOUT_CONTEXT")) return "Check the sale date and checkout details, then try again.";
  if (value.includes("DUPLICATE_CHECKOUT_LINE") || value.includes("DUPLICATE_SERIALIZED_UNIT")) return "The cart contains a duplicate product or serialized unit. Remove the duplicate and retry.";
  if (value.includes("IDEMPOTENCY_MISMATCH")) return "This checkout changed after a previous submission. Refresh the page before trying again.";
  return "The sale could not be completed. Check the cart, payments, and connection, then try again.";
}

export async function searchSerializedUnitsForSale(query: string): Promise<SerializedSearchResult> {
  try {
    const search = query.trim();
    if (!search) return { status: "error", message: "Enter an IMEI, serial, SKU, barcode, or product name.", units: [] };
    const context = await salesContext();
    if (!context) return { status: "error", message: "Access denied. Sign in again and retry.", units: [] };

    const { data, error } = await context.supabase.rpc("staff_serialized_lookup", { search_text: search });
    if (error) return { status: "error", message: "Serialized search failed. Check your connection and try again.", units: [] };

    const deduped = new Map<string, SerializedSaleUnit>();
    for (const row of data ?? []) {
      if (row.status !== "AVAILABLE") continue;
      if (!deduped.has(row.unit_id)) {
        deduped.set(row.unit_id, {
          unitId: row.unit_id,
          productId: row.product_id,
          productName: row.product_name,
          productSku: row.product_sku,
          variantId: row.variant_id ?? null,
          variantLabel: row.variant_label ?? null,
          condition: row.condition,
          sellingPrice: row.selling_price === null ? null : Number(row.selling_price),
          identifierType: row.identifier_type,
          identifierValue: row.identifier_value,
        });
      }
    }
    return { status: "success", units: [...deduped.values()] };
  } catch {
    return { status: "error", message: "Serialized search failed. Check your connection and try again.", units: [] };
  }
}

export async function finalizeOrdinarySale(input: unknown): Promise<SaleCheckoutResult> {
  try {
    const parsed = checkoutInput.safeParse(input);
    if (!parsed.success) return { status: "error", message: "Check the cart, payments, and sale date before submitting." };
    const context = await salesContext();
    if (!context) return { status: "error", message: "Access denied. Sign in again and retry." };

    const { data, error } = await context.supabase.rpc("sales_finalize_checkout", {
    p_request_id: parsed.data.requestId,
    p_sale_kind: "ORDINARY",
    p_customer_id: null,
    p_transaction_on: parsed.data.transactionOn,
    p_notes: parsed.data.notes.trim() || null,
    p_lines: parsed.data.lines.map((line) => ({
      product_id: line.productId,
      variant_id: line.variantId,
      condition: line.condition,
      quantity: line.quantity,
      serialized_unit_ids: line.serializedUnitIds,
    })),
    p_payments: parsed.data.payments.map((payment) => ({
      amount: payment.amount,
      method: payment.method,
      paid_on: payment.paidOn,
      reference: payment.reference,
      notes: payment.notes,
    })),
    p_discount_request_id: null,
    p_approved_discount_amount: 0,
    p_credit_request_id: null,
  });

  if (error) return { status: "error", message: safeCheckoutError(error.message, error.code) };
  const result = data as Record<string, unknown> | null;
  const saleId = typeof result?.sale_id === "string" ? result.sale_id : null;
  const saleNumber = Number(result?.sale_number);
  const finalTotal = Number(result?.final_total);
  const paymentTotal = Number(result?.active_payment_total);
  if (!saleId || !Number.isFinite(saleNumber) || !Number.isFinite(finalTotal) || !Number.isFinite(paymentTotal)) {
    return { status: "error", message: "The sale completed but the confirmation response was incomplete. Refresh before retrying." };
  }

    revalidatePath("/app/inventory");
    revalidatePath("/app/catalogue");
    revalidatePath("/app/sales/new");
    return {
      status: "success",
      message: `Sale #${saleNumber} completed successfully.`,
      sale: { saleId, saleNumber, finalTotal, paymentTotal },
    };
  } catch {
    return { status: "error", message: "The sale could not be completed. Check your connection and try again." };
  }
}
