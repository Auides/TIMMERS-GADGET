import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProductFeedback } from "../catalogue-forms";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile || !["ADMIN", "MANAGER"].includes(profile.role)) redirect("/app/catalogue");
  const supabase = await createSupabaseServerClient();
  const [{ data: categories }, { data: brands }] = supabase ? await Promise.all([supabase.from("categories").select("id,name").eq("active", true).order("name"), supabase.from("brands").select("id,name").eq("active", true).order("name")]) : [{ data: [] }, { data: [] }];
  const fieldClass = "mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2";
  return <main className="app-page-narrow"><p className="app-eyebrow">CATALOGUE MASTER DATA</p><h1 className="app-page-title">New product</h1><p className="app-page-subtitle">Create the product definition before pricing or inventory is recorded.</p><form id="product-form" className="app-panel mt-6 space-y-4 p-5 sm:p-6"><label className="block text-sm font-semibold">Name<input required name="name" className={fieldClass}/></label><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">SKU<input required name="sku" className={fieldClass}/></label><label className="text-sm font-semibold">Barcode<input name="barcode" className={fieldClass}/></label></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">Category<select name="categoryId" className={fieldClass}><option value="">None</option>{categories?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label className="text-sm font-semibold">Brand<select name="brandId" className={fieldClass}><option value="">None</option>{brands?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div><label className="block text-sm font-semibold">Tracking<select name="serialized" className={fieldClass}><option value="false">Non-serialized</option><option value="true">Serialized</option></select></label><label className="block text-sm font-semibold">Minimum stock<input required defaultValue="0" min="0" name="minimumStock" type="number" className={fieldClass}/></label><label className="block text-sm font-semibold">Model<input name="model" className={fieldClass}/></label><label className="block text-sm font-semibold">Description<textarea name="description" className={`${fieldClass} min-h-24`}/></label><ProductFeedback/></form></main>;
}
