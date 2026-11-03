// Service worker: makes the app work offline, and lets the installed app
// receive videos shared from other Android apps (manifest "share_target").
//
// Strategy for app files is stale-while-revalidate: instant loads from cache,
// refreshed in the background, so a new deploy shows up on the next visit
// without bumping a version number.

const CACHE = 'ssr-app-v1';
const SHARE_CACHE = 'ssr-share';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'encoder-worker.js',
  'js/main.js', 'js/ui.js', 'js/state.js', 'js/render.js', 'js/ops.js', 'js/ingest.js', 'js/exporter.js',
  'js/stage.js', 'js/timeline.js', 'js/transport.js', 'js/panels.js', 'js/editpanel.js', 'js/annopanel.js',
  'js/project.js', 'js/persist.js', 'js/version.js',
  'js/recording.js', 'js/importer.js', 'js/exportpanel.js',
  'lib/encoders.js', 'lib/webpmux.js',
  'lib/gifenc/index.js', 'lib/gifenc/constants.js', 'lib/gifenc/lzwEncode.js', 'lib/gifenc/stream.js',
  'lib/gifenc/pnnquant2.js', 'lib/gifenc/palettize.js', 'lib/gifenc/color.js', 'lib/gifenc/rgb-packing.js',
  'favicon.ico', 'icons/icon.svg', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // A file shared to the installed app arrives as a POST; stash it and open the app.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      const form = await req.formData();
      const file = form.get('media');
      if (file) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          new URL('shared-file', self.registration.scope).href,
          new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': file.name || 'shared' } }),
        );
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    }).catch(() => hit);
    return hit || network;
  })());
});
