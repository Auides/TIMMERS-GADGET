import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SerializedLookupForm } from "../serialized-lookup-form";
import { displaySellingPrice } from "../inventory-ui";

export const dynamic = "force-dynamic";

type SerializedLookupUnit = {
  unit_id: string;
  product_name: string;
  product_sku: string;
  variant_label: string | null;
  variant_sku: string | null;
  condition: string;
  status: string;
  selling_price: number | null;
  identifiers: Array<{ identifier_type: string; identifier_value: string }>;
};

export default async function Serialized({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");

  const q = (await searchParams).q?.trim() ?? "";
  const supabase = await createSupabaseServerClient();
  const { data } = supabase && q
    ? await supabase.rpc("staff_serialized_lookup_v2", { search_text: q })
    : { data: [] };
  const units = (data ?? []) as SerializedLookupUnit[];

  return <main className="app-page">
    <p className="app-eyebrow">SERIALIZED INVENTORY</p>
    <h1 className="app-page-title">Serialized lookup</h1>
    <SerializedLookupForm initialQuery={q} />
    <section className="app-panel mt-5 divide-y">
      {q && units.length
        ? units.map((unit) => <article key={unit.unit_id} className="p-4">
          <b>{unit.product_name}{unit.variant_label ? ` — ${unit.variant_label}` : ""}</b>
          <p className="text-sm text-slate-600">{unit.product_sku}{unit.variant_sku ? ` · ${unit.variant_sku}` : ""}</p>
          <p className="text-sm text-slate-600">{unit.identifiers.map((identifier) => `${identifier.identifier_type}: ${identifier.identifier_value}`).join(" · ")} · {unit.condition} · {unit.status}</p>
          <p className="text-sm">{displaySellingPrice(unit.selling_price)}</p>
        </article>)
        : <p className="p-4 text-sm text-slate-600">{q ? "No safe operational match found." : "Search an IMEI, serial, SKU, barcode, or product name. Camera scanning is optional; manual entry is always available."}</p>}
    </section>
  </main>;
}
