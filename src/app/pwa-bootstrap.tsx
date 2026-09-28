"use client";

import { useEffect } from "react";
import { getInstallationDevice } from "@/lib/offline/device";

export function PwaBootstrap() {
  useEffect(() => {
    void getInstallationDevice().catch(() => undefined);
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}
