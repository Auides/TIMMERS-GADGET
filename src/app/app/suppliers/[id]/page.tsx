import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ActiveSupplierControls, ArchivedSupplierContactControls } from "../supplier-forms";

export const dynamic = "force-dynamic";

type Supplier = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  archived_at: string | null;
};

type PurchaseHistoryItem = {
  id: string;
  purchase_number: string;
  received_on: string;
  supplier_reference: string | null;
  total: number;
};

type PurchaseFinancialSummary = {
  purchase_id: string;
  purchase_state: "ACTIVE" | "REVERSED";
  amount_still_payable: number;
  payment_status: string;
};

function formatCurrency(value: number) {
  return `₦${Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return (
      <main className="app-page">
        <p className="app-eyebrow">PROCUREMENT</p>
        <h1 className="app-page-title">Supplier details</h1>
        <p className="app-panel mt-5 p-4 text-sm text-slate-600">Supplier details are temporarily unavailable. Check your connection and try again.</p>
      </main>
    );
  }

  const [supplierResult, purchasesResult, financialsResult] = await Promise.all([
    supabase.from("suppliers").select("id,business_name,contact_name,phone,email,address,notes,active,archived_at").eq("id", id).maybeSingle(),
    supabase.from("purchases").select("id,purchase_number,received_on,supplier_reference,total").eq("supplier_id", id).order("received_on", { ascending: false }),
    supabase.from("purchase_financial_summary").select("purchase_id,purchase_state,amount_still_payable,payment_status").eq("supplier_id", id),
  ]);

  if (supplierResult.error) {
    return (
      <main className="app-page">
        <p className="app-eyebrow">PROCUREMENT</p>
        <h1 className="app-page-title">Supplier details</h1>
        <p className="app-panel mt-5 p-4 text-sm text-slate-600">Supplier details are temporarily unavailable. Check your connection and try again.</p>
      </main>
    );
  }

  const supplier = supplierResult.data as Supplier | null;
  if (!supplier) {
    return (
      <main className="app-page">
        <p className="app-eyebrow">PROCUREMENT</p>
        <h1 className="app-page-title">Supplier not found</h1>
        <p className="app-page-subtitle">This supplier record does not exist or is no longer available.</p>
        <Link className="app-button-secondary mt-5 inline-flex w-fit items-center px-3" href="/app/suppliers">Back to suppliers</Link>
      </main>
    );
  }

  const purchaseHistoryUnavailable = Boolean(purchasesResult.error || financialsResult.error);
  const purchases = (purchasesResult.data ?? []) as PurchaseHistoryItem[];
  const financials = new Map(((financialsResult.data ?? []) as PurchaseFinancialSummary[]).map((financial) => [financial.purchase_id, financial]));

  return (
    <main className="app-page">
      <p className="app-eyebrow">PROCUREMENT</p>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="app-page-title">{supplier.business_name}</h1>
            <span className={`app-status ${supplier.active ? "app-status-active" : "app-status-archived"}`}>{supplier.active ? "Active" : "Archived"}</span>
          </div>
          <p className="app-page-subtitle">Supplier identity and completed purchase history.</p>
        </div>
        <Link className="app-button-secondary inline-flex w-fit items-center px-3" href="/app/suppliers">Back to suppliers</Link>
      </div>

      <section className="app-panel p-4">
        <h2 className="font-semibold text-[var(--tg-navy)]">Supplier details</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="font-medium text-slate-500">Contact</dt><dd className="mt-1 text-slate-900">{supplier.contact_name ?? "Not recorded"}</dd></div>
          <div><dt className="font-medium text-slate-500">Phone</dt><dd className="mt-1 text-slate-900">{supplier.phone ?? "Not recorded"}</dd></div>
          <div><dt className="font-medium text-slate-500">Email</dt><dd className="mt-1 break-words text-slate-900">{supplier.email ?? "Not recorded"}</dd></div>
          <div><dt className="font-medium text-slate-500">Archive state</dt><dd className="mt-1 text-slate-900">{supplier.active ? "Active supplier" : supplier.archived_at ? `Archived ${formatDate(supplier.archived_at.slice(0, 10))}` : "Archived supplier"}</dd></div>
          <div className="sm:col-span-2"><dt className="font-medium text-slate-500">Address</dt><dd className="mt-1 whitespace-pre-wrap text-slate-900">{supplier.address ?? "Not recorded"}</dd></div>
          <div className="sm:col-span-2"><dt className="font-medium text-slate-500">Notes</dt><dd className="mt-1 whitespace-pre-wrap text-slate-900">{supplier.notes ?? "No notes recorded"}</dd></div>
        </dl>
      </section>

      {supplier.active ? <ActiveSupplierControls supplier={supplier} /> : <ArchivedSupplierContactControls supplier={supplier} />}

      <section className="app-panel mt-5 overflow-hidden" aria-label="Purchase history">
        <div className="border-b border-slate-200 p-4"><h2 className="font-semibold text-[var(--tg-navy)]">Purchase history</h2></div>
        {purchaseHistoryUnavailable ? (
          <p className="p-4 text-sm text-slate-600">Purchase history is temporarily unavailable. Check your connection and try again.</p>
        ) : purchases.length > 0 ? (
          <div className="divide-y">
            {purchases.map((purchase) => {
              const financial = financials.get(purchase.id);
              const purchaseState = financial?.purchase_state ?? "ACTIVE";
              return (
                <article key={purchase.id} className="grid gap-2 p-4 text-sm md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-6">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{purchase.purchase_number}</p>
                    <p className="mt-1 text-slate-600">Received {formatDate(purchase.received_on)}{purchase.supplier_reference ? ` · Ref: ${purchase.supplier_reference}` : ""}</p>
                  </div>
                  <div className="text-slate-600 md:text-right"><p>Total {formatCurrency(purchase.total)}</p><p>{financial?.payment_status?.replaceAll("_", " ") ?? "Payment state unavailable"}</p></div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end"><span className={`app-status ${purchaseState === "REVERSED" ? "app-status-archived" : "app-status-active"}`}>{purchaseState === "REVERSED" ? "Reversed" : "Active"}</span><span className="text-slate-600">Remaining {financial ? formatCurrency(financial.amount_still_payable) : "—"}</span></div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="p-4 text-sm text-slate-600">No completed purchases are recorded for this supplier.</p>
        )}
      </section>
    </main>
  );
}
