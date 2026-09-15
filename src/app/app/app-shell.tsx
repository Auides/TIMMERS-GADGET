"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { signOut } from "./actions";
import { isNavigationCurrent } from "./app-shell-navigation";

type AppShellProps = {
  children: React.ReactNode;
  name: string;
  role: string;
};

const navigation = [
  { href: "/app", label: "Operations", icon: "⌂", exact: true },
  { href: "/app/sales", label: "Sales", icon: "◈" },
  { href: "/app/catalogue", label: "Catalogue", icon: "▦" },
  { href: "/app/inventory", label: "Inventory", icon: "▤" },
  { href: "/app/suppliers", label: "Suppliers", icon: "◫", managementOnly: true },
  { href: "/app/purchases", label: "Purchases", icon: "▣", managementOnly: true },
];

function roleLabel(role: string) {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

export function AppShell({ children, name, role }: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isCurrent = (href: string, exact?: boolean) => isNavigationCurrent(pathname, href, exact);
  const visibleNavigation = navigation.filter((item) => !item.managementOnly || role === "ADMIN" || role === "MANAGER");

  const sidebar = (mobile = false) => <aside className={`app-sidebar ${collapsed && !mobile ? "app-sidebar-collapsed" : ""} ${mobile ? "app-sidebar-mobile" : ""}`} aria-label="Primary navigation">
    <div className="app-sidebar-brand"><span className="app-brand-mark" aria-hidden="true">TG</span><span className="app-sidebar-label">TIMMERS<br/>GADGET</span>{!mobile ? <button className="app-sidebar-collapse" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? "›" : "‹"}</button> : null}</div>
    <nav className="app-sidebar-nav">
      {visibleNavigation.map((item) => <Link key={item.href} href={item.href} onClick={() => setDrawerOpen(false)} className={`app-nav-link ${isCurrent(item.href, item.exact) ? "app-nav-link-active" : ""}`} aria-current={isCurrent(item.href, item.exact) ? "page" : undefined} aria-label={item.label} data-tooltip={item.label}><span className="app-nav-icon" aria-hidden="true">{item.icon}</span><span className="app-sidebar-label">{item.label}</span></Link>)}
    </nav>
    <div className="app-sidebar-account"><span className="app-account-initial" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div className="app-sidebar-label"><p>{name}</p><span>{roleLabel(role)}</span></div></div>
    <form action={signOut}><button className="app-nav-link app-sign-out" type="submit" aria-label="Sign out" data-tooltip="Sign out"><span className="app-nav-icon" aria-hidden="true">↗</span><span className="app-sidebar-label">Sign out</span></button></form>
  </aside>;

  return <div className="app-shell">
    <div className="app-shell-desktop">{sidebar()}</div>
    {drawerOpen ? <><button className="app-drawer-backdrop" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} /><div className="app-drawer app-drawer-open">{sidebar(true)}</div></> : null}
    <div className="app-workspace">
      <header className="app-topbar"><button className="app-menu-button" aria-expanded={drawerOpen} aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>☰</button><div><p className="app-eyebrow">TIMMERS GADGET</p><p className="app-topbar-context">Retail operations</p></div></header>
      <div className="app-workspace-content">{children}</div>
    </div>
  </div>;
}
