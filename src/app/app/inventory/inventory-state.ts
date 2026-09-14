export type InventoryActionState = { status: string; message: string };

export const inventoryInitialState: InventoryActionState = {
  status: "idle",
  message: "",
};
