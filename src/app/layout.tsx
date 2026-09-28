import type { Metadata } from "next";
import "./globals.css";
import { PwaBootstrap } from "./pwa-bootstrap";

export const metadata: Metadata = {
  title: "TIMMERS GADGET",
  description: "Secure operations and inventory management for TIMMERS GADGET.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en"><body><PwaBootstrap />{children}</body></html>;
}
