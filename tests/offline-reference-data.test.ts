import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = source("../supabase/migrations/20260930163023_phase4_offline_customer_supplier_reference_snapshots.sql");
const route = source("../src/app/api/offline/read-snapshot/route.ts");
const cache = source("../src/lib/offline/business-cache.ts");
const fallback = source("../src/app/offline/offline-normal-read.tsx");

test("customer and supplier snapshot boundaries are narrow, active-profile guarded, and not publicly executable", () => {
  assert.match(migration, /staff_customer_reference_snapshot/);
  assert.match(migration, /manager_supplier_reference_snapshot/);
  assert.match(migration, /perform public\.require_active_profile\(\)/);
  assert.match(migration, /current_role\(\) <> 'MANAGER'/);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /returns table\(customer_id uuid, full_name text, phone text, email text\)/);
  assert.match(migration, /returns table\(supplier_id uuid, business_name text, contact_name text, phone text, email text, active boolean\)/);
});

test("server returns no supplier data for staff and maps only permitted reference fields", () => {
  assert.match(route, /profile\.role === "MANAGER"/);
  assert.match(route, /Promise\.resolve\(\{ data: \[\], error: null \}\)/);
  assert.match(route, /staff_customer_reference_snapshot/);
  assert.match(route, /manager_supplier_reference_snapshot/);
  assert.doesNotMatch(route, /credit|debt|payment|purchase|cost|profit|margin|notes/i);
});

test("reference records join the same encrypted atomic, user-and-device-scoped snapshot", () => {
  assert.match(cache, /encryptedRecord\(identity, "customers"/);
  assert.match(cache, /encryptedRecord\(identity, "suppliers"/);
  assert.match(cache, /offlineBusinessCacheContext\(identity\.userId, identity\.deviceId, resource\)/);
  assert.match(cache, /replaceOfflineBusinessCache/);
  assert.doesNotMatch(cache, /localStorage|sessionStorage|outbox/i);
});

test("offline reference UI searches only unlocked in-memory data and limits mutations to approved encrypted safeguards", () => {
  assert.match(fallback, /record\.fullName, record\.phone, record\.email/);
  assert.match(fallback, /record\.businessName, record\.contactName, record\.phone, record\.email/);
  assert.match(fallback, /Add customer offline/);
  assert.match(fallback, /Pending synchronization/);
  assert.match(fallback, /Edit offline/);
  assert.match(fallback, /Authoritative cached record/);
  assert.match(fallback, /Needs review after reconnect/);
  assert.match(fallback, /editing is unavailable until it is confirmed/);
  assert.match(fallback, /Add supplier offline/);
  assert.match(fallback, /Supplier updates, purchases, payments, refunds, and all procurement writes require an internet connection\./);
  assert.match(fallback, /Offline data is locked\./);
  assert.doesNotMatch(fallback, /enqueue|outbox/i);
});
