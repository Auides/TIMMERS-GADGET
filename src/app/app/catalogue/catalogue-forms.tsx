"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useActionState, useMemo, useState } from "react";
import { activateVariant, archiveProduct, archiveVariant, createBrand, createCategory, createProduct, createVariant, setPrice, updateProduct } from "./actions";
import { initialCatalogueActionState } from "./action-state";
import { canActivateVariant } from "./price-payload";
import { formatVariantLabel } from "@/lib/variant-label";

function Feedback({ state }: { state: typeof initialCatalogueActionState }) {
  if (state.status === "idle") return null;
  return <p role="status" className={`mt-2 text-sm ${state.status === "success" ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>;
}

export function QuickCatalogueForms() {
  const [categoryState, categoryAction] = useActionState(createCategory, initialCatalogueActionState);
  const [brandState, brandAction] = useActionState(createBrand, initialCatalogueActionState);
  return <section className="mt-6 grid gap-4 md:grid-cols-2">
    <form action={categoryAction} className="rounded border bg-white p-4"><b>New category</b><input required className="mt-3 w-full rounded border p-2" name="name"/><button className="mt-2 rounded bg-slate-900 px-3 py-2 text-white">Save</button><Feedback state={categoryState}/></form>
    <form action={brandAction} className="rounded border bg-white p-4"><b>New brand</b><input required className="mt-3 w-full rounded border p-2" name="name"/><button className="mt-2 rounded bg-slate-900 px-3 py-2 text-white">Save</button><Feedback state={brandState}/></form>
  </section>;
}

export function ProductFeedback() {
  const [state, action] = useActionState(createProduct, initialCatalogueActionState);
  return <><button className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white" form="product-form" formAction={action}>Create product</button><Feedback state={state}/></>;
}

export function ProductManagement({ product, variants, prices }: { product: any; variants: any[]; prices: any[] }) {
  const [productState, productAction] = useActionState(updateProduct, initialCatalogueActionState);
  const [variantState, variantAction] = useActionState(createVariant, initialCatalogueActionState);
  const [priceState, priceAction] = useActionState(setPrice, initialCatalogueActionState);
  const [productArchiveState, productArchiveAction] = useActionState(archiveProduct, initialCatalogueActionState);
  const [variantArchiveState, variantArchiveAction] = useActionState(archiveVariant, initialCatalogueActionState);
  const [variantActivationState, variantActivationAction] = useActionState(activateVariant, initialCatalogueActionState);
  const [variantId, setVariantId] = useState("");
  const [priceActive, setPriceActive] = useState("true");
  const selectedVariant = useMemo(() => variants.find((variant) => variant.id === variantId), [variantId, variants]);
  const selectedVariantIsInactive = Boolean(selectedVariant && !selectedVariant.active);
  const hasActiveVariants = variants.some((variant) => variant.active);
  const productIsActive = Boolean(product.active);
  const disabledClass = "disabled:cursor-not-allowed disabled:opacity-50";

  return <div className="space-y-5">
    {!productIsActive ? <p role="status" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">This product is archived. Catalogue changes and variant activation are unavailable. Product reactivation is a separate, deferred workflow.</p> : null}

    <form action={productAction} className="rounded border bg-white p-5">
      <h2 className="font-semibold">Edit product</h2>
      <input name="id" type="hidden" value={product.id}/>
      <div className="mt-3 grid gap-2 sm:grid-cols-2"><input className="rounded border p-2" defaultValue={product.name} name="name"/><input className="rounded border p-2" defaultValue={product.sku} name="sku"/><input className="rounded border p-2" defaultValue={product.barcode ?? ""} name="barcode" placeholder="Barcode"/><select className="rounded border p-2" defaultValue={String(product.serialized)} name="serialized"><option value="false">Non-serialized</option><option value="true">Serialized</option></select><input className="rounded border p-2" defaultValue={product.minimum_stock} min="0" name="minimumStock" type="number"/><input className="rounded border p-2" defaultValue={product.warranty_months ?? ""} min="0" name="warrantyMonths" type="number"/></div>
      <input className="mt-2 w-full rounded border p-2" defaultValue={product.model ?? ""} name="model" placeholder="Model"/><textarea className="mt-2 w-full rounded border p-2" defaultValue={product.description ?? ""} name="description" placeholder="Description"/>
      <button disabled={!productIsActive} className={`mt-3 rounded bg-slate-900 px-3 py-2 text-white ${disabledClass}`}>Save changes</button><Feedback state={productState}/>
    </form>

    <div className="grid gap-5 lg:grid-cols-2">
      <form action={variantAction} className="rounded border bg-white p-5"><h2 className="font-semibold">Add variant</h2><p className="mt-1 text-sm text-slate-600">New variants are inactive until a variant-specific price is configured.</p><input name="productId" type="hidden" value={product.id}/><input required className="mt-3 w-full rounded border p-2" name="label" placeholder="Variant label"/><input className="mt-2 w-full rounded border p-2" name="sku" placeholder="Variant SKU"/><input className="mt-2 w-full rounded border p-2" name="barcode" placeholder="Variant barcode"/><button disabled={!productIsActive} className={`mt-3 rounded bg-slate-900 px-3 py-2 text-white ${disabledClass}`}>Create variant</button><Feedback state={variantState}/></form>
      <form action={priceAction} className="rounded border bg-white p-5"><h2 className="font-semibold">Configure price</h2><input name="productId" type="hidden" value={product.id}/><select className="mt-3 w-full rounded border p-2" name="variantId" onChange={(event) => setVariantId(event.target.value)} value={variantId}><option value="">Base product</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{formatVariantLabel(variant)}{variant.active ? "" : " (inactive — configuration only)"}</option>)}</select><select className="mt-2 w-full rounded border p-2" name="condition"><option>NEW</option><option>USED</option><option>REFURBISHED</option></select><input required className="mt-2 w-full rounded border p-2" min="0" name="price" placeholder="Selling price" type="number"/>{selectedVariantIsInactive ? <><input name="active" type="hidden" value="false"/><p className="mt-2 text-sm text-slate-600">This price will be saved inactive and activated atomically when the variant is activated.</p></> : <select className="mt-2 w-full rounded border p-2" name="active" onChange={(event) => setPriceActive(event.target.value)} value={priceActive}><option value="true">Active</option><option value="false">Save inactive</option></select>}{!variantId && hasActiveVariants ? <p className="mt-2 text-sm text-amber-800">An active product-level price is not permitted while active variants exist.</p> : null}<button disabled={!productIsActive} className={`mt-3 rounded bg-slate-900 px-3 py-2 text-white ${disabledClass}`}>Save price</button><Feedback state={priceState}/></form>
    </div>

    <section className="rounded border bg-white p-5"><h2 className="font-semibold">Variants and prices</h2>{!productIsActive && variants.some((variant) => !variant.active) ? <p className="mt-2 text-sm text-amber-800">Inactive variants cannot be activated while the parent product is archived.</p> : null}{variants.length === 0 ? <p className="mt-2 text-sm text-slate-600">No variants configured.</p> : null}{variants.map((variant) => {
      const canActivate = canActivateVariant(productIsActive, prices, variant.id);
      const activationBlockedByArchivedParent = !productIsActive && !variant.active;
      return <div key={variant.id} className="mt-3 rounded border p-3"><p className="text-sm font-medium">{variant.label} · {variant.active ? "Active" : "Inactive"}</p>{!variant.active && canActivate ? <form action={variantActivationAction} className="mt-2 flex flex-wrap gap-2"><input name="id" type="hidden" value={variant.id}/><input name="productId" type="hidden" value={product.id}/><input required className="rounded border p-2 text-sm" defaultValue={variant.label} name="label"/><input className="rounded border p-2 text-sm" defaultValue={variant.sku ?? ""} name="sku" placeholder="Variant SKU"/><input className="rounded border p-2 text-sm" defaultValue={variant.barcode ?? ""} name="barcode" placeholder="Variant barcode"/><button className="rounded bg-slate-900 px-3 py-2 text-sm text-white">Activate variant</button></form> : null}{activationBlockedByArchivedParent ? <p className="mt-2 text-sm text-amber-800">Activation is unavailable because the parent product is archived.</p> : null}{!variant.active && !canActivate && !activationBlockedByArchivedParent ? <p className="mt-2 text-sm text-amber-800">Configure a variant-specific price before activation.</p> : null}<form action={variantArchiveAction} className="mt-2"><input name="id" type="hidden" value={variant.id}/><input name="productId" type="hidden" value={product.id}/><button disabled={!productIsActive} className={`text-sm text-red-700 ${disabledClass}`}>Archive variant</button></form></div>;
    })}{prices.map((price) => { const variant = price.variant_id ? variants.find((item) => item.id === price.variant_id) : null; return <p key={price.id} className="mt-2 text-sm">{price.variant_id ? `Variant: ${variant?.label ?? price.variant_id}` : "Base product"} · {price.condition} · ₦{Number(price.selling_price).toLocaleString()} · {price.active ? "Active" : "Inactive"}</p>; })}<Feedback state={variantActivationState}/><Feedback state={variantArchiveState}/></section>

    <form action={productArchiveAction} className="rounded border border-red-200 bg-red-50 p-5"><input name="id" type="hidden" value={product.id}/><button disabled={!productIsActive} className={`text-red-800 ${disabledClass}`}>Archive product</button><Feedback state={productArchiveState}/></form>
  </div>;
}
