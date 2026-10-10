import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261010140321_phase7_variant_inventory_checkout_alignment.sql", import.meta.url), "utf8");
const catalogueActions = readFileSync(new URL("../src/app/app/catalogue/actions.ts", import.meta.url), "utf8");
const catalogueErrors = readFileSync(new URL("../src/app/app/catalogue/catalogue-error-message.ts", import.meta.url), "utf8");
const openingStock = readFileSync(new URL("../src/app/app/inventory/inventory-forms.tsx", import.meta.url), "utf8");
const inventoryActions = readFileSync(new URL("../src/app/app/inventory/inventory-actions.ts", import.meta.url), "utf8");
const openingStockPage = readFileSync(new URL("../src/app/app/inventory/opening-stock/page.tsx", import.meta.url), "utf8");
const salesActions = readFileSync(new URL("../src/app/app/sales/actions.ts", import.meta.url), "utf8");
const checkout = readFileSync(new URL("../src/app/app/sales/new/checkout-form.tsx", import.meta.url), "utf8");

test("inventory creation rejects a null target only when active variants exist", () => {
  assert.match(migration, /function public\.inventory_assert_variant_target/);
  assert.match(migration, /p_variant_id is null[\s\S]*product_variants pv[\s\S]*pv\.active[\s\S]*VARIANT_REQUIRED/);
  assert.match(migration, /VARIANT_PRODUCT_MISMATCH/);
  assert.match(migration, /VARIANT_INACTIVE/);
  assert.match(migration, /opening_stock_lines_variant_target/);
  assert.match(migration, /purchase_items_variant_target/);
  assert.match(migration, /stock_buckets_variant_target/);
  assert.match(migration, /serialized_units_variant_target/);
});

test("atomic variant-pricing switch preserves base price history and activates only the chosen variant", () => {
  assert.match(migration, /function public\.catalogue_switch_to_variant_pricing/);
  assert.match(migration, /VARIANT_PRICE_REQUIRED/);
  assert.match(migration, /variant_id is null[\s\S]*and active/);
  assert.match(migration, /where id = p_variant_id[\s\S]*returning \* into v_variant_after/);
  assert.match(migration, /variant_id = p_variant_id[\s\S]*and not active/);
  assert.match(migration, /CATALOGUE_VARIANT_PRICING_SWITCHED/);
  assert.match(catalogueActions, /catalogue_switch_to_variant_pricing/);
  assert.match(catalogueErrors, /Base-product pricing must be disabled before variant pricing can be activated/);
});

test("opening stock shows and submits only the active variant target when a product is in variant mode", () => {
  assert.match(openingStockPage, /product_variants[\s\S]*eq\("active", true\)/);
  assert.match(openingStock, /const variantMode = activeVariants\.length > 0/);
  assert.match(openingStock, /select required name="variantId"/);
  assert.match(openingStock, /disabled=\{!productId \|\| \(variantMode && !variantId\)\}/);
  assert.match(openingStock, /Identifiers belong to this physical unit, not its variant/);
  assert.match(inventoryActions, /Acquisition cost is required/);
  assert.match(inventoryActions, /Acquisition cost cannot be negative/);
  assert.match(inventoryActions, /Serialized stock requires at least one IMEI or serial number/);
});

test("serialized checkout has a narrow sellable, cost-safe discovery boundary", () => {
  assert.match(migration, /function public\.staff_sellable_serialized_lookup/);
  assert.match(migration, /u\.status = 'AVAILABLE'/);
  assert.match(migration, /cp\.active/);
  assert.match(migration, /v\.active/);
  assert.match(migration, /v\.label ilike/);
  assert.doesNotMatch(migration.slice(migration.indexOf("staff_sellable_serialized_lookup"), migration.indexOf("catalogue_variant_mode_legacy_inventory_report")), /acquisition_cost|weighted_average_cost|current_selling_price/);
  assert.match(salesActions, /staff_sellable_serialized_lookup/);
  assert.match(salesActions, /unitId: row\.unit_id/);
  assert.match(checkout, /serializedUnitIds: \[\.\.\.line\.serializedUnitIds, unit\.unitId\]/);
});

test("legacy base inventory is reported rather than reassigned", () => {
  assert.match(migration, /catalogue_variant_mode_legacy_inventory_report/);
  assert.match(migration, /b\.variant_id is null[\s\S]*b\.quantity > 0/);
  assert.match(migration, /u\.variant_id is null[\s\S]*u\.status = 'AVAILABLE'/);
  assert.doesNotMatch(migration, /update public\.(stock_buckets|serialized_units)[\s\S]*variant_id =/i);
});
