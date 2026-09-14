# Phase 5 — Inventory & Serialized Inventory review

## Proposed migrations

- `20260908194839_inventory_opening_stock.sql` adds `OPENING_STOCK` and `ADJUSTED_OUT` only. It is deliberately isolated so PostgreSQL commits enum values before later functions use them.
- `20260908194908_inventory_opening_stock_operations.sql` adds opening-stock origins, immutable source records, adjustment requests/executions, controlled RPCs, and safe serialized-price lookup.

Neither migration has been applied or pushed.

## Acquisition origins

`serialized_units` will have exactly one immutable origin: the existing `purchase_item_id` or a new `opening_stock_line_id`. Existing purchase-origin validation, linked-unit counting, and purchase-item immutability remain in force. Opening units must instead match their immutable opening line's product, variant, acquisition cost, initial condition, and entered warranty values.

## Opening stock

`inventory_record_opening_stock(request_id, notes, lines)` is atomic and available only to active ADMIN or MANAGER profiles. The request ID is globally unique and paired with a fingerprint of the normalized authoritative payload: trimmed notes, each logical line, and identifiers normalized by the same database helper used by the identifier trigger. Canonical line ordering includes the full canonical identifier set as its deterministic tie-breaker, and identifier arrays are ordered by type/value. Line ordering and identifier-array ordering therefore do not affect idempotency. A replay by the same actor and identical payload returns the same canonical batch-and-lines result with `idempotent_replay = true`; changed logical content is rejected.

The operation locks products in UUID order, then variants, then the exact non-serialized stock bucket. It uses a transaction-scoped advisory lock for the nullable-variant bucket identity. Multiple same-bucket lines with different acquisition costs are allowed. Their incoming quantity and value are aggregated per exact product + optional variant + condition bucket; the bucket is updated once using the unrounded aggregate formula, then rounded to two decimals. Each source line and its own `OPENING_STOCK` movement remain immutable and individually auditable. Every serialized line requires at least one `IMEI_1`, `IMEI_2`, or `SERIAL`; the existing per-unit type uniqueness and global normalized-value uniqueness remain authoritative. Every added quantity creates an immutable `OPENING_STOCK` movement and an audit entry with batch/line IDs, bucket or serialized-unit IDs, condition, quantity, cost, and recorded identifiers.

## Costing and prices

Non-serialized additions calculate weighted average at the exact product + optional variant + condition bucket. Serialized units retain their individual actual acquisition cost. Current selling prices remain sourced from `catalogue_prices`; legacy bucket/unit price snapshots become nullable so opening stock does not need a fabricated selling price.

## Adjustment requests

All active roles may submit a reasoned request. STAFF can read only their own requests; ADMIN and MANAGER can read all. Requests never change stock.

Only active ADMIN users may execute an adjustment, directly or from an open request. A small mutable reservation records the idempotency key while the authoritative product, variant, request, unit or bucket state is locked and resolved. Only then is one final execution row inserted. Execution rows and opening history reject all `UPDATE` and `DELETE` operations. A request-originated retry loads the authoritative request before checking its status: the same actor and same canonical payload replay the existing execution even after `RESOLVED`; a changed payload fails, and a `REJECTED` request with no existing execution cannot proceed.

The execution audit records the complete before/after state: non-serialized bucket ID, quantity, WAC, adjustment quantity and movement-cost snapshot; serialized unit ID, `AVAILABLE` to `ADJUSTED_OUT` state and actual acquisition cost; and `OPEN` to `RESOLVED` request state when request-based. Positive non-serialized adjustments require a non-negative supplied acquisition cost and calculate WAC as `(existing quantity * existing WAC + added quantity * adjustment unit cost) / resulting quantity`; zero-quantity buckets take the new cost directly. Negative non-serialized adjustments retain WAC and reject negative stock.

An ADMIN may reject an `OPEN` request with a mandatory reason. Both execution and rejection lock the same request row before transition, so exactly one terminal outcome wins: `OPEN → RESOLVED` or `OPEN → REJECTED`. Rejection records the reviewing Admin and timestamp, is audited with before/after state, and has no stock effect.

An ADMIN serialized negative adjustment changes only an `AVAILABLE` unit to `ADJUSTED_OUT`, creates an immutable `ADJUSTMENT` movement, and preserves the unit, identifiers, origin, cost, and warranty. `ADJUSTED_OUT` is excluded from Staff operational lookup. Restoration is intentionally deferred to a separate approved ADMIN workflow.

## Security

New source, execution, and internal-reservation tables have RLS enabled. Only ADMIN/MANAGER can directly read cost-bearing opening-stock records. STAFF can read only requests they made; neither STAFF nor MANAGER can execute stock adjustments. There are no direct browser write policies. Internal functions are revoked from `PUBLIC`, `anon`, and `authenticated`; only the opening-stock, request, execution, rejection, and staff-safe lookup RPCs are granted to `authenticated`, with their own active-profile and role checks. The migration fails closed unless Supabase `pgcrypto` and `extensions.digest(bytea,text)` are available; all digest calls are schema-qualified.
