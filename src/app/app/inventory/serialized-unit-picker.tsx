"use client";

import { useActionState, useState } from "react";
import { submitAdjustmentRequest, executeAdjustment } from "./inventory-actions";
import { inventoryInitialState } from "./inventory-state";
import { CameraScanButton } from "./camera-scan";
import { displaySellingPrice } from "./inventory-ui";

type Unit = {
  unit_id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  variant_id?: string | null;
  variant_label?: string | null;
  identifiers: Array<{ identifier_type: string; identifier_value: string }>;
  condition: string;
  status: string;
  selling_price?: number | null;
};

export function SerializedUnitPicker({ units, initialQuery, admin }: { units: Unit[]; initialQuery: string; admin: boolean }) {
  const [state, action] = useActionState(admin ? executeAdjustment : submitAdjustmentRequest, inventoryInitialState);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<Unit | null>(null);

  return <section className="app-panel p-5">
    <h2 className="font-semibold">Serialized unit adjustment</h2>
    <form className="mt-2 flex gap-2">
      <input name="unitSearch" value={query} onChange={(event) => setQuery(event.target.value)} className="min-h-11 flex-1 rounded border p-2" placeholder="IMEI, serial, SKU or barcode" />
      <button className="app-button-secondary px-3">Search</button>
    </form>
    <CameraScanButton onScan={setQuery} />
    {units.filter((unit) => unit.status === "AVAILABLE").map((unit) => <button type="button" onClick={() => setSelected(unit)} key={unit.unit_id} className={`mt-2 w-full rounded border p-3 text-left transition-colors hover:border-[var(--tg-gold)] ${selected?.unit_id === unit.unit_id ? "border-[var(--tg-gold)]" : ""}`}>
      <b>{unit.product_name}{unit.variant_label ? ` — ${unit.variant_label}` : ""}</b>
      <span className="block text-sm">{unit.product_sku} · {unit.identifiers.map((identifier) => `${identifier.identifier_type}: ${identifier.identifier_value}`).join(" · ")} · {unit.condition} · AVAILABLE · {displaySellingPrice(unit.selling_price)}</span>
    </button>)}
    {selected ? <form action={action} className="mt-3">
      <input name="productId" value={selected.product_id} type="hidden" />
      <input name="variantId" value={selected.variant_id ?? ""} type="hidden" />
      <input name="unitId" value={selected.unit_id} type="hidden" />
      <input name="quantity" value="-1" type="hidden" />
      <textarea required name="reason" className="min-h-20 w-full rounded border p-2" placeholder="Mandatory reason" />
      <button className="app-button-primary mt-2 px-3">{admin ? "Adjust selected unit out" : "Request adjustment"}</button>
      <p role="status" className="mt-2 text-sm">{state.status !== "idle" ? state.message : ""}</p>
    </form> : null}
  </section>;
}
