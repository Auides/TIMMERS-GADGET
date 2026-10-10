"use client";

import { useActionState, useMemo, useState } from "react";
import { executeAdjustment, recordOpeningStock, rejectAdjustment, submitAdjustmentRequest } from "./inventory-actions";
import { inventoryInitialState } from "./inventory-state";
import { CameraScanButton } from "./camera-scan";
import { newInventorySubmissionKey } from "./inventory-ui";
import { formatVariantLabel } from "@/lib/variant-label";

type Product = { id: string; name: string; sku: string; barcode?: string | null; serialized?: boolean };
type Variant = { id: string; product_id: string; label: string; sku?: string | null; barcode?: string | null };

const Feedback = ({ state }: { state: typeof inventoryInitialState }) => state.status === "idle" ? null : <p role="status" className={`mt-2 text-sm ${state.status === "success" ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>;
const Field = ({ name, placeholder, type = "text", required = false, value, onChange }: { name: string; placeholder: string; type?: string; required?: boolean; value?: string; onChange?: (value: string) => void }) => <input required={required} name={name} type={type} value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} placeholder={placeholder} className="mt-2 min-h-11 w-full rounded border p-2"/>;

export function OpeningStockForm({ products, variants = [] }: { products: Product[]; variants?: Variant[] }) {
  const [state, action] = useActionState(recordOpeningStock, inventoryInitialState);
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [key] = useState(newInventorySubmissionKey);
  const [imei1, setImei1] = useState("");
  const selected = products.find((product) => product.id === productId);
  const serialized = selected?.serialized ?? false;
  const activeVariants = useMemo(() => variants.filter((variant) => variant.product_id === productId), [productId, variants]);
  const variantMode = activeVariants.length > 0;

  return <form action={action} className="app-panel p-5">
    <h2 className="font-semibold">Record opening stock</h2><p className="mt-1 text-sm text-slate-600">One logical line per submission. Product tracking determines the entry fields.</p>
    <input name="requestId" type="hidden" value={key}/>
    <select required name="productId" value={productId} onChange={(event) => { setProductId(event.target.value); setVariantId(""); }} className="mt-3 min-h-11 w-full rounded border p-2"><option value="">Select active product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select>
    {variantMode ? <><select required name="variantId" value={variantId} onChange={(event) => setVariantId(event.target.value)} className="mt-2 min-h-11 w-full rounded border p-2"><option value="">Select active variant</option>{activeVariants.map((variant) => <option key={variant.id} value={variant.id}>{formatVariantLabel(variant)}</option>)}</select><p className="mt-2 text-sm text-slate-600">Variant mode: a matching active variant is required for new inventory.</p></> : <input name="variantId" type="hidden" value=""/>}
    <input name="serialized" type="hidden" value={String(serialized)}/><p className="mt-2 text-sm text-slate-600">{selected ? `Tracking: ${serialized ? "Serialized unit" : "Non-serialized"}` : "Select a product to determine tracking mode."}</p>
    <select name="condition" className="mt-2 min-h-11 w-full rounded border p-2"><option>NEW</option><option>USED</option><option>REFURBISHED</option></select>
    {serialized ? <><input name="quantity" type="hidden" value="1"/><p className="mt-2 text-sm text-slate-600">Quantity: 1 serialized unit</p></> : <Field name="quantity" type="number" required placeholder="Quantity"/>}
    <Field name="cost" type="number" required placeholder="Acquisition unit cost"/>
    {serialized ? <><Field name="imei1" value={imei1} onChange={setImei1} placeholder="IMEI 1"/><CameraScanButton onScan={setImei1}/><Field name="imei2" placeholder="IMEI 2"/><Field name="serial" placeholder="Serial identifier"/><p className="mt-2 text-xs text-slate-600">Enter at least one IMEI or serial number. Identifiers belong to this physical unit, not its variant.</p><label className="mt-3 block text-sm font-medium">Warranty start<Field name="warrantyStart" type="date" placeholder=""/></label><label className="mt-3 block text-sm font-medium">Warranty expiry<Field name="warrantyExpiry" type="date" placeholder=""/></label></> : null}
    <textarea name="notes" className="mt-2 min-h-20 w-full rounded border p-2" placeholder="Notes (optional)"/><button disabled={!productId || (variantMode && !variantId)} className="app-button-primary mt-3 px-4">Record opening stock</button><Feedback state={state}/>
  </form>;
}

export function AdjustmentForm({ products, variants = [], admin }: { products: Product[]; variants?: Variant[]; admin: boolean }) {
  const [state, action] = useActionState(admin ? executeAdjustment : submitAdjustmentRequest, inventoryInitialState);
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const activeVariants = variants.filter((variant) => variant.product_id === productId);
  return <form action={action} className="app-panel p-5"><h2 className="font-semibold">{admin ? "Direct inventory adjustment" : "Request an adjustment"}</h2><select required name="productId" value={productId} onChange={(event) => { setProductId(event.target.value); setVariantId(""); }} className="mt-3 min-h-11 w-full rounded border p-2"><option value="">Select product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select>{activeVariants.length ? <select name="variantId" value={variantId} onChange={(event) => setVariantId(event.target.value)} className="mt-2 min-h-11 w-full rounded border p-2"><option value="">Select variant</option>{activeVariants.map((variant) => <option key={variant.id} value={variant.id}>{formatVariantLabel(variant)}</option>)}</select> : <input name="variantId" type="hidden" value=""/>}<select name="condition" className="mt-2 min-h-11 w-full rounded border p-2"><option>NEW</option><option>USED</option><option>REFURBISHED</option></select><Field name="quantity" type="number" required placeholder="Signed quantity"/>{admin ? <Field name="unitCost" type="number" placeholder="Acquisition cost (positive only)"/> : null}<textarea required name="reason" className="mt-2 min-h-20 w-full rounded border p-2" placeholder="Mandatory reason"/><button className="app-button-primary mt-3 px-4">{admin ? "Execute adjustment" : "Submit request"}</button><Feedback state={state}/></form>;
}

export function RequestControls({ id, productId, variantId, unitId, condition, quantity, reason }: { id: string; productId: string; variantId?: string | null; unitId?: string | null; condition?: string | null; quantity: number; reason: string }) {
  const [state, execute] = useActionState(executeAdjustment, inventoryInitialState);
  const [rejection, reject] = useActionState(rejectAdjustment, inventoryInitialState);
  const [key] = useState(newInventorySubmissionKey);
  const requiresCost=!unitId&&quantity>0;
  return <div className="mt-2 flex flex-wrap gap-2"><form action={execute} className="flex flex-wrap items-center gap-2"><input name="adjustmentRequestId" value={id} type="hidden"/><input name="requestId" value={key} type="hidden"/><input name="productId" value={productId} type="hidden"/><input name="variantId" value={variantId ?? ""} type="hidden"/><input name="unitId" value={unitId ?? ""} type="hidden"/><input name="condition" value={condition ?? ""} type="hidden"/><input name="quantity" value={quantity} type="hidden"/><input name="reason" value={reason} type="hidden"/>{requiresCost ? <input required min="0" step="0.01" name="unitCost" type="number" className="rounded border p-2 text-sm" placeholder="Acquisition cost" aria-label="Acquisition cost"/> : null}<button className="app-button-primary px-3 text-sm">Execute</button></form><form action={reject} className="flex gap-2"><input name="id" value={id} type="hidden"/><input required name="reason" className="rounded border p-2 text-sm" placeholder="Rejection reason"/><button className="app-button-secondary px-3 text-sm">Reject</button></form><Feedback state={state}/><Feedback state={rejection}/></div>;
}
