"use client";

import { FormEvent, useMemo, useState, useTransition } from "react";
import { CameraScanButton } from "../../inventory/camera-scan";
import { finalizeOrdinarySale, searchSerializedUnitsForSale } from "../actions";
import type { SerializedSaleUnit } from "../action-state";
import {
  checkoutLineKey,
  checkoutLinesRpcPayload,
  checkoutPaymentsRpcPayload,
  displayedCheckoutTotal,
  paymentTotal,
  type CheckoutCartLine,
  type CheckoutPayment,
  type SaleCondition,
  type SalePaymentMethod,
} from "../checkout-payload";

type CatalogueRow = {
  product_id: string;
  product_name: string;
  product_sku: string;
  variant_id: string | null;
  variant_label: string | null;
  condition: SaleCondition;
  quantity: number;
  selling_price: number;
};

function money(value: number) {
  return `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function freshPayment(total = 0): CheckoutPayment {
  return { id: crypto.randomUUID(), method: "CASH", amount: total ? total.toFixed(2) : "", reference: "", notes: "" };
}

function sameMoney(a: number, b: number) {
  return Math.round(a * 100) === Math.round(b * 100);
}

export function CheckoutForm({ catalogueRows, today }: { catalogueRows: CatalogueRow[]; today: string }) {
  const [cart, setCart] = useState<CheckoutCartLine[]>([]);
  const [payments, setPayments] = useState<CheckoutPayment[]>([freshPayment()]);
  const [productSearch, setProductSearch] = useState("");
  const [serializedSearch, setSerializedSearch] = useState("");
  const [serializedResults, setSerializedResults] = useState<SerializedSaleUnit[]>([]);
  const [serializedMessage, setSerializedMessage] = useState("");
  const [transactionOn, setTransactionOn] = useState(today);
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [submitMessage, setSubmitMessage] = useState("");
  const [completedSale, setCompletedSale] = useState<{ saleNumber: number; finalTotal: number } | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [isSearching, startSearch] = useTransition();

  const total = useMemo(() => displayedCheckoutTotal(cart), [cart]);
  const paid = useMemo(() => paymentTotal(payments), [payments]);
  const filteredCatalogue = useMemo(() => {
    const q = productSearch.trim().toLocaleLowerCase();
    if (!q) return catalogueRows;
    return catalogueRows.filter((row) => [row.product_name, row.product_sku, row.variant_label, row.condition]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(q)));
  }, [catalogueRows, productSearch]);

  function rotateRequest() {
    setRequestId(crypto.randomUUID());
    setCompletedSale(null);
    setSubmitMessage("");
  }

  function commitCart(nextCart: CheckoutCartLine[]) {
    setCart(nextCart);
    const nextTotal = displayedCheckoutTotal(nextCart);
    setPayments((current) => current.length === 1
      ? [{ ...current[0], amount: nextTotal ? nextTotal.toFixed(2) : "" }]
      : current);
  }

  function addNonserialized(row: CatalogueRow) {
    if (row.quantity <= 0) return;
    rotateRequest();
    const key = `${row.product_id}:${row.variant_id ?? "base"}:${row.condition}`;
    const existing = cart.find((line) => checkoutLineKey(line) === key);
    const next = existing
      ? cart.map((line) => checkoutLineKey(line) === key ? { ...line, quantity: Math.min(line.quantity + 1, row.quantity) } : line)
      : [...cart, {
          productId: row.product_id,
          variantId: row.variant_id,
          productName: row.product_name,
          variantLabel: row.variant_label,
          condition: row.condition,
          serialized: false,
          sellingPrice: Number(row.selling_price),
          quantity: 1,
          availableQuantity: row.quantity,
          serializedUnitIds: [],
          serializedIdentifiers: [],
        }];
    commitCart(next);
  }

  function addSerialized(unit: SerializedSaleUnit) {
    if (unit.sellingPrice === null) {
      setSerializedMessage("This unit does not currently have an active selling price.");
      return;
    }
    if (cart.some((line) => line.serializedUnitIds.includes(unit.unitId))) return;
    rotateRequest();
    const key = `${unit.productId}:${unit.variantId ?? "base"}:${unit.condition}`;
    const existing = cart.find((line) => checkoutLineKey(line) === key);
    const next = existing
      ? cart.map((line) => checkoutLineKey(line) === key ? {
          ...line,
          quantity: line.quantity + 1,
          serializedUnitIds: [...line.serializedUnitIds, unit.unitId],
          serializedIdentifiers: [...line.serializedIdentifiers, `${unit.identifierType}: ${unit.identifierValue}`],
        } : line)
      : [...cart, {
          productId: unit.productId,
          variantId: unit.variantId,
          productName: unit.productName,
          variantLabel: unit.variantLabel,
          condition: unit.condition,
          serialized: true,
          sellingPrice: unit.sellingPrice,
          quantity: 1,
          availableQuantity: null,
          serializedUnitIds: [unit.unitId],
          serializedIdentifiers: [`${unit.identifierType}: ${unit.identifierValue}`],
        }];
    commitCart(next);
  }

  function decrementLine(key: string) {
    rotateRequest();
    const next = cart.flatMap((line) => {
      if (checkoutLineKey(line) !== key) return [line];
      if (line.quantity <= 1) return [];
      return [{
        ...line,
        quantity: line.quantity - 1,
        serializedUnitIds: line.serialized ? line.serializedUnitIds.slice(0, -1) : line.serializedUnitIds,
        serializedIdentifiers: line.serialized ? line.serializedIdentifiers.slice(0, -1) : line.serializedIdentifiers,
      }];
    });
    commitCart(next);
  }

  function removeLine(key: string) {
    rotateRequest();
    const next = cart.filter((line) => checkoutLineKey(line) !== key);
    commitCart(next);
  }

  function searchSerialized(query = serializedSearch) {
    const value = query.trim();
    setSerializedSearch(value);
    if (!value) {
      setSerializedMessage("Enter an IMEI, serial, SKU, barcode, or product name.");
      setSerializedResults([]);
      return;
    }
    startSearch(async () => {
      const result = await searchSerializedUnitsForSale(value);
      if (result.status === "error") {
        setSerializedMessage(result.message);
        setSerializedResults([]);
        return;
      }
      setSerializedResults(result.units);
      setSerializedMessage(result.units.length ? "" : "No available serialized units matched this search.");
    });
  }

  function updatePayment(id: string, patch: Partial<CheckoutPayment>) {
    rotateRequest();
    setPayments((current) => current.map((payment) => payment.id === id ? { ...payment, ...patch } : payment));
  }

  function removePayment(id: string) {
    rotateRequest();
    setPayments((current) => current.length === 1 ? current : current.filter((payment) => payment.id !== id));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitMessage("");
    if (!cart.length) {
      setSubmitMessage("Add at least one item to the cart.");
      return;
    }
    if (!sameMoney(paid, total)) {
      setSubmitMessage(`Payments must total exactly ${money(total)}.`);
      return;
    }

    const payload = {
      requestId,
      transactionOn,
      notes,
      lines: checkoutLinesRpcPayload(cart).map((line) => ({
        productId: line.product_id,
        variantId: line.variant_id,
        condition: line.condition,
        quantity: line.quantity,
        serializedUnitIds: line.serialized_unit_ids,
      })),
      payments: checkoutPaymentsRpcPayload(payments, transactionOn).map((payment) => ({
        amount: payment.amount,
        method: payment.method,
        paidOn: payment.paid_on,
        reference: payment.reference,
        notes: payment.notes,
      })),
    };

    startSubmit(async () => {
      const result = await finalizeOrdinarySale(payload);
      if (result.status === "error") {
        setSubmitMessage(result.message);
        return;
      }
      setCompletedSale({ saleNumber: result.sale.saleNumber, finalTotal: result.sale.finalTotal });
      setSubmitMessage(result.message);
      setCart([]);
      setPayments([freshPayment()]);
      setNotes("");
      setRequestId(crypto.randomUUID());
      setSerializedResults([]);
      setSerializedSearch("");
    });
  }

  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
    <div className="space-y-5">
      <section className="app-panel p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="app-eyebrow">NON-SERIALIZED STOCK</p><h2 className="mt-1 text-xl font-semibold text-[var(--tg-navy)]">Add catalogue items</h2></div>
          <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} className="min-h-11 rounded border border-slate-300 px-3 py-2 text-sm sm:w-72" placeholder="Search name, SKU, condition" aria-label="Search sellable non-serialized products" />
        </div>
        <div className="mt-4 grid max-h-[30rem] gap-2 overflow-auto pr-1 md:grid-cols-2">
          {filteredCatalogue.length ? filteredCatalogue.map((row) => <button key={`${row.product_id}-${row.variant_id ?? "base"}-${row.condition}`} type="button" disabled={row.quantity <= 0} onClick={() => addNonserialized(row)} className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-[var(--tg-gold)] disabled:cursor-not-allowed disabled:opacity-50">
            <b className="text-[var(--tg-navy)]">{row.product_name}{row.variant_label ? ` — ${row.variant_label}` : ""}</b>
            <span className="mt-1 block text-sm text-slate-600">{row.product_sku} · {row.condition}</span>
            <span className="mt-2 block text-sm font-medium">{money(Number(row.selling_price))} · Stock {row.quantity}</span>
          </button>) : <p className="text-sm text-slate-600">No matching sellable non-serialized stock.</p>}
        </div>
      </section>

      <section className="app-panel p-5">
        <p className="app-eyebrow">SERIALIZED STOCK</p><h2 className="mt-1 text-xl font-semibold text-[var(--tg-navy)]">Search IMEI / serial</h2>
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); searchSerialized(); }}>
          <input value={serializedSearch} onChange={(event) => setSerializedSearch(event.target.value)} className="min-h-11 flex-1 rounded border border-slate-300 px-3 py-2 text-sm" placeholder="IMEI, serial, SKU, barcode or product name" aria-label="Search serialized stock" />
          <button className="app-button-secondary px-4" type="submit" disabled={isSearching}>{isSearching ? "Searching…" : "Search"}</button>
        </form>
        <CameraScanButton onScan={(value) => searchSerialized(value)} />
        {serializedMessage ? <p className="mt-2 text-sm text-slate-600">{serializedMessage}</p> : null}
        <div className="mt-3 space-y-2">
          {serializedResults.map((unit) => <button key={unit.unitId} type="button" onClick={() => addSerialized(unit)} disabled={unit.sellingPrice === null || cart.some((line) => line.serializedUnitIds.includes(unit.unitId))} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-[var(--tg-gold)] disabled:cursor-not-allowed disabled:opacity-50">
            <b className="text-[var(--tg-navy)]">{unit.productName}{unit.variantLabel ? ` — ${unit.variantLabel}` : ""}</b>
            <span className="mt-1 block text-sm text-slate-600">{unit.productSku} · {unit.condition} · {unit.identifierType}: {unit.identifierValue}</span>
            <span className="mt-2 block text-sm font-medium">{unit.sellingPrice === null ? "Price not configured" : money(unit.sellingPrice)}</span>
          </button>)}
        </div>
      </section>
    </div>

    <form className="app-panel h-fit p-5 xl:sticky xl:top-5" onSubmit={submit}>
      <p className="app-eyebrow">CHECKOUT</p><h2 className="mt-1 text-xl font-semibold text-[var(--tg-navy)]">Current sale</h2>
      <div className="mt-4 space-y-2">
        {cart.length ? cart.map((line) => { const key = checkoutLineKey(line); return <article key={key} className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-start justify-between gap-3"><div><b>{line.productName}{line.variantLabel ? ` — ${line.variantLabel}` : ""}</b><p className="text-sm text-slate-600">{line.condition} · {line.serialized ? "Serialized" : "Non-serialized"}</p></div><button type="button" onClick={() => removeLine(key)} className="text-sm font-medium text-red-700">Remove</button></div>
          {line.serializedIdentifiers.length ? <p className="mt-2 text-xs text-slate-600">{line.serializedIdentifiers.join(" · ")}</p> : null}
          <div className="mt-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><button type="button" className="app-button-secondary min-h-9 px-3" onClick={() => decrementLine(key)}>−</button><span className="min-w-8 text-center font-semibold">{line.quantity}</span>{!line.serialized ? <button type="button" className="app-button-secondary min-h-9 px-3" disabled={line.availableQuantity !== null && line.quantity >= line.availableQuantity} onClick={() => addNonserialized({ product_id: line.productId, product_name: line.productName, product_sku: "", variant_id: line.variantId, variant_label: line.variantLabel, condition: line.condition, quantity: line.availableQuantity ?? line.quantity, selling_price: line.sellingPrice })}>+</button> : null}</div><b>{money(line.sellingPrice * line.quantity)}</b></div>
        </article>; }) : <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">Add products or serialized units to begin a sale.</p>}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-4"><div className="flex items-center justify-between text-lg"><span>Total</span><b>{money(total)}</b></div><p className="mt-1 text-xs text-slate-500">Final price is revalidated by the server when you complete the sale.</p></div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <label className="text-sm font-medium">Sale date<input type="date" max={today} value={transactionOn} onChange={(event) => { rotateRequest(); setTransactionOn(event.target.value); }} className="mt-1 min-h-11 w-full rounded border border-slate-300 px-3 py-2" required /></label>
        <label className="text-sm font-medium">Notes<textarea value={notes} onChange={(event) => { rotateRequest(); setNotes(event.target.value); }} className="mt-1 min-h-20 w-full rounded border border-slate-300 px-3 py-2" placeholder="Optional sale note" /></label>
      </div>

      <div className="mt-5"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-[var(--tg-navy)]">Payments</h3><button type="button" onClick={() => { rotateRequest(); setPayments((current) => [...current, freshPayment()]); }} className="app-button-secondary px-3 text-sm">Add split payment</button></div>
        <div className="mt-3 space-y-3">{payments.map((payment, index) => <div key={payment.id} className="rounded-lg border border-slate-200 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr] xl:grid-cols-1 2xl:grid-cols-[1fr_1fr]"><label className="text-xs font-medium text-slate-600">Method<select value={payment.method} onChange={(event) => updatePayment(payment.id, { method: event.target.value as SalePaymentMethod })} className="mt-1 min-h-11 w-full rounded border border-slate-300 px-3 py-2 text-sm"><option value="CASH">Cash</option><option value="POS">POS</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></label><label className="text-xs font-medium text-slate-600">Amount<input inputMode="decimal" value={payment.amount} onChange={(event) => updatePayment(payment.id, { amount: event.target.value })} className="mt-1 min-h-11 w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder="0.00" required /></label></div>
          <label className="mt-2 block text-xs font-medium text-slate-600">Reference<input value={payment.reference} onChange={(event) => updatePayment(payment.id, { reference: event.target.value })} className="mt-1 min-h-10 w-full rounded border border-slate-300 px-3 py-2 text-sm" placeholder="Optional POS/bank reference" /></label>
          {payments.length > 1 ? <button type="button" onClick={() => removePayment(payment.id)} className="mt-2 text-xs font-medium text-red-700">Remove payment {index + 1}</button> : null}
        </div>)}</div>
        <div className="mt-3 flex items-center justify-between text-sm"><span>Payment total</span><b className={sameMoney(paid, total) ? "text-emerald-700" : "text-amber-700"}>{money(paid)}</b></div>
      </div>

      {completedSale ? <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><b>Sale #{completedSale.saleNumber} completed.</b><p>Total {money(completedSale.finalTotal)}. Inventory and payment records were updated atomically.</p></div> : null}
      {submitMessage && !completedSale ? <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{submitMessage}</p> : null}
      <button className="app-button-primary mt-5 w-full px-4" disabled={isSubmitting || !cart.length || !sameMoney(paid, total)} type="submit">{isSubmitting ? "Completing sale…" : `Complete sale · ${money(total)}`}</button>
      <p className="mt-2 text-xs text-slate-500">This production-fast checkout currently completes fully paid ordinary sales. Discount and credit workflows remain available in the backend for the next UI update.</p>
    </form>
  </div>;
}
