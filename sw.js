// Service worker : garde l'application sur l'appareil pour un usage sans connexion.
// Changer VERSION à chaque mise à jour de l'application.
const VERSION = "chrono-eps-v10";
const FONTS = "chrono-eps-fonts-v1";
const FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réponse immédiate depuis l'appareil ; mise à jour en arrière-plan quand il y a du réseau.
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const host = new URL(req.url).hostname;
  // Polices Google : gardées sur l'appareil après le premier chargement
  if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") {
    event.respondWith(caches.open(FONTS).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }
      catch (e) { return new Response("", { status: 504 }); }
    }));
    return;
  }
  if (new URL(req.url).origin !== self.location.origin) return;
  // Page de l'application : on prend la dernière version si le réseau répond vite,
  // sinon la copie gardée sur l'appareil (usage sans connexion).
  if (req.mode === "navigate") {
    event.respondWith(caches.open(VERSION).then(async cache => {
      const timeout = new Promise(r => setTimeout(() => r(null), 2500));
      const net = fetch(req, { cache: "no-store" }).then(res => {
        if (res && res.ok) cache.put("./index.html", res.clone());
        return res;
      }).catch(() => null);
      const res = await Promise.race([net, timeout]);
      if (res) return res;
      const cached = await cache.match("./index.html");
      if (cached) { event.waitUntil(net); return cached; }
      return (await net) || new Response("Hors connexion", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }));
    return;
  }
  const key = req;
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      return res || new Response("Hors connexion", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    })
  );
});
