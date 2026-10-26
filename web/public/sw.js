/*
 * Word Atlas offline cache.
 *
 * Two origins, two strategies:
 *   - app shell + dataset (same origin, Cloudflare Pages): network-first, so a
 *     new deploy is picked up on the next load and still works offline.
 *   - media (illustrations, audio, brand art, UI sound — Cloudflare R2, either
 *     origin): cache-first, immutable, trimmed to a bounded budget.
 */
const VERSION = "atlas-v2";
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;
const MEDIA_LIMIT = 1500;

/** Path shapes that are media rather than app code, wherever they are served from. */
const MEDIA_PATH = /\/(illustrations\/(img|thumb)|audio|brand|sfx)\//;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** A response we are allowed and able to store. Opaque (no-CORS) ones have status 0. */
const storable = (res) => res.ok || res.type === "opaque";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isMedia = MEDIA_PATH.test(url.pathname);
  // Cross-origin traffic is only ours when it looks like the media bucket.
  if (!sameOrigin && !isMedia) return;

  if (isMedia) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (storable(res)) {
              const copy = res.clone();
              caches
                .open(MEDIA)
                .then((c) => c.put(req, copy))
                .then(() => trim(MEDIA, MEDIA_LIMIT))
                .catch(() => null);
            }
            return res;
          }),
      ),
    );
    return;
  }

  // App shell and dataset: fresh when online, cached when not.
  const isData = url.pathname.endsWith("/index.json") || url.pathname.includes("/atlas/entries/");
  if (req.mode === "navigate" || isData) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (storable(res)) caches.open(SHELL).then((c) => c.put(req, res.clone())).catch(() => null);
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || caches.match(new URL("./", self.registration.scope).href)),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (storable(res)) {
            caches
              .open(SHELL)
              .then((c) => c.put(req, res.clone()))
              .catch(() => null);
          }
          return res;
        }),
    ),
  );
});
