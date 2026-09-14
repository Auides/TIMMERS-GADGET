import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/authorization";

export type ActiveProfile = { id: string; full_name: string; role: Role; is_active: boolean };

export async function getAuthenticatedProfile(): Promise<{ user: User | null; profile: ActiveProfile | null }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { user: null, profile: null };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };
  const { data: profile } = await supabase.from("profiles").select("id, full_name, role, is_active").eq("id", user.id).maybeSingle();
  if (!profile?.is_active) return { user, profile: null };
  return { user, profile: profile as ActiveProfile };
}
