import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";

type CatalogueRow = {
  product_id: string;
  product_name: string;
  product_sku: string;
  variant_id: string | null;
  variant_label: string | null;
  condition: "NEW" | "USED" | "REFURBISHED";
  quantity: number;
  selling_price: number;
};

function lagosDate() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export default async function NewSalePage() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!hasPermission(profile.role, "sell")) redirect("/app");

  const supabase = await createSupabaseServerClient();
  let catalogueRows: CatalogueRow[] = [];
  let loadFailed = !supabase;
  if (supabase) {
    const { data, error } = await supabase.rpc("staff_catalog_lookup", { p_search: null });
    loadFailed = Boolean(error);
    catalogueRows = ((data ?? []) as CatalogueRow[])
      .filter((row) => Number(row.selling_price) >= 0)
      .map((row) => ({ ...row, quantity: Number(row.quantity), selling_price: Number(row.selling_price) }));
  }

  return <main className="app-page">
    <p className="app-eyebrow">SALES</p>
    <div className="mb-6"><h1 className="app-page-title">New sale</h1><p className="app-page-subtitle">Complete an ordinary sale with authoritative prices, serialized-unit tracking, split payments, and atomic stock updates.</p></div>
    {loadFailed ? <p className="app-panel mb-5 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Sellable catalogue stock could not be loaded. Check the connection and refresh before starting a sale.</p> : null}
    <CheckoutForm catalogueRows={catalogueRows} today={lagosDate()} />
  </main>;
}
