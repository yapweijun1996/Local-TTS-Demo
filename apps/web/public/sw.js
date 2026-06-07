/**
 * Service worker — two jobs:
 *   1. Inject COOP/COEP on every response so the page is cross-origin-isolated,
 *      enabling SharedArrayBuffer / multithreaded WASM. GitHub Pages cannot set
 *      these headers itself, so we add them here (the coi-serviceworker pattern).
 *   2. Cache the app shell for offline navigation. Model files (50–326 MB) are
 *      NOT cached here — they live in IndexedDB / OPFS via the ML libraries.
 *
 * Paths are relative so this works under any base (root in dev, /Local-TTS-Demo/
 * on GitHub Pages). Client-side registration + one-time reload lives in main.ts.
 */
const CACHE = "tts-app-v2";
const SHELL = ["./", "./index.html"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** Clone a response with COOP/COEP added (cross-origin isolation). */
function withCoiHeaders(response) {
  if (!response || response.status === 0) return response; // opaque — leave as-is
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Skip range/only-if-cached cross-origin edge cases the spec forbids handling.
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

  e.respondWith(
    fetch(req)
      .then((res) => withCoiHeaders(res))
      .catch(async () => {
        // Offline fallback: serve cached shell for navigations.
        if (req.mode === "navigate") {
          const cached = (await caches.match(req)) || (await caches.match("./index.html"));
          if (cached) return withCoiHeaders(cached);
        }
        return Response.error();
      }),
  );
});
