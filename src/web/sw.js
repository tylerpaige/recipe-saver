// Keeps the app and your recipes on the phone, so they open when the Mac is asleep or the Wi-Fi is bad.
// Cook and swap lookups need the Mac, so they're never cached.
const VERSION = "__VERSION__";
const SHELL = ["/", "/frame", "/shell.js", "/app.js", "/app.css", "/manifest.webmanifest", "/icon.png"];
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = "data";
// How long to wait for the Mac before showing the saved copy. Tailscale to a sleeping Mac can hang for a while.
const NETWORK_WAIT_MS = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("shell-") && key !== SHELL_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** The Mac's answer if it comes in time (saving a copy), else the saved copy marked as such. */
async function library(req) {
  const cache = await caches.open(DATA_CACHE);
  const fresh = fetch(req).then(async (res) => {
    if (res.ok) await cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS));
  const res = await Promise.race([fresh.catch(() => undefined), timeout]);
  if (res) return res;
  const saved = await cache.match(req);
  if (!saved) return fresh; // nothing saved yet: keep waiting for the Mac
  const headers = new Headers(saved.headers);
  headers.set("x-saved-copy", "1");
  return new Response(saved.body, { status: saved.status, headers });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  if (url.pathname === "/api/library") return e.respondWith(library(e.request));
  if (url.pathname.startsWith("/api/")) return; // live only
  // The app itself: the cached copy, which a new version replaces.
  const path = e.request.mode === "navigate" && url.pathname !== "/frame" ? "/" : url.pathname;
  e.respondWith(caches.match(path).then((hit) => hit ?? fetch(e.request)));
});
