# Variant inventory and checkout workflow

## Product modes

An active product operates in exactly one selling mode at a time.

- **Base product mode:** when it has no active variants, a base-product price,
  base inventory, and a `NULL` `variant_id` are valid.
- **Variant mode:** once one or more variants are active, the product is the
  parent/model. New inventory and sales must use an active, matching variant.
  Base prices are retained as inactive configuration history and never compete
  with active variant prices.

`catalogue_switch_to_variant_pricing(product, variant)` is the authorised,
atomic transition. It locks the product’s catalogue state, verifies that the
parent is active and the selected variant already has configured prices,
deactivates active base prices, activates only the selected variant and its
existing prices, and writes before/after audit evidence. It does not delete
prices or activate unrelated variants.

## Inventory and identity

IMEI 1, IMEI 2, and serial values identify a physical `serialized_unit`; they
are stored in `unit_identifiers`, not on `product_variants`. A serialized
opening-stock or purchase-receipt line therefore selects product, variant,
condition, acquisition cost, and one or more identifiers for each physical
unit. Warranty is optional.

The authoritative inventory target guard applies to opening stock, purchase
receipt, stock-bucket creation, and serialized-unit creation. In variant mode
it rejects a missing, inactive, or wrong-product variant. In base mode it
permits `NULL`; a supplied variant must still be active and belong to the
product. Offline purchase receipt continues to delegate to this same
authoritative purchase boundary when replayed.

No historical inventory is reassigned. The Manager/Admin-only
`catalogue_variant_mode_legacy_inventory_report()` identifies on-hand,
variant-less buckets and available units for a product that is now in variant
mode. A future reassignment flow must be explicit and audited.

## Sellability and checkout

Inventory creation never fabricates a selling price. A unit is sellable only
when its product is active, its variant is active where variant mode applies,
its status is `AVAILABLE`, and an exact active product + variant + condition
catalogue price exists. Valid inventory that lacks that price is **not
currently priced for sale**.

Checkout uses `staff_sellable_serialized_lookup`, rather than the broader
operational serialized lookup. It searches product name/SKU/barcode, variant
label/SKU/barcode, IMEI 1, IMEI 2, and serial, exposes no acquisition cost,
WAC, COGS, supplier, or valuation data, and returns the physical `unit_id`.
The client displays identifier text only; final checkout supplies the exact
`unit_id`, and the existing transactional finalizer revalidates availability,
product, variant, condition, price, and stock under lock.
