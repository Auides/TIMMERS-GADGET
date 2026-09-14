export function safeCatalogueMutationMessage(message: string, code?: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("catalogue authority") ||
    normalized.includes("active timmers gadget profile") ||
    normalized.includes("permission denied") ||
    code === "42501"
  ) {
    return "Access denied. You do not have permission to manage the catalogue.";
  }
  if (normalized.includes("products_sku_key")) return "A product with this SKU already exists.";
  if (normalized.includes("variants_sku_key") || normalized.includes("sku conflicts")) {
    return "A product or variant with this SKU already exists.";
  }
  if (normalized.includes("barcode")) return "A product or variant with this barcode already exists.";
  if (normalized.includes("tracking mode")) return "Tracking mode cannot be changed after inventory or history exists.";
  if (normalized.includes("archived products require") || normalized.includes("archived product")) {
    return "This product is archived and cannot be edited or reactivated here.";
  }
  if (normalized.includes("active variant requires an active parent product") || normalized.includes("active variant requires active parent product")) {
    return "Variants cannot be activated while the parent product is archived.";
  }
  if (normalized.includes("active variant price requires an active matching variant")) {
    return "Save a price inactive while the variant is inactive, then activate the variant.";
  }
  if (normalized.includes("configure a variant-specific price before activating a variant")) {
    return "Configure at least one variant-specific price before activating this variant.";
  }
  if (normalized.includes("product-level prices are not permitted while active variants exist")) {
    return "Product-level prices cannot be active while this product has active variants.";
  }
  if (normalized.includes("archive the variant to remove its final active price")) {
    return "Archive the variant instead of removing its final active price.";
  }
  if (normalized.includes("variant does not belong to product")) return "The selected variant does not belong to this product.";
  if (normalized.includes("active category")) return "Select an active category.";
  if (normalized.includes("active brand")) return "Select an active brand.";

  return "Something went wrong. Please try again.";
}
