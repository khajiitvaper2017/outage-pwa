const CACHE = "outage-shell";
const ASSETS = ["./", "index.html", "app.js", "manifest.json", "icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Schedule API — always network
  if (url.includes("dynamicgpv-info.php")) {
    e.respondWith(fetch(e.request).catch(() => new Response("")));
    return;
  }

  // App shell — network first, fall back to cache (auto-updates)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./")))
  );
});
