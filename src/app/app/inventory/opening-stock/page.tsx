import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OpeningStockForm } from "../inventory-forms";

export const dynamic = "force-dynamic";

export default async function Opening() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile || !["ADMIN", "MANAGER"].includes(profile.role)) redirect("/app/inventory");
  const supabase = await createSupabaseServerClient();
  const [productsResult, variantsResult] = supabase ? await Promise.all([
    supabase.from("products").select("id,name,sku,barcode,serialized").eq("active", true).order("name"),
    supabase.from("product_variants").select("id,product_id,label,sku,barcode").eq("active", true).order("label"),
  ]) : [{ data: [] }, { data: [] }];
  return <main className="app-page-narrow"><p className="app-eyebrow">INVENTORY SETUP</p><h1 className="app-page-title">Opening stock</h1><p className="app-page-subtitle">Stock-affecting submissions require a live connection.</p><div className="mt-6"><OpeningStockForm products={productsResult.data ?? []} variants={variantsResult.data ?? []}/></div></main>;
}
