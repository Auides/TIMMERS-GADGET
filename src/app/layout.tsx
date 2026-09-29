import type { Metadata } from "next";
import "./globals.css";
import { PwaBootstrap } from "./pwa-bootstrap";
import { OfflineVaultProvider } from "@/lib/offline/offline-auth-provider";

export const metadata: Metadata = {
  title: "TIMMERS GADGET",
  description: "Secure operations and inventory management for TIMMERS GADGET.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en"><body><OfflineVaultProvider><PwaBootstrap />{children}</OfflineVaultProvider></body></html>;
}
