"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(formData: FormData) {
    setPending(true); setError(null);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) { setError("Supabase is not configured for this environment."); setPending(false); return; }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: String(formData.get("email")), password: String(formData.get("password")) });
    if (signInError) { setError("Unable to sign in. Check your details and try again."); setPending(false); return; }
    router.replace("/app"); router.refresh();
  }

  return <form action={submit} className="space-y-4"><label className="block text-sm font-medium">Email<input required name="email" type="email" autoComplete="email" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label><label className="block text-sm font-medium">Password<input required name="password" type="password" autoComplete="current-password" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></label>{error && <p className="text-sm text-red-700" role="alert">{error}</p>}<button disabled={pending} className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60">{pending ? "Signing in…" : "Sign in"}</button></form>;
}
