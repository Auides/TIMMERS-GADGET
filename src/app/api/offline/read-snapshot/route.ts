import { NextResponse } from "next/server";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OfflineCatalogueRecord, OfflineCustomerRecord, OfflineReadSnapshot, OfflineSerializedInventoryRecord, OfflineSupplierRecord } from "@/lib/offline/types";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const offlineReadRoles = new Set(["MANAGER", "STAFF"]);

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("Invalid read projection.");
  return value;
}

function numberValue(value: unknown, nullable = false) {
  if (value === null && nullable) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid read projection.");
  return number;
}

function catalogueRecord(row: Record<string, unknown>): OfflineCatalogueRecord {
  return {
    productId: requiredString(row.product_id), productName: requiredString(row.product_name), productSku: requiredString(row.product_sku), productBarcode: nullableString(row.product_barcode),
    brandName: nullableString(row.brand_name), categoryName: nullableString(row.category_name), serialized: false,
    variantId: nullableString(row.variant_id), variantLabel: nullableString(row.variant_label), variantSku: nullableString(row.variant_sku), variantBarcode: nullableString(row.variant_barcode),
    condition: requiredString(row.condition), quantity: numberValue(row.quantity) as number, sellingPrice: numberValue(row.selling_price) as number,
  };
}

function serializedRecord(row: Record<string, unknown>): OfflineSerializedInventoryRecord {
  return {
    unitId: requiredString(row.unit_id), productId: requiredString(row.product_id), productName: requiredString(row.product_name), productSku: requiredString(row.product_sku),
    productBarcode: nullableString(row.product_barcode), productModel: nullableString(row.product_model), brandName: nullableString(row.brand_name), categoryName: nullableString(row.category_name),
    variantId: nullableString(row.variant_id), variantLabel: nullableString(row.variant_label), variantSku: nullableString(row.variant_sku), variantBarcode: nullableString(row.variant_barcode),
    condition: requiredString(row.condition), status: requiredString(row.status), sellingPrice: numberValue(row.selling_price, true) as number | null,
    identifierType: requiredString(row.identifier_type), identifierValue: requiredString(row.identifier_value),
  };
}

function customerRecord(row: Record<string, unknown>): OfflineCustomerRecord {
  return { customerId: requiredString(row.customer_id), fullName: requiredString(row.full_name), phone: nullableString(row.phone), email: nullableString(row.email), customerVersion: requiredString(row.customer_version) };
}

function supplierRecord(row: Record<string, unknown>): OfflineSupplierRecord {
  if (typeof row.active !== "boolean") throw new Error("Invalid read projection.");
  return { supplierId: requiredString(row.supplier_id), businessName: requiredString(row.business_name), contactName: nullableString(row.contact_name), phone: nullableString(row.phone), email: nullableString(row.email), active: row.active, supplierVersion: requiredString(row.supplier_version) };
}

/** Authenticated, read-only boundary for the encrypted browser cache. No caller-supplied role is accepted. */
export async function GET() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile || !offlineReadRoles.has(profile.role)) return NextResponse.json({ message: "Offline business reads are not available for this profile." }, { status: 403, headers: noStore });

  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ message: "Offline snapshot service is unavailable." }, { status: 503, headers: noStore });

  try {
    const [catalogueResult, serializedResult, customerResult, supplierResult] = await Promise.all([
      supabase.rpc("staff_catalog_lookup", { p_search: null }),
      supabase.rpc("staff_serialized_inventory_snapshot"),
      supabase.rpc("staff_customer_reference_snapshot_v2"),
      profile.role === "MANAGER"
        ? supabase.rpc("manager_supplier_reference_snapshot_v2")
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (catalogueResult.error || serializedResult.error || customerResult.error || supplierResult.error) throw new Error("Read projection failed.");
    const snapshot: OfflineReadSnapshot = {
      capturedAt: new Date().toISOString(),
      catalogue: (catalogueResult.data ?? []).map((row: unknown) => catalogueRecord(row as Record<string, unknown>)),
      serializedInventory: (serializedResult.data ?? []).map((row: unknown) => serializedRecord(row as Record<string, unknown>)),
      customers: (customerResult.data ?? []).map((row: unknown) => customerRecord(row as Record<string, unknown>)),
      suppliers: (supplierResult.data ?? []).map((row: unknown) => supplierRecord(row as Record<string, unknown>)),
    };
    return NextResponse.json(snapshot, { headers: noStore });
  } catch {
    return NextResponse.json({ message: "Offline snapshot service is unavailable." }, { status: 503, headers: noStore });
  }
}
