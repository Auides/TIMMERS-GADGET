"use client";

import { useEffect } from "react";
import { DexieOfflineStore } from "./db";
import { getInstallationDevice } from "./device";
import { reverifyOfflineAccess, type OnlineEnrollmentIdentity } from "./offline-auth";

/** Uses the existing server-authenticated profile; it never creates an independent Supabase identity. */
export function OfflineAuthorizationRevalidator({ identity }: { identity: OnlineEnrollmentIdentity }) {
  useEffect(() => {
    void (async () => {
      try {
        const device = await getInstallationDevice();
        await reverifyOfflineAccess(new DexieOfflineStore(), identity, device.id);
      } catch {
        // Server authorization remains authoritative; this local metadata refresh is best effort.
      }
    })();
  }, [identity]);
  return null;
}
