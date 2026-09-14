export type CatalogueStatus = "active" | "archived" | "all";

export function catalogueStatus(value?: string): CatalogueStatus {
  return value === "archived" || value === "all" ? value : "active";
}

export function matchesCatalogueStatus(product: { active: boolean }, status: CatalogueStatus) {
  return status === "all" || (status === "active" ? product.active : !product.active);
}

export function catalogueProductHref(productId: string) {
  return `/app/catalogue/${productId}`;
}
