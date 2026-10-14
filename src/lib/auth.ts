import type { User } from "@supabase/supabase-js";
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/authorization";

export type ProfileSnapshot = { id: string; full_name: string; role: Role; is_active: boolean };

/** Server-only snapshot for local offline enrollment revalidation, including inactive profiles. */
async function getAuthoritativeProfileSnapshotUncached(): Promise<{ user: User | null; profile: ProfileSnapshot | null }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { user: null, profile: null };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };
  const { data: profile } = await supabase.from("profiles").select("id, full_name, role, is_active").eq("id", user.id).maybeSingle();
  return { user, profile: profile ? profile as ProfileSnapshot : null };
}

// React.cache is request-scoped in Server Components. It removes duplicate layout/page
// resolution without persisting an authenticated profile across requests or users.
export const getAuthoritativeProfileSnapshot = cache(getAuthoritativeProfileSnapshotUncached);

export const getAuthenticatedProfile = cache(async (): Promise<{ user: User | null; profile: ProfileSnapshot | null }> => {
  const { user, profile } = await getAuthoritativeProfileSnapshot();
  if (!profile?.is_active) return { user, profile: null };
  return { user, profile };
});
