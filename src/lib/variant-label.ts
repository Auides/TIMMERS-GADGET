export type VariantLabelParts = {
  label: string;
  sku?: string | null;
  barcode?: string | null;
};

/** Human-readable only: never changes the identifier values submitted by a form. */
const displayValue = (value: string | null | undefined) => value?.trim() || null;

const displayBarcode = (value: string | null | undefined) => {
  const normalized = displayValue(value);

  // A legacy optional-field sentinel is not a scannable barcode.
  return normalized?.toUpperCase() === "OPTIONAL" ? null : normalized;
};

export const formatVariantLabel = ({ label, sku, barcode }: VariantLabelParts) =>
  [displayValue(label), displayValue(sku), displayBarcode(barcode)]
    .filter((value): value is string => value !== null)
    .join(" · ");
