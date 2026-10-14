import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261013213939_phase7be_grouped_serialized_unit_lookups.sql", import.meta.url), "utf8");
const genericLookup = readFileSync(new URL("../src/app/app/inventory/serialized/page.tsx", import.meta.url), "utf8");
const adjustmentPicker = readFileSync(new URL("../src/app/app/inventory/serialized-unit-picker.tsx", import.meta.url), "utf8");
const salesActions = readFileSync(new URL("../src/app/app/sales/actions.ts", import.meta.url), "utf8");
const checkout = readFileSync(new URL("../src/app/app/sales/new/checkout-form.tsx", import.meta.url), "utf8");
const snapshotRoute = readFileSync(new URL("../src/app/api/offline/read-snapshot/route.ts", import.meta.url), "utf8");
const offlineInventory = readFileSync(new URL("../src/app/offline/offline-normal-read.tsx", import.meta.url), "utf8");
const offlineCheckout = readFileSync(new URL("../src/app/offline/offline-sale-checkout.tsx", import.meta.url), "utf8");

test("v2 serialized projections establish a unit-level cardinality boundary before ordering and limits", () => {
  for (const name of ["staff_serialized_lookup_v2", "staff_sellable_serialized_lookup_v2", "staff_serialized_inventory_snapshot_v2", "staff_offline_sellable_serialized_snapshot_v2"]) {
    const start = migration.indexOf(`function public.${name}`);
    assert.ok(start >= 0, `${name} is present`);
    const source = migration.slice(start, migration.indexOf("$$;", start));
    assert.match(source, /cross join lateral[\s\S]*jsonb_agg[\s\S]*identifier_type[\s\S]*identifier_value/i);
    assert.doesNotMatch(source, /join public\.unit_identifiers i on i\.unit_id = u\.id/i);
    assert.match(source, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/i);
  }
  const generic = migration.slice(migration.indexOf("function public.staff_serialized_lookup_v2"), migration.indexOf("function public.staff_sellable_serialized_lookup_v2"));
  assert.match(generic, /exists \([\s\S]*search_identifier\.unit_id = u\.id/);
  assert.match(generic, /order by u\.created_at desc, u\.id desc[\s\S]*limit 50/i);
});

test("all generic, adjustment, and checkout lookups consume one grouped unit record", () => {
  assert.match(genericLookup, /staff_serialized_lookup_v2/);
  assert.match(genericLookup, /key=\{unit\.unit_id\}/);
  assert.match(adjustmentPicker, /key=\{unit\.unit_id\}/);
  assert.match(salesActions, /staff_sellable_serialized_lookup_v2/);
  assert.match(salesActions, /row\.identifiers\.map/);
  assert.match(checkout, /identifierLabel\(unit\)/);
  assert.doesNotMatch(salesActions, /new Map<string, SerializedSaleUnit>/);
});

test("encrypted snapshots and offline views retain one unit with nested identifiers and no cost projection", () => {
  assert.match(snapshotRoute, /staff_serialized_inventory_snapshot_v2/);
  assert.match(snapshotRoute, /staff_offline_sellable_serialized_snapshot_v2/);
  assert.match(snapshotRoute, /identifiers: serializedIdentifiers\(row\.identifiers\)/);
  assert.match(offlineInventory, /key=\{record\.unitId\}/);
  assert.match(offlineInventory, /record\.identifiers\.map/);
  assert.match(offlineCheckout, /record\.identifiers\.flatMap/);
  assert.doesNotMatch(migration, /\b(acquisition_cost|weighted_average_cost|wac|total_cogs)\b/i);
});

test("new grouped functions are authenticated-only and remain read-only source", () => {
  for (const name of ["staff_serialized_lookup_v2(text)", "staff_sellable_serialized_lookup_v2(text)", "staff_serialized_inventory_snapshot_v2()", "staff_offline_sellable_serialized_snapshot_v2()"]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name.replace(/[()]/g, "\\$&")} from public, anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name.replace(/[()]/g, "\\$&")} to authenticated`, "i"));
  }
  assert.doesNotMatch(migration, /\b(insert|update|delete|merge|truncate|alter|drop)\b/i);
});
