import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { QuickCatalogueForms } from "./catalogue-forms";
import { catalogueProductHref, catalogueStatus, matchesCatalogueStatus, type CatalogueStatus } from "./catalogue-status";

export const dynamic = "force-dynamic";

type StaffCatalogueRow = {
  product_id: string;
  product_name: string;
  product_sku: string;
  product_barcode: string | null;
  brand_name: string | null;
  category_name: string | null;
  serialized: boolean;
  variant_id: string | null;
  variant_label: string | null;
  variant_sku: string | null;
  variant_barcode: string | null;
  condition: string;
  quantity: number;
  selling_price: number;
};

type ManagementProduct = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  serialized: boolean;
  active: boolean;
  brand: { name: string } | null;
  category: { name: string } | null;
  variants: { id: string; active: boolean }[] | null;
  prices: { id: string; active: boolean }[] | null;
};

function matchesSearch(product: ManagementProduct, search: string) {
  if (!search) return true;

  const candidate = search.toLocaleLowerCase();
  return [product.name, product.sku, product.barcode]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(candidate));
}

function ManagementCatalogue({ products, search, status }: { products: ManagementProduct[]; search: string; status: CatalogueStatus }) {
  const matchingProducts = products.filter((product) => matchesCatalogueStatus(product, status) && matchesSearch(product, search));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {status === "active" ? "Active products are listed even before their first selling price is configured." : status === "archived" ? "Archived products are available for review only." : "Active and archived products are available for management review."}
        </p>
        <Link className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white" href="/app/catalogue/new">
          Add product
        </Link>
      </div>

      {matchingProducts.length > 0 ? (
        <div className="space-y-3">
          {matchingProducts.map((product) => {
            const activeVariants = product.variants?.filter((variant) => variant.active).length ?? 0;
            const activePrices = product.prices?.filter((price) => price.active).length ?? 0;

            return (
              <article key={product.id} className={`rounded-lg border bg-white p-4 shadow-sm ${product.active ? "" : "border-amber-200 bg-amber-50"}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="font-semibold text-slate-900">{product.name}</h2>
                    <p className="mt-1 text-sm text-slate-600">
                      {product.sku}
                      {product.barcode ? ` · Barcode: ${product.barcode}` : ""}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {[product.brand?.name, product.category?.name, product.serialized ? "Serialized" : "Non-serialized"]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="mt-2 text-sm font-medium text-slate-800">
                      {!product.active ? "Archived · " : ""}
                      {activePrices > 0
                        ? `${activePrices} active catalogue ${activePrices === 1 ? "price" : "prices"}`
                        : "Price not configured"}
                      {activeVariants > 0 ? ` · ${activeVariants} active ${activeVariants === 1 ? "variant" : "variants"}` : ""}
                    </p>
                  </div>
                  <Link
                    className="inline-flex w-fit rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                    href={catalogueProductHref(product.id)}
                  >
                    {product.active ? "Manage" : "View"}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border bg-white p-4 text-sm text-slate-600">
          {search ? "No matching products." : status === "archived" ? "No archived products." : status === "all" ? "No catalogue products yet." : "No active products yet."}
        </p>
      )}

      <QuickCatalogueForms />
    </>
  );
}

function StaffCatalogue({ rows }: { rows: StaffCatalogueRow[] }) {
  return rows.length > 0 ? (
    <div className="space-y-3">
      {rows.map((row) => (
        <article
          key={`${row.product_id}-${row.variant_id ?? "base"}-${row.condition}`}
          className="flex flex-col gap-2 rounded-lg border bg-white p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between"
        >
          <div>
            <h2 className="font-semibold text-slate-900">
              {row.product_name}
              {row.variant_label ? ` — ${row.variant_label}` : ""}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {row.variant_sku ?? row.product_sku} · {row.condition}
            </p>
            <p className="mt-1 text-sm text-slate-600">{[row.brand_name, row.category_name].filter(Boolean).join(" · ")}</p>
          </div>
          <p className="text-sm font-medium text-slate-900">
            ₦{Number(row.selling_price).toLocaleString()} · Stock {row.quantity}
          </p>
        </article>
      ))}
    </div>
  ) : (
    <p className="rounded-lg border bg-white p-4 text-sm text-slate-600">No active catalogue prices match this search.</p>
  );
}

export default async function CataloguePage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");

  const params = await searchParams;
  const search = params.q?.trim() ?? "";
  const status = catalogueStatus(params.status);
  const isManagement = ["ADMIN", "MANAGER"].includes(profile.role);
  const supabase = await createSupabaseServerClient();

  let managementProducts: ManagementProduct[] = [];
  let staffRows: StaffCatalogueRow[] = [];

  if (supabase && isManagement) {
    let query = supabase
      .from("products")
      .select("id,name,sku,barcode,serialized,active,brand:brands(name),category:categories(name),variants:product_variants(id,active),prices:catalogue_prices(id,active)")
      .order("name");
    if (status === "active") query = query.eq("active", true);
    if (status === "archived") query = query.eq("active", false);
    const { data } = await query;
    managementProducts = (data ?? []) as unknown as ManagementProduct[];
  } else if (supabase) {
    const { data } = await supabase.rpc("staff_catalog_lookup", { p_search: search || null });
    staffRows = (data ?? []) as StaffCatalogueRow[];
  }

  return (
    <main className="app-page">
      <div>
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="app-page-title">Catalogue</h1>
            <p className="mt-1 text-sm text-slate-600">
              {isManagement ? "Manage active products, variants and catalogue prices." : "Search sellable catalogue items."}
            </p>
          </div>
          <form className="flex flex-wrap gap-2" role="search">
            <input
              aria-label="Search catalogue"
              className="min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm sm:w-72"
              defaultValue={search}
              name="q"
              placeholder="Name, SKU or barcode"
            />
            {isManagement ? <select aria-label="Catalogue status" className="min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm" defaultValue={status} name="status"><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select> : null}
            <button className="app-button-primary px-3 text-sm" type="submit">
              Search
            </button>
          </form>
        </div>

        {isManagement ? <ManagementCatalogue products={managementProducts} search={search} status={status} /> : <StaffCatalogue rows={staffRows} />}
      </div>
    </main>
  );
}
