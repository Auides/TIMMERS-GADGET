import { getAuthenticatedProfile } from "@/lib/auth";
import { OfflineAccessManager } from "./offline-access-manager";

export default async function OfflineAccessPage() {
  const { user, profile } = await getAuthenticatedProfile();
  if (!user || !profile) return null;
  return <OfflineAccessManager identity={{ authenticatedUserId: user.id, profileUserId: profile.id, displayName: profile.full_name, role: profile.role, active: profile.is_active }} />;
}
