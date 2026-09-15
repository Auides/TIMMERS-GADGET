import { redirect } from "next/navigation";
import { getAuthenticatedProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { profile } = await getAuthenticatedProfile();
  redirect(profile ? "/app" : "/login");
}
