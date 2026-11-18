const CACHE = 'videoseps-photo-finish-v18';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png',
  './portraits.js', './portraits.css', './ocr/client/tesseract.min.js', './ocr/client/worker.min.js',
  './ocr/core/tesseract-core-lstm.js', './ocr/client/tesseract-core-lstm.wasm', './ocr/lang/fra.traineddata.gz',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('videoseps-photo-finish-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(request).catch(async () => {
    const cached = await caches.match(request, {ignoreSearch: true});
    return cached || (request.mode === 'navigate' ? await caches.match('./index.html') : null) || Response.error();
  }));
});
