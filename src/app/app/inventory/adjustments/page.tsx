/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdjustmentForm, RequestControls } from "../inventory-forms";
import { SerializedUnitPicker } from "../serialized-unit-picker";
import {
  staffAdjustmentRequestContextById,
  staffRequestIdentifierLabels,
} from "../inventory-ui";

export const dynamic = "force-dynamic";

export default async function Adjustments({ searchParams }: { searchParams: Promise<{ unitSearch?: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");

  const supabase = await createSupabaseServerClient();
  const management = ["ADMIN", "MANAGER"].includes(profile.role);
  const staff = profile.role === "STAFF";
  const admin = profile.role === "ADMIN";
  const query = (await searchParams).unitSearch?.trim() ?? "";
  const requestSelect = management
    ? "*, products(name,sku), product_variants(label,sku), serialized_units(condition,status,unit_identifiers(identifier_type,normalized_value))"
    : "*";

  const requestsPromise = supabase
    ? supabase.from("inventory_adjustment_requests").select(requestSelect).order("created_at", { ascending: false })
    : Promise.resolve({ data: [] });
  const unitsPromise = supabase && query
    ? supabase.rpc("staff_serialized_lookup", { search_text: query })
    : Promise.resolve({ data: [] });
  const staffContextPromise = supabase && staff
    ? supabase.rpc("staff_inventory_adjustment_request_context")
    : Promise.resolve({ data: [] });

  let products: any[] = [];
  let variants: any[] = [];
  let requests: any[] = [];
  let units: any[] = [];

  if (supabase && management) {
    const [productResult, variantResult, requestResult, unitResult] = await Promise.all([
      supabase.from("products").select("id,name,sku,barcode,serialized").eq("active", true).eq("serialized", false).order("name"),
      supabase.from("product_variants").select("id,product_id,label,sku,barcode").eq("active", true).order("label"),
      requestsPromise,
      unitsPromise,
    ]);
    products = productResult.data ?? [];
    variants = variantResult.data ?? [];
    requests = requestResult.data ?? [];
    units = unitResult.data ?? [];
  } else if (supabase && staff) {
    const [catalogueResult, requestResult, unitResult, contextResult] = await Promise.all([
      supabase.rpc("staff_catalog_lookup", { p_search: null }),
      requestsPromise,
      unitsPromise,
      staffContextPromise,
    ]);
    const catalogue = catalogueResult.data ?? [];
    const contextByRequestId = staffAdjustmentRequestContextById(contextResult.data ?? []);

    products = Array.from(new Map(catalogue.map((row: any) => [row.product_id, {
      id: row.product_id,
      name: row.product_name,
      sku: row.product_sku,
      barcode: row.product_barcode,
      serialized: false,
    }])).values());
    variants = Array.from(new Map(catalogue.filter((row: any) => row.variant_id).map((row: any) => [row.variant_id, {
      id: row.variant_id,
      product_id: row.product_id,
      label: row.variant_label,
      sku: row.variant_sku,
      barcode: row.variant_barcode,
    }])).values());
    units = unitResult.data ?? [];
    requests = (requestResult.data ?? []).map((request: any) => ({
      ...request,
      staffContext: contextByRequestId.get(request.id) ?? null,
    }));
  }

  return <main className="app-page"><p className="app-eyebrow">INVENTORY CONTROL</p><h1 className="app-page-title">Adjustment requests</h1><div className="mt-6 grid gap-5 lg:grid-cols-2"><AdjustmentForm products={products} variants={variants} admin={admin}/><SerializedUnitPicker units={units} initialQuery={query} admin={admin}/><section className="app-panel p-5 lg:col-span-2"><h2 className="font-semibold">Requests</h2>{requests.length ? requests.map((request: any) => {const context=request.staffContext;const productName=request.products?.name??context?.product_name??"Inventory item";const productSku=request.products?.sku??context?.product_sku;const variantLabel=request.product_variants?.label??context?.variant_label;const variantSku=request.product_variants?.sku??context?.variant_sku;const identifiers=staffRequestIdentifierLabels(context?.identifiers??request.serialized_units?.unit_identifiers);return <article key={request.id} className="border-b py-3 text-sm"><b className="rounded bg-slate-100 px-2 py-1">{request.status}</b><p className="mt-2 font-medium">{productName}{variantLabel ? ` — ${variantLabel}` : ""}</p>{productSku || variantSku ? <p className="text-slate-600">{[productSku,variantSku].filter(Boolean).join(" · ")}</p> : null}<p>{identifiers.length ? `${identifiers.join(" · ")} · ` : ""}{request.condition ?? "Serialized unit"} · Quantity {request.requested_quantity}</p><p>{request.reason}</p><p className="text-slate-600">Created {new Date(request.created_at).toLocaleString()}</p>{request.reviewed_at ? <p className="text-slate-600">Reviewed {new Date(request.reviewed_at).toLocaleString()}{request.rejection_reason ? ` · ${request.rejection_reason}` : ""}</p> : null}{admin && request.status === "OPEN" ? <RequestControls id={request.id}/> : null}</article>}) : <p className="mt-3 text-sm text-slate-600">No requests available.</p>}</section></div></main>;
}
