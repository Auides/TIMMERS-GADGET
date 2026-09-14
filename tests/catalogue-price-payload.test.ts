import assert from "node:assert/strict";
import test from "node:test";
import { canActivateVariant, hasConfiguredVariantPrice, priceFormSchema, toCataloguePriceArguments } from "../src/app/app/catalogue/price-payload.ts";
import { safeCatalogueMutationMessage } from "../src/app/app/catalogue/catalogue-error-message.ts";
import { catalogueProductHref, catalogueStatus, matchesCatalogueStatus } from "../src/app/app/catalogue/catalogue-status.ts";
import { isNavigationCurrent } from "../src/app/app/app-shell-navigation.ts";

const productId = "11111111-1111-4111-8111-111111111111";
const variantId = "22222222-2222-4222-8222-222222222222";

test("a selected variant UUID remains the catalogue price variant payload", () => {
  const parsed = priceFormSchema.parse({ productId, variantId, condition: "NEW", price: "500000", active: "false" });
  assert.deepEqual(toCataloguePriceArguments(parsed), {
    p_product: productId,
    p_variant: variantId,
    p_condition: "NEW",
    p_price: 500000,
    p_active: false,
  });
});

test("only an empty variant selection becomes a base-product price", () => {
  const parsed = priceFormSchema.parse({ productId, variantId: "", condition: "NEW", price: "500000", active: "true" });
  assert.equal(toCataloguePriceArguments(parsed).p_variant, null);
});

test("an inactive variant becomes activation-ready only after its own price exists", () => {
  assert.equal(hasConfiguredVariantPrice([{ variant_id: null }], variantId), false);
  assert.equal(hasConfiguredVariantPrice([{ variant_id: variantId }], variantId), true);
});

test("an archived parent makes an otherwise configured inactive variant unavailable for activation", () => {
  assert.equal(canActivateVariant(false, [{ variant_id: variantId }], variantId), false);
  assert.equal(canActivateVariant(true, [{ variant_id: variantId }], variantId), true);
});

test("the archived-parent variant rule receives a safe business message", () => {
  assert.equal(
    safeCatalogueMutationMessage("An active variant requires an active parent product"),
    "Variants cannot be activated while the parent product is archived.",
  );
  assert.equal(safeCatalogueMutationMessage("products_sku_key"), "A product with this SKU already exists.");
});

test("management catalogue status filters separate active, archived, and all products", () => {
  const active = { active: true };
  const archived = { active: false };
  assert.equal(catalogueStatus(), "active");
  assert.equal(matchesCatalogueStatus(active, "active"), true);
  assert.equal(matchesCatalogueStatus(archived, "active"), false);
  assert.equal(matchesCatalogueStatus(active, "archived"), false);
  assert.equal(matchesCatalogueStatus(archived, "archived"), true);
  assert.equal(matchesCatalogueStatus(active, "all"), true);
  assert.equal(matchesCatalogueStatus(archived, "all"), true);
});

test("an archived product has normal detail navigation without exposing a UUID workflow", () => {
  assert.equal(catalogueProductHref(productId), `/app/catalogue/${productId}`);
});

test("sidebar navigation keeps catalogue active for its detail pages", () => {
  assert.equal(isNavigationCurrent("/app/catalogue", "/app/catalogue"), true);
  assert.equal(isNavigationCurrent(`/app/catalogue/${productId}`, "/app/catalogue"), true);
  assert.equal(isNavigationCurrent("/app/catalogue", "/app", true), false);
});
