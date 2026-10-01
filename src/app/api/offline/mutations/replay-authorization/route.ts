import { NextResponse } from "next/server";
import { getAuthoritativeProfileSnapshot } from "@/lib/auth";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** Non-sensitive local preflight only; the database command independently checks current authority. */
export async function GET() {
  const { user, profile } = await getAuthoritativeProfileSnapshot();
  return NextResponse.json({ hasAuthenticatedSession: Boolean(user), hasActiveProfile: Boolean(profile?.is_active) }, { headers: noStore });
}
