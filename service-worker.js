const CACHE_VERSION = 'holcim-pwa-shell-v4';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 1. Install: Pre-cache static shell assets without failing on a single missing optional file
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await Promise.all(
        STATIC_ASSETS.map(async (asset) => {
          try {
            const res = await fetch(asset, { cache: 'no-cache' });
            if (res && res.ok) {
              await cache.put(asset, res.clone());
            }
          } catch (_) {
            // Skip unavailable optional asset rather than aborting SW install
          }
        })
      );
    })
  );
  self.skipWaiting();
});

// 2. Activate: Purge outdated cache versions immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((oldKey) => caches.delete(oldKey))
      )
    )
  );
  self.clients.claim();
});

// Listen for user-triggered update message
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 3. Fetch: Never cache employee data, GAS API calls, or POST requests
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // SECURITY RULE: Bypass cache completely for Google Apps Script endpoints,
  // dynamic API requests, authentication URLs, or non-GET mutations.
  if (
    req.method !== 'GET' ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.pathname.includes('/macros/') ||
    url.searchParams.has('action')
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigation requests (HTML shell): Network-first with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const copy = networkRes.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          }
          return networkRes;
        })
        .catch(() =>
          caches.match('./index.html').then((cached) => cached || caches.match('./offline.html'))
        )
    );
    return;
  }

  // Static Shell Assets (CSS, JS, Icons, Manifest): Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cachedRes) => {
        const networkFetch = fetch(req)
          .then((freshRes) => {
            if (freshRes && freshRes.status === 200) {
              const clone = freshRes.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
            }
            return freshRes;
          })
          .catch(() => cachedRes);

        return cachedRes || networkFetch.then((res) => res || Response.error());
      })
    );
  }
});