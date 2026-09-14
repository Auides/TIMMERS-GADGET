import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";
import { AppShell } from "./app-shell";

export default async function AuthenticatedLayout({ children }: LayoutProps<"/app">) {
  const { profile } = await getAuthenticatedProfile();
  if (!profile) redirect("/login");
  return <AppShell name={profile.full_name} role={profile.role}>{children}</AppShell>;
}
