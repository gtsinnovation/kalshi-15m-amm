/**
 * K15M AMM service worker — app-shell only.
 *
 * Deliberate non-goals:
 *  - We DO NOT cache any Kalshi, Coinbase, Supabase, or auth responses.
 *    Trading data must always be fresh; cached order books or balances
 *    would be dangerous.
 *  - We DO NOT cache HTML aggressively — `NetworkFirst` with a short
 *    timeout so a new deploy is picked up immediately.
 *  - Registration is gated in main.tsx so this never runs inside the
 *    Lovable editor preview / iframes.
 */

const SHELL_CACHE = "k15m-shell-v2";
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("k15m-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// Networks we MUST NOT cache — trading / auth data is never stale-safe.
const NEVER_CACHE_HOSTS = [
  "kalshi.com",
  "kalshi.co",
  "coinbase.com",
  "supabase.co",
  "supabase.com",
  "corsproxy.io",
  "codetabs.com",
  "allorigins.win",
];

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Bypass: cross-origin trading / auth APIs and any non-http(s) scheme.
  if (!url.protocol.startsWith("http")) return;
  if (NEVER_CACHE_HOSTS.some((h) => url.hostname.endsWith(h))) return;
  if (url.origin !== self.location.origin) return;

  // HTML / navigation requests: NetworkFirst with short timeout so
  // deploys are visible immediately; fall back to cached shell offline.
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request, { signal: AbortSignal.timeout(5000) });
          if (!fresh.ok) throw new Error("Navigation failed");
          const cache = await caches.open(SHELL_CACHE);
          cache.put("/index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await caches.match("/index.html");
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed static assets (Vite emits /assets/*-[hash].*): cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.status === 200) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
