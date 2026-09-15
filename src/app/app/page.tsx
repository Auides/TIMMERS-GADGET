import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  return <main className="app-page">
    <p className="app-eyebrow">OPERATIONS OVERVIEW</p>
    <h1 className="app-page-title">Good day, {profile.full_name.split(" ")[0]}.</h1>
    <p className="app-page-subtitle">You are signed in with {profile.role.toLowerCase()} operational access.</p>
    <section className="app-panel mt-7 p-5 sm:p-6">
      <p className="app-eyebrow">SALES</p>
      <h2 className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-bold text-[var(--tg-navy)]">Point of sale</h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--tg-muted)]">Complete ordinary sales with current prices, split payments, and atomic inventory updates.</p>
      <Link className="app-button-primary mt-5 inline-flex items-center px-4" href="/app/sales/new">Start a sale</Link>
    </section>
    <section className="app-panel mt-5 p-5 sm:p-6">
      <p className="app-eyebrow">CATALOGUE</p>
      <h2 className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-bold text-[var(--tg-navy)]">Product master data</h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--tg-muted)]">Search approved products, current condition prices, and safe stock availability.</p>
      <Link className="app-button-primary mt-5 inline-flex items-center px-4" href="/app/catalogue">Open catalogue</Link>
    </section>
  </main>;
}
