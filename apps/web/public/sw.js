// Minimal PWA service worker — caches app shell, not model files.
// Model files (50–326 MB) are cached by IndexedDB/OPFS, not here.
const CACHE = "tts-app-v1";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(function(){}),
  );
});

self.addEventListener("fetch", (e) => {
  // Only cache navigation requests (app shell); skip model/onnx/wasm requests
  if (e.request.mode === "navigate") {
    e.respondWith(
      caches.match(e.request).then(function(r) { return r || fetch(e.request); }),
    );
  }
});
