"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { connectivityStateFor, type ConnectivityState, type Reachability } from "./connectivity.ts";

type ConnectivityContextValue = { state: ConnectivityState; reportReachability: (reachability: Reachability) => void };
const ConnectivityContext = createContext<ConnectivityContextValue | undefined>(undefined);

export function ConnectivityProvider({ children }: { children: React.ReactNode }) {
  const [browserOnline, setBrowserOnline] = useState(false);
  const [reachability, setReachability] = useState<Reachability>("UNKNOWN");

  useEffect(() => {
    const updateOnline = () => { setBrowserOnline(navigator.onLine); setReachability("UNKNOWN"); };
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => { window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); };
  }, []);

  const value = useMemo(() => ({ state: connectivityStateFor(browserOnline, reachability), reportReachability: setReachability }), [browserOnline, reachability]);
  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity() {
  const context = useContext(ConnectivityContext);
  if (!context) throw new Error("useConnectivity must be used inside ConnectivityProvider.");
  return context;
}
