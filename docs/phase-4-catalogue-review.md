# Phase 4 — Product Catalogue and Inventory Master Data review

Status: **PROPOSED — revised final SQL review. Do not apply until final approval.**

## Scope

The migration implements only catalogue master data: categories, brands, products, variants, archive/deactivation, and condition-aware current selling prices. It creates no stock, units, purchases, movements, sales, payments, or other transactions.

## Concurrency and lifecycle model

All catalogue mutations use row locks in a deterministic order: category/brand where relevant, then product, then variant, then price. Product create/update holds referenced active category/brand rows with `FOR KEY SHARE`, so category/brand deactivation’s `FOR UPDATE` lock cannot race an active product reference. Product archive locks the product before its active variants and prices; variant/price operations lock the parent product first. This serializes the approved parent/child and price invariants without relying only on `exists` checks.

Category/brand deactivation is rejected while an active product references it. Product/variant archival is an approved atomic operation: it locks and deactivates dependent active prices/variants before the parent. Hard deletion is prohibited.

Product archival additionally rejects current on-hand inventory: any non-serialized `stock_buckets.quantity > 0` for the product, or any serialized unit in the existing `AVAILABLE` status, blocks it. Variant archival performs the equivalent check scoped to that variant. Historical movements, sales, and other references are not inspected for this rule. Neither check changes stock or unit state.

Normal product update rejects an inactive product; it cannot silently reactivate it. Reactivation is deliberately deferred to a separate future approved, audited workflow. The product row lock used by update and archive serializes these operations.

## Pricing model

`catalogue_prices` is NULL-safe unique by product, optional variant, and NEW/USED/REFURBISHED condition. It has price only—never quantity or cost.

- A base product may have an active product-level price only if it has no active variants.
- Variants are created inactive. Variant-specific prices are configured first; activation locks the product/variant/prices and requires configured prices, then activates them atomically.
- An active variant retains at least one active variant-specific price. Deactivating its final active price is rejected; the safe variant-archive operation must be used instead.
- Staff catalogue lookup preserves the Gate 2 safe fields, including quantity and selling price, and joins a price only to its exact base-product or variant key. There is no automatic product-price fallback for variants.

## Security and audit

Every mutation RPC is `SECURITY DEFINER` with `search_path = public`. It derives the caller from `auth.uid()`, calls `require_active_profile()`, and then checks ADMIN/MANAGER authority. Disabled and unprovisioned users are denied.

Internal helpers are explicitly revoked from `PUBLIC`, `anon`, and `authenticated`. Only approved mutation RPCs and the active-profile-guarded Staff lookup are executable by `authenticated`. `catalogue_prices` grants browser roles SELECT only; RLS makes that SELECT available to Admin/Manager only. Browser INSERT/UPDATE/DELETE is revoked.

All operations append immutable audit records. Multi-record operations include exact affected child IDs and before/after child state in JSON audit payloads, rather than only counts.

## Foundation compatibility

The approved Gate 2 migration is unchanged. Its product/variant foreign keys, SKU/barcode collision checks, tracking-mode protection, RLS, inventory controls, and no-cost Staff exposure remain authoritative. Product update includes `serialized`, allowing correction only while the existing Gate 2 tracking-mode trigger permits it.

## Tests required after approval

- Concurrent parent deactivation/create-update and product/variant/price race tests
- Active-variant final-price protection and no-fallback pricing tests
- Product/variant archive atomicity and detailed audit payloads
- Active parent/child validation, tracking-mode correction, duplicate identifiers, and product/variant integrity
- RLS/grant checks for Admin, Manager, Staff, and unprovisioned users
- Staff quantity/price lookup without cost exposure
- No stock/movement/unit/purchase effects, plus mobile UI, lint, production build, and live development tests
