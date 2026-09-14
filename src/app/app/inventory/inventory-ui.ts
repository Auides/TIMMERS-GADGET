export type InventoryRole = "ADMIN" | "MANAGER" | "STAFF";

export const canRecordOpeningStock = (role: InventoryRole) => role === "ADMIN" || role === "MANAGER";
export const canSubmitAdjustmentRequest = (role: InventoryRole) => role === "ADMIN" || role === "MANAGER" || role === "STAFF";
export const canExecuteOrRejectAdjustment = (role: InventoryRole) => role === "ADMIN";
export const inventoryOverviewActions = (role: InventoryRole) => ({
  openingStock: canRecordOpeningStock(role),
  adjustments: canSubmitAdjustmentRequest(role),
  serializedLookup: true,
});
export const isTerminalAdjustmentStatus = (status: string) => status === "RESOLVED" || status === "REJECTED";
export const isCameraScanningSupported = () =>
  typeof window !== "undefined" && "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);

/** A submission key is intentionally stable until a completed submission replaces it. */
export const newInventorySubmissionKey = () => crypto.randomUUID();
export const openingStockValidationMessage = (serialized: boolean, quantity: number, identifiers: string[], cost: number, start?: string, expiry?: string) => {
  if (!Number.isInteger(quantity) || quantity <= 0) return "Opening-stock quantity must be positive.";
  if (cost < 0 || Number.isNaN(cost)) return "Enter a non-negative acquisition cost.";
  if (serialized && quantity !== 1) return "Serialized opening stock requires quantity one per line.";
  if (serialized && !identifiers.some(Boolean)) return "A serialized opening-stock unit needs at least one IMEI or serial identifier.";
  if (start && expiry && expiry < start) return "Warranty expiry cannot be earlier than warranty start.";
  return null;
};
export const adjustmentValidationMessage = (serialized: boolean, quantity: number, cost?: number, reason?: string) => {
  if (!reason?.trim()) return "Enter a reason for this adjustment.";
  if (serialized && quantity !== -1) return "Serialized adjustments can only remove one available unit.";
  if (!serialized && quantity === 0) return "Adjustment quantity cannot be zero.";
  if (!serialized && quantity > 0 && (cost === undefined || cost < 0 || Number.isNaN(cost))) return "A non-negative acquisition cost is required for a positive adjustment.";
  return null;
};
export const parseOptionalAdjustmentUnitCost = (value: unknown): number | undefined | null => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (text === "") return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
};
export const adjustmentUnitCostRpcValue = (unitId: string | undefined, quantity: number, unitCost: number | undefined | null) =>
  unitId || quantity < 0 ? null : unitCost ?? null;
export const safeInventoryMessage = (message: string, code?: string) => {
  const v = message.toLowerCase(); if (code === "42501" || v.includes("authority") || v.includes("active timmers")) return "Access denied for this inventory operation.";
  if (v.includes("negative inventory")) return "This adjustment would create negative inventory.";
  if (v.includes("positive adjustment requires")) return "A non-negative acquisition cost is required for a positive adjustment.";
  if (v.includes("identifier")) return "A serialized opening-stock unit needs at least one IMEI or serial identifier.";
  if (v.includes("warranty expiry")) return "Warranty expiry cannot be earlier than warranty start.";
  return "Something went wrong. Check your connection and try again.";
};
export const variantsForProduct = <T extends { product_id: string }>(variants: T[], productId: string) => variants.filter(v => v.product_id === productId);
export const selectedVariantForProduct = <T extends { id: string; product_id: string }>(variants: T[], productId: string, variantId: string) => variants.find(v => v.product_id === productId && v.id === variantId)?.id ?? null;
export const isAvailableSerializedUnit = (unit: { status: string }) => unit.status === "AVAILABLE";
export const displaySellingPrice = (sellingPrice: number | string | null | undefined) => {
  if (sellingPrice === null || sellingPrice === undefined || sellingPrice === "") return "Price not configured";
  const amount = typeof sellingPrice === "number" ? sellingPrice : Number(sellingPrice);
  return Number.isFinite(amount) ? `₦${amount.toLocaleString()}` : "Price not configured";
};

/**
 * The Staff RPC returns a row per exact product/variant/condition bucket.
 * Keep variant identity visible instead of presenting variant stock as base stock.
 */
export const staffInventoryBucketDisplay = (bucket: {
  product_name: string;
  product_sku: string | null;
  variant_label?: string | null;
  variant_sku?: string | null;
}) => ({
  title: bucket.variant_label ? `${bucket.product_name} — ${bucket.variant_label}` : bucket.product_name,
  sku: bucket.variant_sku || bucket.product_sku || "SKU not configured",
});

type StaffRequestContext = {
  adjustment_request_id: string;
  product_name: string;
  product_sku: string | null;
  variant_label?: string | null;
  variant_sku?: string | null;
  identifiers?: unknown;
};

export const staffAdjustmentRequestContextById = (contexts: StaffRequestContext[]) =>
  new Map(contexts.map((context) => [context.adjustment_request_id, context]));

const identifierOrder = (type: string) => ({ IMEI_1: 1, IMEI_2: 2, SERIAL: 3 })[type] ?? 99;

/** Supports the safe Staff RPC shape and the existing management relation shape. */
export const staffRequestIdentifierLabels = (identifiers: unknown) => {
  if (!Array.isArray(identifiers)) return [];

  return identifiers
    .flatMap((identifier) => {
      if (!identifier || typeof identifier !== "object") return [];
      const record = identifier as Record<string, unknown>;
      const type = record.type ?? record.identifier_type;
      const value = record.value ?? record.normalized_value;
      return typeof type === "string"
        && typeof value === "string"
        && ["IMEI_1", "IMEI_2", "SERIAL"].includes(type)
        && value.trim() !== ""
        ? [{ type, value }]
        : [];
    })
    .sort((left, right) => identifierOrder(left.type) - identifierOrder(right.type) || left.value.localeCompare(right.value))
    .map((identifier) => `${identifier.type}: ${identifier.value}`);
};
