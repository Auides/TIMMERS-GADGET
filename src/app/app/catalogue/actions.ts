"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CatalogueActionState } from "./action-state";
import { safeCatalogueMutationMessage } from "./catalogue-error-message";
import { priceFormSchema, toCataloguePriceArguments } from "./price-payload";

const managerRoles = new Set(["ADMIN", "MANAGER"]);

function errorState(message: string): CatalogueActionState {
  return { status: "error", message };
}

async function getCatalogueManagerClient() {
  const { user, profile } = await getAuthenticatedProfile();
  if (!user || !profile || profile.id !== user.id || !profile.is_active || !managerRoles.has(profile.role)) {
    return null;
  }

  return createSupabaseServerClient();
}

async function rpc(
  name: string,
  args: Record<string, unknown>,
  success: string,
  productId?: string,
): Promise<CatalogueActionState> {
  try {
    const supabase = await getCatalogueManagerClient();
    if (!supabase) return errorState("Access denied. You do not have permission to manage the catalogue.");

    const { error } = await supabase.rpc(name, args);
    if (error) return errorState(safeCatalogueMutationMessage(error.message, error.code));

    revalidatePath("/app/catalogue");
    if (productId) revalidatePath(`/app/catalogue/${productId}`);
    return { status: "success", message: success };
  } catch (error) {
    return errorState(safeCatalogueMutationMessage(error instanceof Error ? error.message : ""));
  }
}

export async function createCategory(_: CatalogueActionState, formData: FormData) {
  const value = z.string().trim().min(1).max(100).safeParse(formData.get("name"));
  return value.success
    ? rpc("catalogue_create_category", { p_name: value.data }, "Category created successfully.")
    : errorState("Enter a category name.");
}

export async function createBrand(_: CatalogueActionState, formData: FormData) {
  const value = z.string().trim().min(1).max(100).safeParse(formData.get("name"));
  return value.success
    ? rpc("catalogue_create_brand", { p_name: value.data }, "Brand created successfully.")
    : errorState("Enter a brand name.");
}

const productSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1),
  sku: z.string().trim().min(1),
  barcode: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  serialized: z.enum(["true", "false"]),
  minimumStock: z.coerce.number().int().min(0),
  warrantyMonths: z.coerce.number().int().min(0).optional(),
});

function productArguments(value: z.infer<typeof productSchema>) {
  return {
    p_name: value.name,
    p_sku: value.sku,
    p_barcode: value.barcode || null,
    p_model: value.model || null,
    p_description: value.description || null,
    p_category: value.categoryId || null,
    p_brand: value.brandId || null,
    p_serialized: value.serialized === "true",
    p_min_stock: value.minimumStock,
    p_warranty: value.warrantyMonths ?? null,
  };
}

export async function createProduct(_: CatalogueActionState, formData: FormData) {
  const value = productSchema.omit({ id: true }).safeParse(Object.fromEntries(formData));
  if (!value.success) return errorState("Check the required product details and try again.");
  return rpc("catalogue_create_product", productArguments(value.data), "Product created successfully.");
}

export async function updateProduct(_: CatalogueActionState, formData: FormData) {
  const value = productSchema.extend({ id: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!value.success) return errorState("Check the product details and try again.");
  return rpc(
    "catalogue_update_product",
    { p_id: value.data.id, ...productArguments(value.data), p_active: true },
    "Product updated successfully.",
    value.data.id,
  );
}

const variantSchema = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  label: z.string().trim().min(1),
  sku: z.string().optional(),
  barcode: z.string().optional(),
});

export async function createVariant(_: CatalogueActionState, formData: FormData) {
  const value = variantSchema.extend({ productId: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!value.success) return errorState("Enter a variant label.");
  return rpc(
    "catalogue_create_variant",
    { p_product: value.data.productId, p_label: value.data.label, p_sku: value.data.sku || null, p_barcode: value.data.barcode || null, p_attributes: {} },
    "Variant created. Configure its price before activation.",
    value.data.productId,
  );
}

export async function activateVariant(_: CatalogueActionState, formData: FormData) {
  const value = variantSchema.extend({ id: z.string().uuid(), productId: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  if (!value.success) return errorState("Check the variant details and try again.");
  return rpc(
    "catalogue_update_variant",
    { p_id: value.data.id, p_label: value.data.label, p_sku: value.data.sku || null, p_barcode: value.data.barcode || null, p_attributes: {}, p_active: true },
    "Variant activated successfully.",
    value.data.productId,
  );
}

export async function setPrice(_: CatalogueActionState, formData: FormData) {
  const value = priceFormSchema.safeParse(Object.fromEntries(formData));
  if (!value.success) return errorState("Enter a valid condition and selling price.");

  return rpc(
    "catalogue_set_price",
    toCataloguePriceArguments(value.data),
    "Catalogue price saved successfully.",
    value.data.productId,
  );
}

export async function archiveProduct(_: CatalogueActionState, formData: FormData) {
  const id = z.string().uuid().safeParse(formData.get("id"));
  return id.success
    ? rpc("catalogue_archive_product", { p_id: id.data }, "Product archived successfully.", id.data)
    : errorState("Invalid product.");
}

export async function archiveVariant(_: CatalogueActionState, formData: FormData) {
  const value = z.object({ id: z.string().uuid(), productId: z.string().uuid() }).safeParse(Object.fromEntries(formData));
  return value.success
    ? rpc("catalogue_archive_variant", { p_id: value.data.id }, "Variant archived successfully.", value.data.productId)
    : errorState("Invalid variant.");
}
