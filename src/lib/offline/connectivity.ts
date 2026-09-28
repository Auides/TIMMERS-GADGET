export const connectivityStates = ["ONLINE", "OFFLINE", "CHECKING", "DEGRADED"] as const;
export type ConnectivityState = (typeof connectivityStates)[number];
export type Reachability = "UNKNOWN" | "REACHABLE" | "UNREACHABLE";

export function connectivityStateFor(browserOnline: boolean, reachability: Reachability): ConnectivityState {
  if (!browserOnline) return "OFFLINE";
  if (reachability === "REACHABLE") return "ONLINE";
  if (reachability === "UNREACHABLE") return "DEGRADED";
  return "CHECKING";
}
