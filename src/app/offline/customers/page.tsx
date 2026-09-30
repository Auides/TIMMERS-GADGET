import { OfflineNormalRead } from "../offline-normal-read";

/** Minimal reference-only screen; full customer management remains online-only future work. */
export default function OfflineCustomersPage() {
  return <OfflineNormalRead mode="customers" returnTo="/offline/customers" />;
}
