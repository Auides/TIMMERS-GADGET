/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SerializedLookupForm } from "../serialized-lookup-form";
import { displaySellingPrice } from "../inventory-ui";
export const dynamic = "force-dynamic";
export default async function Serialized({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { profile } = await getAuthenticatedProfile(); if (!profile) redirect("/login");
  const q = (await searchParams).q?.trim() ?? ""; const s = await createSupabaseServerClient();
  const { data } = s && q ? await s.rpc("staff_serialized_lookup", { search_text: q }) : { data: [] };
  return <main className="app-page"><p className="app-eyebrow">SERIALIZED INVENTORY</p><h1 className="app-page-title">Serialized lookup</h1><SerializedLookupForm initialQuery={q}/><section className="app-panel mt-5 divide-y">{q && data?.length ? (data as any[]).map(x => <article key={`${x.unit_id}-${x.identifier_type}`} className="p-4"><b>{x.product_name}{x.variant_label ? ` — ${x.variant_label}` : ""}</b><p className="text-sm text-slate-600">{x.product_sku}{x.variant_sku ? ` · ${x.variant_sku}` : ""}</p><p className="text-sm text-slate-600">{x.identifier_type}: {x.identifier_value} · {x.condition} · {x.status}</p><p className="text-sm">{displaySellingPrice(x.selling_price)}</p></article>) : <p className="p-4 text-sm text-slate-600">{q ? "No safe operational match found." : "Search an IMEI, serial, SKU, barcode, or product name. Camera scanning is optional; manual entry is always available."}</p>}</section></main>;
}
