import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { AppShell } from "./app-shell";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/app">) {
  const { user, profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  return <AppShell name={profile.full_name} role={profile.role} identity={{ authenticatedUserId: user?.id ?? "", profileUserId: profile.id, displayName: profile.full_name, role: profile.role, active: profile.is_active }}>{children}</AppShell>;
}
