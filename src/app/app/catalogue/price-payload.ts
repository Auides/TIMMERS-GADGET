import { z } from "zod";

export const priceFormSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().trim().transform((value) => value === "" ? null : value).pipe(z.string().uuid().nullable()),
  condition: z.enum(["NEW", "USED", "REFURBISHED"]),
  price: z.coerce.number().min(0),
  active: z.enum(["true", "false"]),
});

export type PriceFormValue = z.infer<typeof priceFormSchema>;

export function toCataloguePriceArguments(value: PriceFormValue) {
  return {
    p_product: value.productId,
    p_variant: value.variantId,
    p_condition: value.condition,
    p_price: value.price,
    p_active: value.active === "true",
  };
}

export function hasConfiguredVariantPrice(prices: { variant_id: string | null }[], variantId: string) {
  return prices.some((price) => price.variant_id === variantId);
}

export function canActivateVariant(productIsActive: boolean, prices: { variant_id: string | null }[], variantId: string) {
  return productIsActive && hasConfiguredVariantPrice(prices, variantId);
}
