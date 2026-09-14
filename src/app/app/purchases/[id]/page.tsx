import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RecordSupplierPaymentForm, ReverseSupplierPaymentForm } from "../supplier-payment-forms";
import { RecordSupplierRefundReceiptForm, ReverseSupplierRefundReceiptForm } from "../supplier-refund-receipt-forms";
import { ReversePurchaseForm, ReverseSupplierReturnForm } from "../procurement-reversal-forms";
import { SupplierReturnForm } from "../supplier-return-form";

export const dynamic = "force-dynamic";

type Numeric = number | string;

type Purchase = {
  id: string;
  purchase_number: Numeric;
  supplier_id: string;
  supplier_name_snapshot: string;
  received_on: string;
  supplier_reference: string | null;
  notes: string | null;
  total: Numeric;
  created_at: string;
};

type FinancialSummary = {
  purchase_id: string;
  purchase_state: "ACTIVE" | "REVERSED";
  historical_original_total: Numeric;
  active_return_value: Numeric;
  net_supplier_payments: Numeric;
  amount_still_payable: Numeric;
  payment_status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "NOT_APPLICABLE";
};

type PurchaseItem = {
  id: string;
  product_id: string;
  variant_id: string | null;
  line_number: number;
  quantity: number;
  unit_cost: Numeric | null;
  condition: string;
  notes: string | null;
  products: { name: string; sku: string; serialized: boolean } | null;
  product_variants: { label: string; sku: string | null } | null;
};

type SerializedUnit = {
  id: string;
  purchase_item_id: string;
  status: string;
  condition: string;
  acquisition_cost: Numeric;
  warranty_start: string | null;
  warranty_expiry: string | null;
  unit_identifiers: { identifier_type: string; normalized_value: string }[] | null;
};

type Payment = { id: string; amount: Numeric; method: string; paid_on: string; reference: string | null; notes: string | null; created_at: string };
type PaymentReversal = { supplier_payment_id: string; purchase_reversal_id: string | null; reason: string; created_at: string };
type SupplierReturn = { id: string; return_number: Numeric; return_order: Numeric; returned_on: string; supplier_reference: string | null; reason: string; total: Numeric; created_at: string };
type ReturnReversal = { supplier_return_id: string; reason: string; created_at: string };
type ReturnFinancialSummary = { supplier_return_id: string; refund_entitlement: Numeric; active_refund_receipts: Numeric; remaining_refund_due: Numeric; refund_status: "NO_REFUND_DUE" | "REFUND_DUE" | "PARTIALLY_REFUNDED" | "REFUNDED" };
type ReturnLine = {
  supplier_return_id: string;
  purchase_item_id: string;
  quantity: number;
  source_unit_cost: Numeric;
  return_value: Numeric;
  purchase_items: { line_number: number; condition: string; products: { name: string; sku: string } | null; product_variants: { label: string } | null } | null;
  serialized_units: { unit_identifiers: { identifier_type: string; normalized_value: string }[] | null } | null;
};
type RefundReceipt = { id: string; supplier_return_id: string; amount: Numeric; method: string; received_on: string; reference: string | null; notes: string | null; created_at: string };
type RefundReceiptReversal = { supplier_refund_receipt_id: string; reason: string; created_at: string };
type PurchaseReversal = { reason: string; created_at: string };
type StockBucket = { product_id: string; variant_id: string | null; condition: string; quantity: number };

function formatCurrency(value: Numeric) {
  return `₦${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function lagosToday() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ").toLocaleLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function identifierLabel(value: string) {
  if (value === "IMEI_1") return "IMEI 1";
  if (value === "IMEI_2") return "IMEI 2";
  if (value === "SERIAL") return "Serial";
  return statusLabel(value);
}

function identifiers(unit: { unit_identifiers: { identifier_type: string; normalized_value: string }[] | null } | null) {
  return unit?.unit_identifiers?.map((identifier) => `${identifierLabel(identifier.identifier_type)}: ${identifier.normalized_value}`).join(" · ") || "No identifiers recorded";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="app-panel mt-5 overflow-hidden"><div className="border-b border-slate-200 p-4"><h2 className="font-semibold text-[var(--tg-navy)]">{title}</h2></div>{children}</section>;
}

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><h1 className="app-page-title">Purchase details</h1><p className="app-panel mt-5 p-4 text-sm text-slate-600">Purchase details are temporarily unavailable. Check your connection and try again.</p></main>;

  const [purchaseResult, financialResult, itemsResult, paymentsResult, returnsResult, purchaseReversalResult] = await Promise.all([
    supabase.from("purchases").select("id,purchase_number,supplier_id,supplier_name_snapshot,received_on,supplier_reference,notes,total,created_at").eq("id", id).maybeSingle(),
    supabase.from("purchase_financial_summary").select("purchase_id,purchase_state,historical_original_total,active_return_value,net_supplier_payments,amount_still_payable,payment_status").eq("purchase_id", id).maybeSingle(),
    supabase.from("purchase_items").select("id,product_id,variant_id,line_number,quantity,unit_cost,condition,notes,products(name,sku,serialized),product_variants(label,sku)").eq("purchase_id", id).order("line_number", { ascending: true }),
    supabase.from("supplier_payments").select("id,amount,method,paid_on,reference,notes,created_at").eq("purchase_id", id).order("paid_on", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("supplier_returns").select("id,return_number,return_order,returned_on,supplier_reference,reason,total,created_at").eq("purchase_id", id).order("return_order", { ascending: true }),
    supabase.from("purchase_reversals").select("reason,created_at").eq("purchase_id", id).maybeSingle(),
  ]);

  if (purchaseResult.error) return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><h1 className="app-page-title">Purchase details</h1><p className="app-panel mt-5 p-4 text-sm text-slate-600">Purchase details are temporarily unavailable. Check your connection and try again.</p></main>;
  const purchase = purchaseResult.data as Purchase | null;
  if (!purchase) return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><h1 className="app-page-title">Purchase not found</h1><p className="app-page-subtitle">This completed purchase does not exist or is no longer available.</p><Link className="app-button-secondary mt-5 inline-flex w-fit items-center px-3" href="/app/purchases">Back to purchases</Link></main>;

  const supplierResult = await supabase.from("suppliers").select("id,business_name,active").eq("id", purchase.supplier_id).maybeSingle();

  const items = (itemsResult.data ?? []) as unknown as PurchaseItem[];
  const payments = (paymentsResult.data ?? []) as Payment[];
  const returns = (returnsResult.data ?? []) as SupplierReturn[];
  const itemIds = items.map((item) => item.id);
  const paymentIds = payments.map((payment) => payment.id);
  const returnIds = returns.map((supplierReturn) => supplierReturn.id);
  const nonSerializedProductIds = items.filter((item) => !item.products?.serialized).map((item) => item.product_id);
  const [unitsResult, paymentReversalsResult, returnLinesResult, returnReversalsResult, returnFinancialsResult, refundReceiptsResult, stockBucketsResult] = await Promise.all([
    itemIds.length ? supabase.from("serialized_units").select("id,purchase_item_id,status,condition,acquisition_cost,warranty_start,warranty_expiry,unit_identifiers(identifier_type,normalized_value)").in("purchase_item_id", itemIds).order("created_at", { ascending: true }) : Promise.resolve({ data: [], error: null }),
    paymentIds.length ? supabase.from("supplier_payment_reversals").select("supplier_payment_id,purchase_reversal_id,reason,created_at").in("supplier_payment_id", paymentIds) : Promise.resolve({ data: [], error: null }),
    returnIds.length ? supabase.from("supplier_return_lines").select("supplier_return_id,purchase_item_id,quantity,source_unit_cost,return_value,purchase_items(line_number,condition,products(name,sku),product_variants(label)),serialized_units(unit_identifiers(identifier_type,normalized_value))").in("supplier_return_id", returnIds).order("created_at", { ascending: true }) : Promise.resolve({ data: [], error: null }),
    returnIds.length ? supabase.from("supplier_return_reversals").select("supplier_return_id,reason,created_at").in("supplier_return_id", returnIds) : Promise.resolve({ data: [], error: null }),
    returnIds.length ? supabase.from("supplier_return_financial_summary").select("supplier_return_id,refund_entitlement,active_refund_receipts,remaining_refund_due,refund_status").in("supplier_return_id", returnIds) : Promise.resolve({ data: [], error: null }),
    returnIds.length ? supabase.from("supplier_refund_receipts").select("id,supplier_return_id,amount,method,received_on,reference,notes,created_at").in("supplier_return_id", returnIds).order("received_on", { ascending: false }).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    nonSerializedProductIds.length ? supabase.from("stock_buckets").select("product_id,variant_id,condition,quantity").eq("serialized", false).in("product_id", nonSerializedProductIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const refundReceipts = (refundReceiptsResult.data ?? []) as RefundReceipt[];
  const receiptIds = refundReceipts.map((receipt) => receipt.id);
  const refundReceiptReversalsResult = receiptIds.length
    ? await supabase.from("supplier_refund_receipt_reversals").select("supplier_refund_receipt_id,reason,created_at").in("supplier_refund_receipt_id", receiptIds)
    : { data: [], error: null };

  const unitsByItem = new Map<string, SerializedUnit[]>();
  for (const unit of (unitsResult.data ?? []) as SerializedUnit[]) unitsByItem.set(unit.purchase_item_id, [...(unitsByItem.get(unit.purchase_item_id) ?? []), unit]);
  const paymentReversals = new Map(((paymentReversalsResult.data ?? []) as PaymentReversal[]).map((reversal) => [reversal.supplier_payment_id, reversal]));
  const returnLinesByReturn = new Map<string, ReturnLine[]>();
  for (const line of (returnLinesResult.data ?? []) as unknown as ReturnLine[]) returnLinesByReturn.set(line.supplier_return_id, [...(returnLinesByReturn.get(line.supplier_return_id) ?? []), line]);
  const returnReversals = new Map(((returnReversalsResult.data ?? []) as ReturnReversal[]).map((reversal) => [reversal.supplier_return_id, reversal]));
  const activeReturnIds = new Set(returns.filter((supplierReturn) => !returnReversals.has(supplierReturn.id)).map((supplierReturn) => supplierReturn.id));
  const returnedQuantityByPurchaseItem = new Map<string, number>();
  for (const line of (returnLinesResult.data ?? []) as unknown as ReturnLine[]) {
    if (activeReturnIds.has(line.supplier_return_id)) {
      returnedQuantityByPurchaseItem.set(line.purchase_item_id, (returnedQuantityByPurchaseItem.get(line.purchase_item_id) ?? 0) + line.quantity);
    }
  }
  const stockBucketKey = (productId: string, variantId: string | null, condition: string) => `${productId}:${variantId ?? "BASE"}:${condition}`;
  const stockBucketsByKey = new Map(((stockBucketsResult.data ?? []) as StockBucket[]).map((bucket) => [stockBucketKey(bucket.product_id, bucket.variant_id, bucket.condition), bucket]));
  const returnableNonSerializedLines = items.filter((item) => !item.products?.serialized).map((item) => {
    const previouslyReturned = returnedQuantityByPurchaseItem.get(item.id) ?? 0;
    const originalRemaining = Math.max(item.quantity - previouslyReturned, 0);
    const bucket = stockBucketsByKey.get(stockBucketKey(item.product_id, item.variant_id, item.condition));
    return {
      purchaseItemId: item.id,
      lineNumber: item.line_number,
      productName: item.products?.name ?? "Product unavailable",
      variantLabel: item.product_variants?.label ?? null,
      condition: item.condition,
      originalQuantity: item.quantity,
      returnedQuantity: previouslyReturned,
      returnableQuantity: Math.min(originalRemaining, Math.max(bucket?.quantity ?? 0, 0)),
      unitCost: item.unit_cost ?? 0,
    };
  });
  const returnableSerializedUnits = items.filter((item) => item.products?.serialized).flatMap((item) => (unitsByItem.get(item.id) ?? [])
    .filter((unit) => unit.status === "AVAILABLE")
    .map((unit) => ({
      unitId: unit.id,
      purchaseItemId: item.id,
      lineNumber: item.line_number,
      productName: item.products?.name ?? "Product unavailable",
      variantLabel: item.product_variants?.label ?? null,
      condition: unit.condition,
      acquisitionCost: unit.acquisition_cost,
      identifiers: identifiers(unit),
    })));
  const returnFinancials = new Map(((returnFinancialsResult.data ?? []) as ReturnFinancialSummary[]).map((financial) => [financial.supplier_return_id, financial]));
  const receiptsByReturn = new Map<string, RefundReceipt[]>();
  for (const receipt of refundReceipts) receiptsByReturn.set(receipt.supplier_return_id, [...(receiptsByReturn.get(receipt.supplier_return_id) ?? []), receipt]);
  const receiptReversals = new Map(((refundReceiptReversalsResult.data ?? []) as RefundReceiptReversal[]).map((reversal) => [reversal.supplier_refund_receipt_id, reversal]));

  const financial = financialResult.data as FinancialSummary | null;
  const supplier = supplierResult.data as { id: string; business_name: string; active: boolean } | null;
  const purchaseReversal = purchaseReversalResult.data as PurchaseReversal | null;
  const canRecordPayment = Boolean(financial && !financialResult.error && financial.purchase_state === "ACTIVE" && Number(financial.amount_still_payable) > 0);
  const canReversePayment = profile.role === "ADMIN" && financial?.purchase_state === "ACTIVE";
  const linesUnavailable = Boolean(itemsResult.error || unitsResult.error);
  const returnEligibilityUnavailable = Boolean(stockBucketsResult.error);
  const canFinalizeReturn = Boolean(financial && !financialResult.error && financial.purchase_state === "ACTIVE" && !linesUnavailable && !returnEligibilityUnavailable);
  const paymentHistoryUnavailable = Boolean(paymentsResult.error || paymentReversalsResult.error);
  const returnHistoryUnavailable = Boolean(returnsResult.error || returnLinesResult.error || returnReversalsResult.error || returnFinancialsResult.error || refundReceiptsResult.error || refundReceiptReversalsResult.error);
  const purchaseReversalAdvisories = [
    ...(returns.length ? ["Supplier-return history exists. A purchase with supplier-return history cannot be reversed."] : []),
    ...(payments.some((payment) => paymentReversals.has(payment.id)) ? ["A supplier payment was already reversed independently."] : []),
    ...(items.filter((item) => item.products?.serialized).flatMap((item) => unitsByItem.get(item.id) ?? []).some((unit) => unit.status !== "AVAILABLE") ? ["At least one purchased serialized unit is no longer AVAILABLE."] : []),
  ];
  const canSubmitPurchaseReversal = profile.role === "ADMIN" && financial?.purchase_state === "ACTIVE" && purchaseReversalAdvisories.length === 0;

  return <main className="app-page">
    <p className="app-eyebrow">PROCUREMENT · IMMUTABLE PURCHASE</p>
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><div className="flex flex-wrap items-center gap-2"><h1 className="app-page-title">Purchase #{purchase.purchase_number}</h1>{financial ? <span className={`app-status ${financial.purchase_state === "REVERSED" ? "app-status-archived" : "app-status-active"}`}>{statusLabel(financial.purchase_state)}</span> : null}</div><p className="app-page-subtitle">Completed receipt recorded {formatDate(purchase.received_on)}.</p></div>
      <Link className="app-button-secondary inline-flex w-fit items-center px-3" href="/app/purchases">Back to purchases</Link>
    </div>

    <Section title="Purchase header"><dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div><dt className="font-medium text-slate-500">Historical supplier</dt><dd className="mt-1 font-medium text-slate-900">{purchase.supplier_name_snapshot}</dd>{supplier ? <Link className="mt-1 inline-block text-[var(--tg-navy)] underline" href={`/app/suppliers/${supplier.id}`}>View current supplier record{supplier.active ? "" : " (archived)"}</Link> : null}</div>
      <div><dt className="font-medium text-slate-500">Received date</dt><dd className="mt-1 text-slate-900">{formatDate(purchase.received_on)}</dd></div>
      <div><dt className="font-medium text-slate-500">Supplier reference</dt><dd className="mt-1 break-words text-slate-900">{purchase.supplier_reference ?? "Not recorded"}</dd></div>
      <div><dt className="font-medium text-slate-500">Purchase total</dt><dd className="mt-1 text-slate-900">{formatCurrency(purchase.total)}</dd></div>
      <div><dt className="font-medium text-slate-500">Purchase state</dt><dd className="mt-1 text-slate-900">{financial ? statusLabel(financial.purchase_state) : "Unavailable"}</dd></div>
      <div><dt className="font-medium text-slate-500">Created</dt><dd className="mt-1 text-slate-900">{formatTimestamp(purchase.created_at)}</dd></div>
      <div className="sm:col-span-2 lg:col-span-3"><dt className="font-medium text-slate-500">Notes</dt><dd className="mt-1 whitespace-pre-wrap text-slate-900">{purchase.notes ?? "No notes recorded"}</dd></div>
    </dl></Section>

    <Section title="Financial summary">{financialResult.error || !financial ? <p className="p-4 text-sm text-slate-600">Financial summary is temporarily unavailable. Check your connection and try again.</p> : <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Original purchase total</dt><dd className="mt-1 font-semibold text-slate-900">{formatCurrency(financial.historical_original_total)}</dd></div><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Active return value</dt><dd className="mt-1 font-semibold text-slate-900">{formatCurrency(financial.active_return_value)}</dd></div><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Net supplier payments</dt><dd className="mt-1 font-semibold text-slate-900">{formatCurrency(financial.net_supplier_payments)}</dd></div><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Remaining payable</dt><dd className="mt-1 font-semibold text-slate-900">{formatCurrency(financial.amount_still_payable)}</dd></div><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Payment status</dt><dd className="mt-1 font-semibold text-slate-900">{statusLabel(financial.payment_status)}</dd></div><div className="rounded border border-slate-200 p-3"><dt className="text-slate-500">Purchase state</dt><dd className="mt-1 font-semibold text-slate-900">{statusLabel(financial.purchase_state)}</dd></div></dl>}</Section>

    {canRecordPayment ? <Section title="Record supplier payment"><RecordSupplierPaymentForm lagosToday={lagosToday()} purchaseId={purchase.id} /></Section> : null}

    {canFinalizeReturn && financial ? <Section title="Return to supplier"><SupplierReturnForm financialContext={{ originalTotal: financial.historical_original_total, activeReturnValue: financial.active_return_value, netPayments: financial.net_supplier_payments, remainingPayable: financial.amount_still_payable, paymentStatus: financial.payment_status }} lagosToday={lagosToday()} nonSerializedLines={returnableNonSerializedLines} purchaseId={purchase.id} serializedUnits={returnableSerializedUnits} /></Section> : null}
    {financial?.purchase_state === "ACTIVE" && !canFinalizeReturn ? <Section title="Return to supplier"><p className="p-4 text-sm text-slate-600">Return eligibility is temporarily unavailable. Check your connection and try again.</p></Section> : null}

    <Section title="Purchase lines">{linesUnavailable ? <p className="p-4 text-sm text-slate-600">Purchase lines are temporarily unavailable. Check your connection and try again.</p> : items.length ? <div className="divide-y">{items.map((item) => {
      const serializedUnits = unitsByItem.get(item.id) ?? [];
      const serialized = Boolean(item.products?.serialized);
      const serializedValue = serializedUnits.reduce((total, unit) => total + Number(unit.acquisition_cost), 0);
      return <article key={item.id} className="p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">Line {item.line_number} · {item.products?.name ?? "Product unavailable"}</h3><span className="app-status app-status-active">{serialized ? "Serialized" : "Non-serialized"}</span></div><p className="mt-1 text-sm text-slate-600">{item.products?.sku ?? "SKU unavailable"}{item.product_variants ? ` · ${item.product_variants.label}${item.product_variants.sku ? ` (${item.product_variants.sku})` : ""}` : " · Base"}</p></div><dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-sm text-slate-600 sm:text-right"><div><dt className="sr-only">Condition</dt><dd>{statusLabel(item.condition)}</dd></div><div><dt className="sr-only">Quantity</dt><dd>Qty {item.quantity}</dd></div><div><dt className="sr-only">Cost</dt><dd>{serialized ? "Per-unit costs below" : `Unit cost ${formatCurrency(item.unit_cost ?? 0)}`}</dd></div><div><dt className="sr-only">Line value</dt><dd>Value {formatCurrency(serialized ? serializedValue : Number(item.unit_cost ?? 0) * item.quantity)}</dd></div></dl></div>{item.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{item.notes}</p> : null}
      {serialized ? <div className="mt-4 grid gap-3 md:grid-cols-2">{serializedUnits.map((unit, index) => <article key={`${item.id}-${index}`} className="rounded border border-slate-200 p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-slate-900">Serialized unit {index + 1}</p><span className="app-status app-status-active">{statusLabel(unit.status)}</span></div><p className="mt-2 text-slate-700">{statusLabel(unit.condition)} · Cost {formatCurrency(unit.acquisition_cost)}</p><p className="mt-1 text-slate-600">Warranty {unit.warranty_start ? formatDate(unit.warranty_start) : "not recorded"} — {unit.warranty_expiry ? formatDate(unit.warranty_expiry) : "not recorded"}</p><p className="mt-2 break-words text-slate-600">{identifiers(unit)}</p></article>)}{serializedUnits.length === 0 ? <p className="text-sm text-slate-600">No serialized units are available for this line.</p> : null}</div> : null}</article>;
    })}</div> : <p className="p-4 text-sm text-slate-600">No purchase lines are recorded.</p>}</Section>

    <Section title="Payment history">{paymentHistoryUnavailable ? <p className="p-4 text-sm text-slate-600">Payment history is temporarily unavailable. Check your connection and try again.</p> : payments.length ? <div className="divide-y">{payments.map((payment) => { const reversal = paymentReversals.get(payment.id); return <article key={payment.id} className="grid gap-2 p-4 text-sm md:grid-cols-[minmax(0,1fr)_auto]"><div><p className="font-medium text-slate-900">{formatCurrency(payment.amount)} · {statusLabel(payment.method)}</p><p className="mt-1 text-slate-600">Paid {formatDate(payment.paid_on)}{payment.reference ? ` · Ref: ${payment.reference}` : ""}</p>{payment.notes ? <p className="mt-1 whitespace-pre-wrap text-slate-700">{payment.notes}</p> : null}{reversal ? <p className="mt-2 text-red-700">Reversed {formatTimestamp(reversal.created_at)} · {reversal.reason}</p> : null}</div><span className={`app-status ${reversal ? "app-status-archived" : "app-status-active"}`}>{reversal ? "Reversed" : "Active"}</span></article>; })}</div> : <p className="p-4 text-sm text-slate-600">No supplier payments are recorded.</p>}</Section>

    {canReversePayment && payments.some((payment) => !paymentReversals.has(payment.id)) ? <Section title="Admin payment reversals"><div className="space-y-3 p-4"><p className="text-sm text-slate-600">Reversals are permanent history entries. The database confirms whether each active payment remains eligible.</p>{payments.filter((payment) => !paymentReversals.has(payment.id)).map((payment) => <article className="rounded border border-red-200 p-3" key={payment.id}><p className="text-sm font-medium text-slate-900">{formatCurrency(payment.amount)} · {statusLabel(payment.method)} · paid {formatDate(payment.paid_on)}</p><ReverseSupplierPaymentForm paymentId={payment.id} purchaseId={purchase.id} /></article>)}</div></Section> : null}

    {financial?.purchase_state === "ACTIVE" ? <Section title="Purchase reversal"><div className="space-y-3 p-4"><p className="text-sm text-slate-600">Purchase reversal is permanent. Final eligibility, financial safety, and inventory/lifecycle checks are performed by the database when submitted.</p>{purchaseReversalAdvisories.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">{purchaseReversalAdvisories.map((advisory) => <li key={advisory}>{advisory}</li>)}</ul> : <p className="text-sm text-slate-600">No known history blocker is currently shown. The database still makes the final eligibility decision.</p>}{profile.role === "ADMIN" && canSubmitPurchaseReversal ? <ReversePurchaseForm purchaseId={purchase.id} /> : profile.role === "ADMIN" ? <p className="text-sm text-slate-600">Resolve the known blocker before requesting a purchase reversal.</p> : <p className="text-sm text-slate-600">Purchase reversals require an administrator.</p>}</div></Section> : null}

    <Section title="Supplier return and refund history">{returnHistoryUnavailable ? <p className="p-4 text-sm text-slate-600">Supplier return history is temporarily unavailable. Check your connection and try again.</p> : returns.length ? <div className="divide-y">{returns.map((supplierReturn) => {
      const reversal = returnReversals.get(supplierReturn.id);
      const returnFinancial = returnFinancials.get(supplierReturn.id);
      const activeRefundReceipts = (receiptsByReturn.get(supplierReturn.id) ?? []).filter((receipt) => !receiptReversals.has(receipt.id));
      const canRecordRefundReceipt = Boolean(!reversal && returnFinancial && Number(returnFinancial.remaining_refund_due) > 0 && (returnFinancial.refund_status === "REFUND_DUE" || returnFinancial.refund_status === "PARTIALLY_REFUNDED"));
      const canSubmitSupplierReturnReversal = profile.role === "ADMIN" && !reversal && activeRefundReceipts.length === 0;
      return <article key={supplierReturn.id} className="p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">Return #{supplierReturn.return_number}</h3><span className={`app-status ${reversal ? "app-status-archived" : "app-status-active"}`}>{reversal ? "Reversed" : "Active"}</span></div><p className="mt-1 text-sm text-slate-600">Returned {formatDate(supplierReturn.returned_on)} · Order {supplierReturn.return_order}{supplierReturn.supplier_reference ? ` · Ref: ${supplierReturn.supplier_reference}` : ""}</p><p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{supplierReturn.reason}</p></div><p className="font-medium text-slate-900">Return value {formatCurrency(supplierReturn.total)}</p></div>
      {reversal ? <p className="mt-3 text-sm text-red-700">Reversed {formatTimestamp(reversal.created_at)} · {reversal.reason}</p> : null}
      {returnFinancial ? <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-4"><div><dt className="text-slate-500">Refund status</dt><dd className="font-medium text-slate-900">{statusLabel(returnFinancial.refund_status)}</dd></div><div><dt className="text-slate-500">Entitlement</dt><dd>{formatCurrency(returnFinancial.refund_entitlement)}</dd></div><div><dt className="text-slate-500">Refund received</dt><dd>{formatCurrency(returnFinancial.active_refund_receipts)}</dd></div><div><dt className="text-slate-500">Refund due</dt><dd>{formatCurrency(returnFinancial.remaining_refund_due)}</dd></div></dl> : null}
      {canRecordRefundReceipt && returnFinancial ? <div className="mt-4 rounded border border-[var(--tg-gold)] bg-amber-50/50"><div className="border-b border-[var(--tg-gold)] p-3"><h4 className="font-semibold text-[var(--tg-navy)]">Record supplier refund</h4><p className="mt-1 text-sm text-slate-600">Record a partial or full refund receipt against this active supplier return.</p></div><RecordSupplierRefundReceiptForm lagosToday={lagosToday()} remainingRefundDue={returnFinancial.remaining_refund_due} supplierReturnId={supplierReturn.id} /></div> : null}
      {!reversal && activeRefundReceipts.length ? <p className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">Active refund receipts must be reversed before this supplier return can be reversed.</p> : null}
      {profile.role === "ADMIN" && canSubmitSupplierReturnReversal ? <div className="mt-4"><ReverseSupplierReturnForm supplierReturnId={supplierReturn.id} /></div> : null}
      {profile.role === "MANAGER" && !reversal && !activeRefundReceipts.length ? <p className="mt-4 text-sm text-slate-600">Supplier return reversals require an administrator.</p> : null}
      <div className="mt-4 space-y-2">{(returnLinesByReturn.get(supplierReturn.id) ?? []).map((line, index) => <div className="rounded border border-slate-200 p-3 text-sm" key={`${supplierReturn.id}-${index}`}><p className="font-medium text-slate-900">Line {line.purchase_items?.line_number ?? "—"} · {line.purchase_items?.products?.name ?? "Purchase product"}{line.purchase_items?.product_variants ? ` · ${line.purchase_items.product_variants.label}` : ""}</p><p className="mt-1 text-slate-600">Qty {line.quantity} · {statusLabel(line.purchase_items?.condition ?? "UNKNOWN")} · Original acquisition value {formatCurrency(line.return_value)} ({formatCurrency(line.source_unit_cost)} each)</p>{line.serialized_units ? <p className="mt-1 break-words text-slate-600">{identifiers(line.serialized_units)}</p> : null}</div>)}</div>
      <div className="mt-4"><h4 className="text-sm font-semibold text-slate-900">Refund receipts</h4>{(receiptsByReturn.get(supplierReturn.id) ?? []).length ? <div className="mt-2 space-y-2">{(receiptsByReturn.get(supplierReturn.id) ?? []).map((receipt) => { const receiptReversal = receiptReversals.get(receipt.id); return <div className="rounded border border-slate-200 p-3 text-sm" key={receipt.id}><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-slate-900">{formatCurrency(receipt.amount)} · {statusLabel(receipt.method)}</p><span className={`app-status ${receiptReversal ? "app-status-archived" : "app-status-active"}`}>{receiptReversal ? "Reversed" : "Active"}</span></div><p className="mt-1 text-slate-600">Received {formatDate(receipt.received_on)}{receipt.reference ? ` · Ref: ${receipt.reference}` : ""}</p>{receipt.notes ? <p className="mt-1 whitespace-pre-wrap text-slate-700">{receipt.notes}</p> : null}{receiptReversal ? <p className="mt-2 text-red-700">Reversed {formatTimestamp(receiptReversal.created_at)} · {receiptReversal.reason}</p> : null}</div>; })}</div> : <p className="mt-1 text-sm text-slate-600">No refund receipts are recorded.</p>}</div>
      {profile.role === "ADMIN" && activeRefundReceipts.length ? <div className="mt-4 rounded border border-red-200 bg-red-50/50 p-3"><h4 className="text-sm font-semibold text-red-800">Admin refund receipt reversals</h4><p className="mt-1 text-sm text-slate-600">Reversals are permanent history entries. The database confirms whether each active receipt remains eligible.</p><div className="mt-3 space-y-3">{activeRefundReceipts.map((receipt) => <article className="rounded border border-red-200 bg-white p-3" key={receipt.id}><p className="text-sm font-medium text-slate-900">{formatCurrency(receipt.amount)} · {statusLabel(receipt.method)} · received {formatDate(receipt.received_on)}</p><ReverseSupplierRefundReceiptForm purchaseId={purchase.id} refundReceiptId={receipt.id} /></article>)}</div></div> : null}
      </article>;
    })}</div> : <p className="p-4 text-sm text-slate-600">No supplier returns are recorded.</p>}</Section>

    {purchaseReversalResult.error ? <Section title="Reversal history"><p className="p-4 text-sm text-slate-600">Purchase reversal history is temporarily unavailable. Check your connection and try again.</p></Section> : purchaseReversal ? <Section title="Reversal history"><article className="p-4 text-sm"><p className="font-medium text-slate-900">Purchase reversed {formatTimestamp(purchaseReversal.created_at)}</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{purchaseReversal.reason}</p></article></Section> : null}
  </main>;
}
