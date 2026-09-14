import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SupplierStatus = "active" | "archived" | "all";

type SupplierListItem = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
};

function supplierStatus(value: string | undefined): SupplierStatus {
  if (value === "archived" || value === "all") return value;
  return "active";
}

function matchesSupplierSearch(supplier: SupplierListItem, search: string) {
  if (!search) return true;

  const candidate = search.toLocaleLowerCase();
  return [supplier.business_name, supplier.contact_name, supplier.phone, supplier.email]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(candidate));
}

function matchesSupplierStatus(supplier: SupplierListItem, status: SupplierStatus) {
  return status === "all" || (status === "active" ? supplier.active : !supplier.active);
}

function supplierEmptyMessage(search: string, status: SupplierStatus) {
  if (search) return "No suppliers match your search.";
  if (status === "archived") return "No archived suppliers are available yet.";
  if (status === "all") return "No suppliers are available yet.";
  return "No active suppliers are available yet.";
}

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  const params = await searchParams;
  const search = params.q?.trim() ?? "";
  const status = supplierStatus(params.status);
  const supabase = await createSupabaseServerClient();

  let suppliers: SupplierListItem[] = [];
  let queryFailed = !supabase;

  if (supabase) {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id,business_name,contact_name,phone,email,active")
      .order("business_name", { ascending: true });
    queryFailed = Boolean(error);
    suppliers = (data ?? []) as SupplierListItem[];
  }

  const matchingSuppliers = suppliers
    .filter((supplier) => matchesSupplierStatus(supplier, status) && matchesSupplierSearch(supplier, search))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.business_name.localeCompare(right.business_name));

  return (
    <main className="app-page">
      <p className="app-eyebrow">PROCUREMENT</p>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="app-page-title">Suppliers</h1>
          <p className="app-page-subtitle">Review active and archived supplier records.</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <Link className="app-button-primary inline-flex w-fit items-center px-3" href="/app/suppliers/new">New supplier</Link>
          <form className="flex w-full flex-col gap-2 sm:flex-row" role="search">
            <input
              aria-label="Search suppliers"
              className="min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm sm:w-72"
              defaultValue={search}
              name="q"
              autoComplete="off"
              placeholder="Business, contact, phone or email"
            />
            <select aria-label="Supplier status" className="min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm" defaultValue={status} name="status">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
            <button className="app-button-secondary px-3 text-sm" type="submit">Search</button>
          </form>
        </div>
      </div>

      <section className="app-panel overflow-hidden" aria-label="Supplier records">
        {queryFailed ? (
          <p className="p-4 text-sm text-slate-600">Supplier records are temporarily unavailable. Check your connection and try again.</p>
        ) : matchingSuppliers.length > 0 ? (
          <div className="divide-y">
            {matchingSuppliers.map((supplier) => (
              <article key={supplier.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-[var(--tg-navy)]">{supplier.business_name}</h2>
                    <span className={`app-status ${supplier.active ? "app-status-active" : "app-status-archived"}`}>{supplier.active ? "Active" : "Archived"}</span>
                  </div>
                  {[supplier.contact_name, supplier.phone, supplier.email].filter(Boolean).length > 0 ? (
                    <p className="mt-1 break-words text-sm text-slate-600">{[supplier.contact_name, supplier.phone, supplier.email].filter(Boolean).join(" · ")}</p>
                  ) : (
                    <p className="mt-1 text-sm text-slate-500">No contact details recorded.</p>
                  )}
                </div>
                <Link className="app-button-secondary inline-flex w-fit items-center px-3" href={`/app/suppliers/${supplier.id}`}>View details</Link>
              </article>
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-slate-600">{supplierEmptyMessage(search, status)}</p>
        )}
      </section>
    </main>
  );
}
