import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { canManageProcurement } from "@/lib/authorization";
import { SupplierCreateForm } from "../supplier-forms";

export const dynamic = "force-dynamic";

export default async function NewSupplierPage() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  if (!canManageProcurement(profile.role)) redirect("/app");

  return <main className="app-page"><p className="app-eyebrow">PROCUREMENT</p><div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="app-page-title">New supplier</h1><p className="app-page-subtitle">Add a supplier record for future procurement activity.</p></div><Link className="app-button-secondary inline-flex w-fit items-center px-3" href="/app/suppliers">Back to suppliers</Link></div><SupplierCreateForm/></main>;
}
