const modules = [
  ["Point of sale", "Sell products, accept split payments, and issue receipts", "Ready for integration"],
  ["Inventory", "Track stock, serialized units, and low-stock alerts", "Database foundation ready"],
  ["Purchases", "Receive supplier stock and preserve acquisition costs", "Database foundation ready"],
  ["Customers", "Manage customer history, returns, and credit", "Planned"],
  ["Reports", "Sales, gross profit, expenses, and stock valuation", "Planned"],
  ["Administration", "Users, permissions, settings, and audit history", "Database foundation ready"],
];

export default function Home() {
  return <main className="min-h-screen bg-stone-50 text-slate-950"><header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8"><div><p className="text-xs font-bold tracking-[0.2em] text-amber-600">TIMMERS GADGET</p><h1 className="text-xl font-semibold">Operations</h1></div><span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900">Setup in progress</span></div></header><section className="mx-auto max-w-7xl px-5 py-10 sm:px-8"><div className="mb-10 max-w-2xl"><p className="mb-2 text-sm font-medium text-amber-700">Secure shop management</p><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">A reliable record for every product, sale, and payment.</h2><p className="mt-4 leading-7 text-slate-600">The foundation uses PostgreSQL and Supabase Auth. Complete the environment setup to enable staff sign-in and live operational data.</p></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{modules.map(([title, description, status]) => <article key={title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{status}</p><h3 className="mt-4 text-xl font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{description}</p></article>)}</div></section></main>;
}
