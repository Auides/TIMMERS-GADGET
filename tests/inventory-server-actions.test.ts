import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const staffRequestContextMigration = readFileSync(
  new URL("../supabase/migrations/20260910000243_staff_inventory_adjustment_request_context.sql", import.meta.url),
  "utf8",
);

test("inventory server-action module exports only async actions", () => {
  const source = readFileSync(new URL("../src/app/app/inventory/inventory-actions.ts", import.meta.url), "utf8");
  assert.equal(source.includes("export const inventoryInitialState"), false);
  assert.equal(source.includes("export type InventoryActionState"), false);
  assert.match(source, /export async function submitAdjustmentRequest/);
  assert.match(source, /export async function executeAdjustment/);
  assert.match(source, /export async function rejectAdjustment/);
  assert.match(source, /export async function recordOpeningStock/);
  assert.match(source, /"Adjustment request submitted\.", "requester"/);
  assert.match(source, /required === "adjustment-admin" && !canExecuteOrRejectAdjustment\(profile\.role\)/);
  assert.match(source, /"Adjustment request rejected\.", "adjustment-admin"/);
  assert.match(source, /"Inventory adjustment executed\.", "adjustment-admin"/);
  assert.match(source, /form\.get\("unitCost"\)/);
  assert.match(source, /p_unit_cost: adjustmentUnitCostRpcValue\(v\.unitId, v\.quantity, unitCost\)/);
  assert.match(source, /const supabase = await createSupabaseServerClient\(\);/);
  assert.match(source, /return \{ profile, supabase \};/);
});

test("serialized adjustment picker uses the shared nullable price formatter", () => {
  const source = readFileSync(new URL("../src/app/app/inventory/serialized-unit-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ displaySellingPrice \} from "\.\/inventory-ui"/);
  assert.match(source, /displaySellingPrice\(u\.selling_price\)/);
  assert.equal(source.includes("selling_price??0"), false);
});

test("staff adjustment requests use the dedicated safe request-context RPC", () => {
  const source = readFileSync(new URL("../src/app/app/inventory/adjustments/page.tsx", import.meta.url), "utf8");
  const staffBranch = source.slice(source.indexOf("} else if (supabase && staff)"));
  assert.match(source, /supabase\.rpc\("staff_catalog_lookup", \{ p_search: null \}\)/);
  assert.match(source, /profile\.role === "STAFF"/);
  assert.match(source, /const staffContextPromise = supabase && staff/);
  assert.match(source, /supabase\.rpc\("staff_inventory_adjustment_request_context"\)/);
  assert.match(staffBranch, /staffAdjustmentRequestContextById\(contextResult\.data \?\? \[\]\)/);
  assert.match(staffBranch, /staffContext: contextByRequestId\.get\(request\.id\) \?\? null/);
  assert.match(source, /staffRequestIdentifierLabels\(context\?\.identifiers/);
  assert.match(source, /context\?\.product_name\?\?"Inventory item"/);
  assert.equal(source.includes("staffAdjustmentRequestDisplay"), false);
  assert.equal(source.includes("weighted_average_cost"), false);
  assert.equal(source.includes("acquisition_cost"), false);
});

test("staff adjustment request context RPC is owned, historical, and cost-safe", () => {
  assert.match(staffRequestContextMigration, /create function public\.staff_inventory_adjustment_request_context\(\)/);
  assert.match(staffRequestContextMigration, /security definer\s+set search_path = pg_catalog, pg_temp/);
  assert.match(staffRequestContextMigration, /perform public\.require_active_profile\(\)/);
  assert.match(staffRequestContextMigration, /profile\.role = 'STAFF'::public\.app_role/);
  assert.match(staffRequestContextMigration, /request\.requested_by = auth\.uid\(\)/);
  assert.match(staffRequestContextMigration, /'type', identifier\.identifier_type::text/);
  assert.match(staffRequestContextMigration, /'value', identifier\.normalized_value/);
  assert.match(staffRequestContextMigration, /when 'IMEI_1' then 1[\s\S]*when 'IMEI_2' then 2[\s\S]*when 'SERIAL' then 3/);
  assert.equal(staffRequestContextMigration.includes("ADJUSTED_OUT"), false);
  assert.equal(staffRequestContextMigration.includes("product.active"), false);
  assert.equal(staffRequestContextMigration.includes("variant.active"), false);
  assert.equal(staffRequestContextMigration.includes("acquisition_cost"), false);
  assert.equal(staffRequestContextMigration.includes("weighted_average_cost"), false);
  assert.equal(staffRequestContextMigration.includes("purchase_item_id"), false);
  assert.equal(staffRequestContextMigration.includes("insert into"), false);
  assert.equal(staffRequestContextMigration.includes("update public"), false);
  assert.equal(staffRequestContextMigration.includes("delete from"), false);
  assert.match(staffRequestContextMigration, /revoke all on function public\.staff_inventory_adjustment_request_context\(\) from public, anon, authenticated/);
  assert.match(staffRequestContextMigration, /grant execute on function public\.staff_inventory_adjustment_request_context\(\) to authenticated/);
});

test("interactive treatment is centralized and serialized result cards retain hover feedback", () => {
  const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const picker = readFileSync(new URL("../src/app/app/inventory/serialized-unit-picker.tsx", import.meta.url), "utf8");
  const adjustmentForm = readFileSync(new URL("../src/app/app/inventory/inventory-forms.tsx", import.meta.url), "utf8");
  assert.match(styles, /button:not\(:disabled\):not\(\[aria-disabled="true"\]\).*cursor:pointer/);
  assert.match(styles, /a\[href\]:not\(\[aria-disabled="true"\]\).*cursor:pointer/);
  assert.match(styles, /select:not\(:disabled\).*cursor:pointer/);
  assert.match(styles, /button:disabled.*cursor:not-allowed/);
  assert.match(styles, /\.app-button-primary:not\(:disabled\):hover/);
  assert.match(picker, /transition-colors hover:border-\[var\(--tg-gold\)\]/);
  assert.match(adjustmentForm, /formatVariantLabel\(variant\)/);
});
