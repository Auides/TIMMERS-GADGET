/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { redirect } from "next/navigation";
import { OfflineNormalRouteFallback } from "@/app/offline/offline-normal-read";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { managementInventoryRows } from "./inventory-overview";
import { inventoryOverviewActions, staffInventoryBucketDisplay } from "./inventory-ui";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");

  const supabase = await createSupabaseServerClient();
  const management = ["ADMIN", "MANAGER"].includes(profile.role);
  const actions = inventoryOverviewActions(profile.role);
  let rows: any[] = [];

  if (supabase && management) {
    const [{ data: buckets, error: bucketError }, { data: prices, error: priceError }] = await Promise.all([
      supabase.from("stock_buckets").select("id,product_id,variant_id,condition,quantity,weighted_average_cost,products(name,sku,serialized,minimum_stock),product_variants(label,sku,barcode)").order("created_at", { ascending: false }),
      supabase.from("catalogue_prices").select("product_id,variant_id,condition,selling_price,active").eq("active", true),
    ]);
    if (bucketError) console.error("Management inventory bucket read failed", bucketError.code);
    if (priceError) console.error("Management inventory price read failed", priceError.code);
    rows = managementInventoryRows((buckets ?? []) as any[], (prices ?? []) as any[]);
  } else if (supabase) {
    const { data } = await supabase.rpc("staff_catalog_lookup", { p_search: null });
    rows = data ?? [];
  }

  return <>
    <main className="app-page">
      <p className="app-eyebrow">INVENTORY</p>
      <h1 className="app-page-title">Current stock</h1>
      <p className="app-page-subtitle">Live on-hand inventory by product, condition, and tracking mode.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {actions.openingStock ? <Link className="app-button-primary inline-flex items-center px-3" href="/app/inventory/opening-stock">Opening stock</Link> : null}
        {actions.adjustments ? <Link className="app-button-secondary inline-flex items-center px-3" href="/app/inventory/adjustments">Adjustments</Link> : null}
        <Link className="app-button-secondary inline-flex items-center px-3" href="/app/inventory/serialized">Serialized lookup</Link>
      </div>
      <section className="app-panel mt-5 overflow-hidden"><div className="divide-y">
        {rows.length ? rows.map((row: any) => {
          const staffDisplay = management ? null : staffInventoryBucketDisplay(row);
          return <article key={row.id ?? `${row.product_id}-${row.variant_id}-${row.condition}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <Link className="font-semibold text-[var(--tg-navy)]" href={`/app/inventory/${row.product_id}`}>{row.products?.name ?? staffDisplay?.title}</Link>
              <p className="text-sm text-slate-600">{row.products?.sku ?? staffDisplay?.sku}{row.product_variants?.label ? ` · ${row.product_variants.label}` : ""} · {row.condition} · {(row.products?.serialized ?? row.serialized) ? "Serialized" : "Non-serialized"}</p>
            </div>
            <div className="text-right"><b>On hand {row.quantity}</b>{management ? <><p className="text-sm text-slate-600">WAC ₦{Number(row.weighted_average_cost ?? 0).toLocaleString()}</p><p className="text-sm text-slate-600">Price {row.selling_price === null ? "Not configured" : `₦${Number(row.selling_price).toLocaleString()}`}</p></> : null}</div>
          </article>;
        }) : <p className="p-4 text-sm text-slate-600">No inventory is available for this view.</p>}
      </div></section>
    </main>
    <OfflineNormalRouteFallback mode="inventory" returnTo="/app/inventory" />
  </>;
}
