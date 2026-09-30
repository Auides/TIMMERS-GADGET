import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const cataloguePage = source("../src/app/app/catalogue/page.tsx");
const inventoryPage = source("../src/app/app/inventory/page.tsx");
const fallback = source("../src/app/offline/offline-normal-read.tsx");
const unlock = source("../src/app/offline/unlock/unlock.tsx");
const serviceWorker = source("../public/sw.js");

test("normal catalogue and inventory preserve their authoritative online paths", () => {
  assert.match(cataloguePage, /createSupabaseServerClient/);
  assert.match(cataloguePage, /staff_catalog_lookup/);
  assert.match(cataloguePage, /OfflineNormalRouteFallback mode="catalogue"/);
  assert.match(inventoryPage, /createSupabaseServerClient/);
  assert.match(inventoryPage, /managementInventoryRows/);
  assert.match(inventoryPage, /staff_catalog_lookup/);
  assert.match(inventoryPage, /OfflineNormalRouteFallback mode="inventory"/);
});

test("offline normal views use the encrypted in-memory snapshot with distinct locked and empty states", () => {
  assert.match(fallback, /readBusinessCache\(\)/);
  assert.match(fallback, /refreshBusinessCache\(\)/);
  assert.match(fallback, /Offline data is locked\./);
  assert.match(fallback, /No offline data is available on this device\. Connect to the internet and refresh offline data first\./);
  assert.match(fallback, /Last synced:/);
  assert.match(fallback, /Offline data/);
  assert.match(fallback, /Inventory reflects this device's last synchronized state/);
  assert.match(fallback, /identifierValue/);
  assert.doesNotMatch(fallback, /localStorage|sessionStorage|outbox/i);
});

test("offline fallback retains local search and makes every mutation unavailable", () => {
  assert.match(fallback, /Product, SKU, IMEI or serial/);
  assert.match(fallback, /Product, SKU or barcode/);
  assert.match(fallback, /Catalogue changes, prices, and archive actions require an internet connection\./);
  assert.match(fallback, /Opening stock, adjustment requests, direct adjustments, serialized adjustments, and every inventory write require an internet connection\./);
  assert.doesNotMatch(fallback, /enqueue|enqueueOutbox|outbox/i);
});

test("safe routes receive offline fallback without caching authenticated application HTML", () => {
  assert.match(serviceWorker, /"\/app\/catalogue": "\/offline\/catalogue"/);
  assert.match(serviceWorker, /"\/app\/inventory": "\/offline\/inventory"/);
  assert.match(serviceWorker, /"\/offline\/catalogue"/);
  assert.match(serviceWorker, /"\/offline\/inventory"/);
  assert.match(serviceWorker, /LOCAL_OFFLINE_ROUTES\.includes\(url\.pathname\)/);
  assert.doesNotMatch(serviceWorker, /LOCAL_OFFLINE_ROUTES = \[[^\]]+"\/app\//);
  assert.doesNotMatch(serviceWorker, /api\/offline\/read-snapshot/);
});

test("unlock returns only to an allow-listed normal or offline read route", () => {
  assert.match(unlock, /getSafeReturnTo/);
  assert.match(unlock, /"\/offline\/customers"/);
  assert.match(unlock, /"\/offline\/suppliers"/);
  assert.match(unlock, /"\/app\/suppliers"/);
  assert.match(unlock, /router\.replace\(getSafeReturnTo\(\)\)/);
});
