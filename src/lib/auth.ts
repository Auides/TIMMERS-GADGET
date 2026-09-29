import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/authorization";

export type ProfileSnapshot = { id: string; full_name: string; role: Role; is_active: boolean };

/** Server-only snapshot for local offline enrollment revalidation, including inactive profiles. */
export async function getAuthoritativeProfileSnapshot(): Promise<{ user: User | null; profile: ProfileSnapshot | null }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { user: null, profile: null };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };
  const { data: profile } = await supabase.from("profiles").select("id, full_name, role, is_active").eq("id", user.id).maybeSingle();
  return { user, profile: profile ? profile as ProfileSnapshot : null };
}

export async function getAuthenticatedProfile(): Promise<{ user: User | null; profile: ProfileSnapshot | null }> {
  const { user, profile } = await getAuthoritativeProfileSnapshot();
  if (!profile?.is_active) return { user, profile: null };
  return { user, profile };
}
