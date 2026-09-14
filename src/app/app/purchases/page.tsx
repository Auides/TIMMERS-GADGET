import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type PurchaseStateFilter = "all" | "active" | "reversed";
type PaymentStatusFilter = "all" | "unpaid" | "partially_paid" | "paid" | "not_applicable";
type Numeric = number | string;

type PurchaseListItem = {
  id: string;
  purchase_number: number;
  supplier_name_snapshot: string;
  received_on: string;
  supplier_reference: string | null;
  total: Numeric;
};

type PurchaseFinancialSummary = {
  purchase_id: string;
  purchase_state: "ACTIVE" | "REVERSED";
  net_supplier_payments: Numeric;
  amount_still_payable: Numeric;
  payment_status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "NOT_APPLICABLE";
};

function purchaseState(value: string | undefined): PurchaseStateFilter {
  return value === "active" || value === "reversed" ? value : "all";
}

function paymentStatus(value: string | undefined): PaymentStatusFilter {
  return value === "unpaid" || value === "partially_paid" || value === "paid" || value === "not_applicable" ? value : "all";
}

function formatCurrency(value: Numeric) {
  return `₦${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function emptyMessage(search: string, state: PurchaseStateFilter, payment: PaymentStatusFilter) {
  if (search) return "No purchases match your search.";
  if (state !== "all" || payment !== "all") return "No purchases match the selected filters.";
  return "No purchases are available yet.";
}

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ q?: string; state?: string; payment?: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  const params = await searchParams;
  const search = params.q?.trim() ?? "";
  const stateFilter = purchaseState(params.state);
  const paymentFilter = paymentStatus(params.payment);
  const supabase = await createSupabaseServerClient();

  let purchases: PurchaseListItem[] = [];
  let financials: PurchaseFinancialSummary[] = [];
  let queryFailed = !supabase;

  if (supabase) {
    const [purchasesResult, financialsResult] = await Promise.all([
      supabase.from("purchases").select("id,purchase_number,supplier_name_snapshot,received_on,supplier_reference,total").order("received_on", { ascending: false }).order("purchase_number", { ascending: false }),
      supabase.from("purchase_financial_summary").select("purchase_id,purchase_state,net_supplier_payments,amount_still_payable,payment_status"),
    ]);
    queryFailed = Boolean(purchasesResult.error || financialsResult.error);
    purchases = (purchasesResult.data ?? []) as PurchaseListItem[];
    financials = (financialsResult.data ?? []) as PurchaseFinancialSummary[];
  }

  const financialByPurchase = new Map(financials.map((financial) => [financial.purchase_id, financial]));
  const matchingPurchases = purchases.filter((purchase) => {
    const financial = financialByPurchase.get(purchase.id);
    const searchable = [String(purchase.purchase_number), purchase.supplier_reference, purchase.supplier_name_snapshot]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const matchesState = stateFilter === "all" || financial?.purchase_state.toLocaleLowerCase() === stateFilter;
    const matchesPayment = paymentFilter === "all" || financial?.payment_status.toLocaleLowerCase() === paymentFilter;
    return searchable && matchesState && matchesPayment;
  });

  return <main className="app-page">
    <p className="app-eyebrow">PROCUREMENT</p>
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <h1 className="app-page-title">Purchases</h1>
        <p className="app-page-subtitle">Completed procurement receipts and their immutable financial history.</p>
      </div>
      <div className="flex w-full flex-col gap-2 lg:w-auto lg:items-end">
        <Link className="app-button-primary inline-flex w-fit items-center px-3" href="/app/purchases/new">New purchase</Link>
        <form className="grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(15rem,1fr)_auto_auto_auto]" role="search">
          <input aria-label="Search purchases" autoComplete="off" className="min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm" defaultValue={search} name="q" placeholder="Purchase number, supplier or reference" />
          <select aria-label="Payment status" className="min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm" defaultValue={paymentFilter} name="payment">
            <option value="all">All payment states</option><option value="unpaid">Unpaid</option><option value="partially_paid">Partially paid</option><option value="paid">Paid</option><option value="not_applicable">Not applicable</option>
          </select>
          <select aria-label="Purchase state" className="min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm" defaultValue={stateFilter} name="state">
            <option value="all">All purchase states</option><option value="active">Active</option><option value="reversed">Reversed</option>
          </select>
          <button className="app-button-secondary px-3 text-sm" type="submit">Search</button>
        </form>
      </div>
    </div>

    <section className="app-panel overflow-hidden" aria-label="Purchase records">
      {queryFailed ? <p className="p-4 text-sm text-slate-600">Purchase records are temporarily unavailable. Check your connection and try again.</p> : matchingPurchases.length ? <div className="divide-y">
        {matchingPurchases.map((purchase) => {
          const financial = financialByPurchase.get(purchase.id);
          const purchaseState = financial?.purchase_state ?? "ACTIVE";
          const paymentState = financial?.payment_status ?? "NOT_APPLICABLE";
          return <article key={purchase.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center lg:gap-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-[var(--tg-navy)]">Purchase #{purchase.purchase_number}</h2><span className={`app-status ${purchaseState === "REVERSED" ? "app-status-archived" : "app-status-active"}`}>{statusLabel(purchaseState)}</span></div>
              <p className="mt-1 truncate text-sm text-slate-700">{purchase.supplier_name_snapshot}</p>
              <p className="mt-1 text-sm text-slate-600">Received {formatDate(purchase.received_on)}{purchase.supplier_reference ? ` · Ref: ${purchase.supplier_reference}` : ""}</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-sm text-slate-600 lg:block lg:text-right"><div><dt className="sr-only">Purchase total</dt><dd>Total {formatCurrency(purchase.total)}</dd></div><div><dt className="sr-only">Paid</dt><dd>Paid {financial ? formatCurrency(financial.net_supplier_payments) : "—"}</dd></div><div><dt className="sr-only">Remaining</dt><dd>Remaining {financial ? formatCurrency(financial.amount_still_payable) : "—"}</dd></div><div><dt className="sr-only">Payment status</dt><dd>{statusLabel(paymentState)}</dd></div></dl>
            <Link className="app-button-secondary inline-flex w-fit items-center px-3 lg:justify-self-end" href={`/app/purchases/${purchase.id}`}>View details</Link>
          </article>;
        })}
      </div> : <p className="p-4 text-sm text-slate-600">{emptyMessage(search, stateFilter, paymentFilter)}</p>}
    </section>
  </main>;
}
