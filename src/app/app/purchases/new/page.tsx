import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PurchaseReceiptForm } from "../purchase-receipt-form";

export const dynamic = "force-dynamic";

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export default async function NewPurchasePage() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  const supabase = await createSupabaseServerClient();
  if (!supabase) return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><h1 className="app-page-title">New purchase</h1><p className="app-panel mt-5 p-4 text-sm text-slate-600">Purchase entry is temporarily unavailable. Check your connection and try again.</p><Link className="app-button-secondary mt-5 inline-flex w-fit items-center px-3" href="/app/purchases">Back to purchases</Link></main>;

  const [suppliersResult, productsResult, variantsResult] = await Promise.all([
    supabase.from("suppliers").select("id,business_name,contact_name").eq("active", true).order("business_name", { ascending: true }),
    supabase.from("products").select("id,name,sku,serialized").eq("active", true).order("name", { ascending: true }),
    supabase.from("product_variants").select("id,product_id,label,sku").eq("active", true).order("product_id", { ascending: true }).order("label", { ascending: true }),
  ]);
  if (suppliersResult.error || productsResult.error || variantsResult.error) return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><h1 className="app-page-title">New purchase</h1><p className="app-panel mt-5 p-4 text-sm text-slate-600">Purchase entry is temporarily unavailable. Check your connection and try again.</p><Link className="app-button-secondary mt-5 inline-flex w-fit items-center px-3" href="/app/purchases">Back to purchases</Link></main>;

  const suppliers = suppliersResult.data ?? [];
  const products = productsResult.data ?? [];
  const productIds = new Set(products.map((product) => product.id));
  const variants = (variantsResult.data ?? []).filter((variant) => productIds.has(variant.product_id));

  return <main className="app-page">
    <p className="app-eyebrow">PROCUREMENT</p>
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="app-page-title">New purchase</h1><p className="app-page-subtitle">Record a mixed serialized or nonserialized receipt and any initial split payments.</p></div><Link className="app-button-secondary inline-flex w-fit items-center px-3" href="/app/purchases">Back to purchases</Link></div>
    {suppliers.length === 0 ? <section className="app-panel p-4 sm:p-6"><h2 className="font-semibold text-[var(--tg-navy)]">No active suppliers available</h2><p className="mt-2 text-sm text-slate-600">Create or retain an active supplier before recording a purchase. Archived suppliers cannot be selected for a new receipt.</p><Link className="app-button-secondary mt-4 inline-flex w-fit items-center px-3" href="/app/suppliers">Go to suppliers</Link></section> : products.length === 0 ? <section className="app-panel p-4 sm:p-6"><h2 className="font-semibold text-[var(--tg-navy)]">No active products available</h2><p className="mt-2 text-sm text-slate-600">Add or activate a catalogue product before recording a receipt.</p><Link className="app-button-secondary mt-4 inline-flex w-fit items-center px-3" href="/app/catalogue">Go to catalogue</Link></section> : <PurchaseReceiptForm lagosToday={lagosToday()} products={products} suppliers={suppliers} variants={variants} />}
  </main>;
}
