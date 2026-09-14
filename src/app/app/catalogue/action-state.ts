export type CatalogueActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialCatalogueActionState: CatalogueActionState = {
  status: "idle",
  message: "",
};
