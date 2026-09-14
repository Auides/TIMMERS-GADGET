import { notFound, redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProductManagement } from "../catalogue-forms";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!["ADMIN", "MANAGER"].includes(profile.role)) redirect("/app/catalogue");
  const supabase = await createSupabaseServerClient();
  const id = (await params).id;
  if (!supabase) notFound();
  const [{ data: product }, { data: variants }, { data: prices }] = await Promise.all([
    supabase.from("products").select("*").eq("id", id).maybeSingle(),
    supabase.from("product_variants").select("*").eq("product_id", id).order("label"),
    supabase.from("catalogue_prices").select("*").eq("product_id", id).order("condition"),
  ]);
  if (!product) notFound();
  return <main className="app-page">
    <p className="app-eyebrow">CATALOGUE PRODUCT</p>
    <div className="mt-1 flex flex-wrap items-center gap-3"><h1 className="app-page-title">{product.name}</h1><span className={`app-status ${product.active ? "app-status-active" : "app-status-archived"}`}>{product.active ? "Active" : "Archived"}</span></div>
    <p className="app-page-subtitle">{product.serialized ? "Serialized" : "Non-serialized"} tracking · SKU {product.sku}</p>
    <div className="mt-6"><ProductManagement product={product} variants={variants ?? []} prices={prices ?? []}/></div>
  </main>;
}
