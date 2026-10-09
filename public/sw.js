const CACHE_PREFIX = "timmers-gadget-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v7`;
const OFFLINE_FALLBACK = "/offline";
const LOCAL_OFFLINE_ROUTES = ["/offline", "/offline/unlock", "/offline/workspace", "/offline/catalogue", "/offline/inventory", "/offline/customers", "/offline/suppliers", "/offline/purchases", "/offline/sales"];
const NORMAL_ROUTE_OFFLINE_FALLBACKS = { "/app/catalogue": "/offline/catalogue", "/app/inventory": "/offline/inventory", "/app/suppliers": "/offline/suppliers", "/app/purchases": "/offline/purchases", "/app/sales/new": "/offline/sales" };

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(LOCAL_OFFLINE_ROUTES)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && LOCAL_OFFLINE_ROUTES.includes(url.pathname)) { const copy = response.clone(); void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
      return response;
    }).catch(() => {
      const offlineRoute = NORMAL_ROUTE_OFFLINE_FALLBACKS[url.pathname];
      if (offlineRoute) return Response.redirect(new URL(offlineRoute, self.location.origin), 302);
      return caches.match(request).then((cached) => cached || caches.match(OFFLINE_FALLBACK));
    }));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || /\.(?:css|js|woff2?|ico|png|svg)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
      return response;
    })));
  }
});
