# Gate 2 — final foundational review

Status: **PASSED — Database/Security foundation approved and live-verified in development.**

Gate 2 live verification confirmed migration history, schema objects, RLS, policies, constraints, indexes, triggers, role boundaries, Admin bootstrap, and the approved integrity protections. The approved foundation migration is immutable after deployment; future changes must use new migrations.

## Changes made

1. `stock_balances` is replaced by `stock_buckets`, which has its own ID and an expression uniqueness index. It supports a NULL base-product variant without making `variant_id` part of a nullable primary key.
2. Cost remains exclusively on restricted base tables. Products do not carry average cost. Staff cannot select stock buckets, serialized units, inventory movements, purchases, purchase items, suppliers, or audit logs.
3. Weighted-average cost is held per non-serialized product/base-or-variant/condition bucket. Serialized stock holds one actual acquisition cost per unit.
4. `unit_identifiers` normalizes identifiers and makes each IMEI/serial value globally unique, regardless of slot. It prevents duplicate slots or values within a unit.
5. Composite product/variant FKs prevent a variant from being attached to the wrong product. Unit origin and movement target relationships receive further trigger validation.
6. Current sellable condition is authoritative on `stock_buckets` for quantity stock and `serialized_units` for serialized stock. Immutable movements retain before/after condition history.
7. `serialized_units` has no redundant product-type column. Its database trigger reads the referenced product and rejects any product where `serialized` is not true. The reverse tracking-mode trigger prevents changing a product between serialized and non-serialized after stock, units, or inventory history exists. `purchase_item_id` and acquisition cost are immutable, and must match the linked purchase item. The purchase-item trigger also freezes its purchase, product, variant, quantity, and unit cost once a serialized unit references it. A row lock plus count check prevents registering more serialized units than its purchase quantity. The later purchase-completion RPC must require the final unit count to equal the purchased quantity.
8. Product variants have optional, normalized, unique SKU and barcode fields. A trigger prevents identifier collision with parent product identifiers, letting scanner lookup resolve a real sellable variant.
9. Staff product lookup now returns safe brand/category information and product/variant sell prices, but no cost.
10. `VOID` is removed; no approved workflow needs it.
11. Added high-value indexes for unit purchase origin, customer phone, product full-text search, purchase date, and existing FK/report paths. Added timestamp, normalization, immutability, and serialized ±1 safeguards.

## Security model

Staff operational data is exposed only through three explicit Supabase RPCs:

- `staff_catalog_lookup()`
- `staff_serialized_lookup()`
- `staff_customer_lookup(search_text)`

They are `SECURITY DEFINER` functions with a fixed `search_path`; every call invokes `require_active_profile()`. That function rejects unauthenticated, unprovisioned, and disabled users before the lookup executes. Execute is revoked from `PUBLIC` and granted only to `authenticated`—but authenticated alone is insufficient because the active-profile check is mandatory. `staff_serialized_lookup(search_text)` requires a non-empty identifier or product search and returns at most 50 matching units with safe product, brand, category, variant, condition, status, price, IMEI/serial data—never acquisition cost.

This avoids relying on PostgreSQL owner-executed view semantics, which can otherwise bypass base-table RLS. Staff has no base-table SELECT policies for catalogue, costs, serialized units, purchases, suppliers, audit logs, or customers. The customer RPC returns only ID, name, phone, and email and limits search results to 50. Admin and Manager retain RLS SELECT policies for full customer and operational base-table data; only Admin reads audit logs.

No browser-facing mutation policies exist. Future transactional RPCs must perform permission, state, idempotency, audit, and concurrency validation atomically.

## Costing and condition model

A serialized unit purchased for ₦450,000 has acquisition cost ₦450,000 and must point to a purchase item whose unit cost is exactly ₦450,000. That origin and cost cannot be updated normally, nor can the linked purchase item's purchase/product/variant/quantity/cost fields. A row-level purchase-item lock serializes concurrent registrations, and its count check prevents a sixth unit on a quantity-five line. A price correction is deferred to an audited reversal/correction workflow.

For non-serialized stock, a NEW 128 GB variant with two units at ₦100,000 and three received at ₦130,000 gets weighted cost `(2 × 100,000 + 3 × 130,000) / 5 = ₦118,000`. A different variant or USED/REFURBISHED condition has a separate bucket.

Returns will later drive `NEW → SOLD → RETURN_PENDING → USED/REFURBISHED + AVAILABLE` after Admin approval. They create inventory history and never restore a return to NEW; no historical condition is rewritten.

## Bootstrap

The first Admin is provisioned through a one-time, tightly controlled server-side process using the Supabase service role or Supabase dashboard: create the Auth account and insert its `profiles` row as `ADMIN`. The service-role secret never enters browser code.

Later employees are created/invited through an Admin-only server endpoint/RPC. It writes a profile as STAFF unless an authorized Admin intentionally assigns MANAGER or ADMIN. Ordinary users have no profile insert/update policy and cannot elevate themselves.

## Remaining requirements

Deferred to subsequent migrations/RPCs: catalogue and purchase write workflows; stock/cost calculation; sales; payments and split payments; discount approval; customer credit and repayment; returns and Admin review; reclassification; refunds; exchanges; expenses; reports; sale reversal; audit writes; scanning UI; PWA/offline handling; and database integration/security/concurrency tests.

## Tests

Static checks reviewed: active-profile guard on every Staff lookup RPC; no Staff customer base-table policy; restricted cost-table policies; two-way tracking-mode protection; immutable unit and linked purchase-item acquisition facts; serialized-unit count protection; purchase-cost equality; normalized non-empty product barcodes; SKU/barcode advisory locks across product/variant creation; parameterized scanner lookup fields; and added index coverage.

`npm run lint` and the production build are run after this revision. PostgreSQL/Supabase execution, role impersonation, and RPC concurrency tests remain pending an approved disposable Supabase test project; no migration was applied.

## Decisions required

None. Gate 2 approval is required before applying the migration.
