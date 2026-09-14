"use client";

import { useActionState } from "react";
import { archiveSupplier, createSupplier, updateActiveSupplier, updateArchivedSupplierContact } from "./supplier-actions";
import { initialSupplierActionState } from "./supplier-action-state";

export type SupplierFormSupplier = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
};

function Feedback({ state }: { state: typeof initialSupplierActionState }) {
  if (state.status === "idle") return null;
  return <p className={`mt-3 text-sm ${state.status === "success" ? "text-emerald-700" : "text-red-700"}`} role="status">{state.message}</p>;
}

function ContactFields({ supplier }: { supplier?: SupplierFormSupplier }) {
  return <div className="mt-4 grid gap-4 sm:grid-cols-2">
    <label className="block text-sm font-medium text-slate-700">Contact name<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.contact_name ?? ""} name="contactName" /></label>
    <label className="block text-sm font-medium text-slate-700">Phone<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.phone ?? ""} name="phone" type="tel" /></label>
    <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Email<input className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.email ?? ""} name="email" type="email" /></label>
    <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Address<textarea className="mt-1 min-h-24 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.address ?? ""} name="address" /></label>
    <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Notes<textarea className="mt-1 min-h-24 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.notes ?? ""} name="notes" /></label>
  </div>;
}

function ActiveSupplierFields({ supplier }: { supplier?: SupplierFormSupplier }) {
  return <>
    <label className="mt-4 block text-sm font-medium text-slate-700">Business name<input required className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 font-normal" defaultValue={supplier?.business_name ?? ""} name="businessName" /></label>
    <ContactFields supplier={supplier} />
  </>;
}

export function SupplierCreateForm() {
  const [state, action] = useActionState(createSupplier, initialSupplierActionState);

  return <form action={action} className="app-panel mx-auto max-w-2xl p-4 sm:p-6"><h2 className="font-semibold text-[var(--tg-navy)]">Supplier details</h2><p className="mt-1 text-sm text-slate-600">A business name is required. Contact details are optional.</p><ActiveSupplierFields/><button className="app-button-primary mt-5 w-full px-4 sm:w-auto" type="submit">Create supplier</button><Feedback state={state}/></form>;
}

export function ActiveSupplierControls({ supplier }: { supplier: SupplierFormSupplier }) {
  const [updateState, updateAction] = useActionState(updateActiveSupplier, initialSupplierActionState);
  const [archiveState, archiveAction] = useActionState(archiveSupplier, initialSupplierActionState);

  return <section className="mt-5 space-y-5" aria-label="Supplier management">
    <form action={updateAction} className="app-panel p-4 sm:p-6">
      <h2 className="font-semibold text-[var(--tg-navy)]">Edit supplier</h2>
      <p className="mt-1 text-sm text-slate-600">Update the active supplier’s business and contact details.</p>
      <input name="id" type="hidden" value={supplier.id} />
      <ActiveSupplierFields supplier={supplier} />
      <button className="app-button-primary mt-5 w-full px-4 sm:w-auto" type="submit">Save supplier changes</button>
      <Feedback state={updateState}/>
    </form>

    <form action={archiveAction} className="rounded-lg border border-red-200 bg-red-50 p-4 sm:p-6">
      <h2 className="font-semibold text-red-900">Archive supplier</h2>
      <p className="mt-1 text-sm text-red-900">Archiving preserves supplier history. Reactivation is not available.</p>
      <input name="id" type="hidden" value={supplier.id} />
      <label className="mt-4 flex items-start gap-3 text-sm text-red-900"><input className="mt-1 size-4" name="archiveConfirmed" required type="checkbox" value="yes" />I understand this supplier will be archived and cannot be reactivated here.</label>
      <button className="mt-5 w-full rounded bg-red-800 px-4 py-2 font-medium text-white hover:bg-red-900 sm:w-auto" type="submit">Archive supplier</button>
      <Feedback state={archiveState}/>
    </form>
  </section>;
}

export function ArchivedSupplierContactControls({ supplier }: { supplier: SupplierFormSupplier }) {
  const [state, action] = useActionState(updateArchivedSupplierContact, initialSupplierActionState);

  return <section className="app-panel mt-5 p-4 sm:p-6" aria-label="Archived supplier contact management">
    <h2 className="font-semibold text-[var(--tg-navy)]">Edit contact details</h2>
    <p className="mt-1 text-sm text-slate-600">This supplier is archived. Its business name is historical identity and cannot be changed. Reactivation is not available.</p>
    <form action={action}>
      <input name="id" type="hidden" value={supplier.id} />
      <ContactFields supplier={supplier} />
      <button className="app-button-primary mt-5 w-full px-4 sm:w-auto" type="submit">Save contact details</button>
      <Feedback state={state}/>
    </form>
  </section>;
}
