import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migrationsDirectory = join(process.cwd(), "supabase", "migrations");
const migrationName = readdirSync(migrationsDirectory).find((name) =>
  name.endsWith("_staff_serialized_inventory_snapshot.sql"),
);

if (!migrationName) {
  throw new Error("The staff serialized inventory snapshot migration is missing.");
}

const source = readFileSync(join(migrationsDirectory, migrationName), "utf8");

test("staff serialized snapshot preserves the safe lookup projection without a search cap", () => {
  assert.match(source, /create function public\.staff_serialized_inventory_snapshot\(\)/i);
  assert.match(source, /returns table\s*\(/i);
  assert.match(source, /identifier_type public\.identifier_type/i);
  assert.match(source, /identifier_value text/i);
  assert.match(source, /from public\.serialized_units u/i);
  assert.match(source, /join public\.unit_identifiers i on i\.unit_id = u\.id/i);
  assert.match(source, /where u\.status in \('AVAILABLE', 'SOLD', 'RETURN_PENDING'\)/i);
  assert.match(
    source,
    /order by u\.created_at desc, u\.id desc, i\.identifier_type asc, i\.normalized_value asc/i,
  );
  assert.doesNotMatch(source, /\bsearch_text\b/i);
  assert.doesNotMatch(source, /\blimit\s+\d+\b/i);
});

test("staff serialized snapshot is guarded, read-only, and excludes sensitive inventory economics", () => {
  assert.match(source, /security definer/i);
  assert.match(source, /set search_path\s*=\s*public,\s*pg_temp/i);
  assert.match(source, /perform public\.require_active_profile\(\)/i);
  assert.match(
    source,
    /revoke all on function public\.staff_serialized_inventory_snapshot\(\) from public, anon, authenticated/i,
  );
  assert.match(
    source,
    /grant execute on function public\.staff_serialized_inventory_snapshot\(\) to authenticated/i,
  );
  assert.doesNotMatch(source, /\b(acquisition_cost|weighted_average_cost|wac|total_cogs|supplier_id|purchase_id)\b/i);
  assert.doesNotMatch(source, /\b(insert|update|delete|merge|truncate|alter|drop)\b/i);
});
