export function isNavigationCurrent(pathname: string, href: string, exact = false) {
  return exact ? pathname === href : pathname.startsWith(href);
}
