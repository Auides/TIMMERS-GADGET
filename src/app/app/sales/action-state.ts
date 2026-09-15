export type SaleCheckoutSuccess = {
  saleId: string;
  saleNumber: number;
  finalTotal: number;
  paymentTotal: number;
};

export type SaleCheckoutResult =
  | { status: "success"; message: string; sale: SaleCheckoutSuccess }
  | { status: "error"; message: string };

export type SerializedSaleUnit = {
  unitId: string;
  productId: string;
  productName: string;
  productSku: string;
  variantId: string | null;
  variantLabel: string | null;
  condition: "NEW" | "USED" | "REFURBISHED";
  sellingPrice: number | null;
  identifierType: string;
  identifierValue: string;
};

export type SerializedSearchResult =
  | { status: "success"; units: SerializedSaleUnit[] }
  | { status: "error"; message: string; units: [] };
