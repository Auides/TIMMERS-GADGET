"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { InventoryActionState } from "./inventory-state";
import { adjustmentUnitCostRpcValue, canExecuteOrRejectAdjustment, canRecordOpeningStock, canSubmitAdjustmentRequest, parseOptionalAdjustmentUnitCost } from "./inventory-ui";

const conditions = z.enum(["NEW", "USED", "REFURBISHED"]);
const id = z.string().uuid();

function safe(message: string, code?: string) {
  const value = message.toLowerCase();
  if (code === "42501" || value.includes("authority") || value.includes("active timmers")) return "Access denied for this inventory operation.";
  if (value.includes("negative inventory")) return "This adjustment would create negative inventory.";
  if (value.includes("positive adjustment requires")) return "A non-negative acquisition cost is required for a positive adjustment.";
  if (value.includes("requires at least one identifier")) return "A serialized opening-stock unit needs at least one IMEI or serial identifier.";
  if (value.includes("warranty expiry")) return "Warranty expiry cannot be earlier than warranty start.";
  if (value.includes("only an open adjustment" ) || value.includes("request is not open")) return "This adjustment request is no longer open.";
  if (value.includes("available matching unit") || value.includes("available unit")) return "Select an available serialized unit that matches the product.";
  if (value.includes("request id was already used")) return "This submission key was already used for different data. Refresh and try again.";
  if (value.includes("duplicate key") || value.includes("already exists")) return "That IMEI, serial, SKU, or barcode is already recorded.";
  if (value.includes("active product") || value.includes("active matching variant")) return "Select an active product and matching active variant.";
  return "Something went wrong. Check your connection and try again.";
}

type InventoryCapability = "requester" | "opening-stock" | "adjustment-admin";

async function actor(required?: InventoryCapability) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("id, full_name, role, is_active").eq("id", user.id).maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active) return null;
  if (required === "requester" && !canSubmitAdjustmentRequest(profile.role)) return null;
  if (required === "opening-stock" && !canRecordOpeningStock(profile.role)) return null;
  if (required === "adjustment-admin" && !canExecuteOrRejectAdjustment(profile.role)) return null;
  return { profile, supabase };
}

async function call(name: string, args: Record<string, unknown>, success: string, required?: InventoryCapability): Promise<InventoryActionState> {
  try { const current = await actor(required); if (!current?.supabase) return { status: "error", message: "Access denied for this inventory operation." }; const { error } = await current.supabase.rpc(name, args); if (error) return { status: "error", message: safe(error.message, error.code) }; revalidatePath("/app/inventory"); revalidatePath("/app/inventory/adjustments"); return { status: "success", message: success }; } catch (error) { return { status: "error", message: safe(error instanceof Error ? error.message : "") }; }
}

const requestSchema = z.object({ productId: id, variantId: z.string().optional(), unitId: z.string().optional(), condition: z.string().optional(), quantity: z.coerce.number().int(), reason: z.string().trim().min(1) });
export async function submitAdjustmentRequest(_: InventoryActionState, form: FormData) { const parsed = requestSchema.safeParse(Object.fromEntries(form)); if (!parsed.success) return { status: "error", message: "Enter a product, non-zero quantity, and reason." }; const v = parsed.data; return call("inventory_submit_adjustment_request", { p_product_id: v.productId, p_variant_id: v.variantId || null, p_unit_id: v.unitId || null, p_condition: v.unitId ? null : conditions.safeParse(v.condition).data ?? null, p_requested_quantity: v.unitId ? -1 : v.quantity, p_reason: v.reason }, "Adjustment request submitted.", "requester"); }
export async function executeAdjustment(_: InventoryActionState, form: FormData) { const p = requestSchema.extend({ requestId: id.optional(), adjustmentRequestId: id.optional() }).safeParse(Object.fromEntries(form)); if (!p.success) return { status: "error", message: "Check the adjustment details and try again." }; const v = p.data; const unitCost = parseOptionalAdjustmentUnitCost(form.get("unitCost")); if (unitCost === null) return { status: "error", message: "Enter a valid acquisition cost." }; if (!v.unitId && v.quantity > 0 && (unitCost === undefined || unitCost < 0)) return { status: "error", message: "A non-negative acquisition cost is required for a positive adjustment." }; return call("inventory_execute_adjustment", { p_request_id: v.requestId ?? crypto.randomUUID(), p_adjustment_request_id: v.adjustmentRequestId ?? null, p_product_id: v.productId, p_variant_id: v.variantId || null, p_unit_id: v.unitId || null, p_condition: v.unitId ? null : conditions.safeParse(v.condition).data ?? null, p_quantity: v.unitId ? -1 : v.quantity, p_unit_cost: adjustmentUnitCostRpcValue(v.unitId, v.quantity, unitCost), p_reason: v.reason }, "Inventory adjustment executed.", "adjustment-admin"); }
export async function rejectAdjustment(_: InventoryActionState, form: FormData) { const p = z.object({ id, reason: z.string().trim().min(1) }).safeParse(Object.fromEntries(form)); return p.success ? call("inventory_reject_adjustment_request", { p_request_id: p.data.id, p_rejection_reason: p.data.reason }, "Adjustment request rejected.", "adjustment-admin") : { status: "error", message: "Enter a rejection reason." }; }
export async function recordOpeningStock(_: InventoryActionState, form: FormData) { const p = z.object({ productId: id, variantId: z.string().optional(), serialized: z.enum(["true", "false"]), condition: conditions, quantity: z.coerce.number().int().positive(), cost: z.coerce.number().min(0), imei1: z.string().trim().optional(), imei2: z.string().trim().optional(), serial: z.string().trim().optional(), warrantyStart: z.string().optional(), warrantyExpiry: z.string().optional(), requestId: id.optional(), notes: z.string().optional() }).safeParse(Object.fromEntries(form)); if (!p.success) return { status: "error", message: "Check the opening-stock details and try again." }; const v = p.data; const identifiers = [["IMEI_1",v.imei1],["IMEI_2",v.imei2],["SERIAL",v.serial]].filter(([, value]) => value) .map(([type,value]) => ({ type, value })); if (v.serialized === "true" && (v.quantity !== 1 || identifiers.length === 0)) return { status: "error", message: "Serialized opening stock requires quantity one and at least one identifier." }; if (v.warrantyStart && v.warrantyExpiry && v.warrantyExpiry < v.warrantyStart) return { status: "error", message: "Warranty expiry cannot be earlier than warranty start." }; const line = { product_id: v.productId, variant_id: v.variantId || null, condition: v.condition, quantity: v.quantity, acquisition_cost: v.cost, warranty_start: v.warrantyStart || null, warranty_expiry: v.warrantyExpiry || null, identifiers }; return call("inventory_record_opening_stock", { p_request_id: v.requestId ?? crypto.randomUUID(), p_notes: v.notes?.trim() || null, p_lines: [line] }, "Opening stock recorded.", "opening-stock"); }
