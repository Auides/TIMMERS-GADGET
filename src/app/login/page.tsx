import { LoginForm } from "./login-form";

export default function LoginPage() {
  return <main className="grid min-h-screen place-items-center bg-stone-50 p-5"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-bold tracking-[0.2em] text-amber-600">TIMMERS GADGET</p><h1 className="mt-2 text-2xl font-semibold">Sign in to Operations</h1><p className="mt-2 text-sm leading-6 text-slate-600">Use your staff account. Access is granted only to active, provisioned profiles.</p><div className="mt-6"><LoginForm /></div></section></main>;
}
