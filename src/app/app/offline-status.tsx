"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getOfflineDatabase } from "@/lib/offline/db";
import { useConnectivity } from "@/lib/offline/connectivity-provider";

const labels = { ONLINE: "Online", OFFLINE: "Offline", CHECKING: "Checking", DEGRADED: "Connection degraded" };

export function OfflineStatus() {
  const { state } = useConnectivity();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try { const count = await getOfflineDatabase().outbox.where("status").equals("PENDING").count(); if (!disposed) setPending(count); } catch { if (!disposed) setPending(0); }
    };
    void refresh();
    window.addEventListener("timmers-offline-outbox-changed", refresh);
    return () => { disposed = true; window.removeEventListener("timmers-offline-outbox-changed", refresh); };
  }, []);
  return <Link href="/app/offline-access" className={`app-connectivity-status app-connectivity-${state.toLowerCase()}`} aria-label="Manage offline access" aria-live="polite"><span aria-hidden="true" />{labels[state]}{pending ? ` · ${pending} sync pending` : ""}</Link>;
}
