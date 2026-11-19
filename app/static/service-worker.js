const SHELL_CACHE = 'trail-shell-v9';
const VENDOR_CACHE = 'trail-vendor-v1';
const MAP_PACK_PREFIX = 'trail-map-pack-';
const SHELL_FILES = [
  '/', '/index.html', '/js/main.js', '/js/config.js',
  '/js/lib/api.js', '/js/lib/ai.js', '/js/lib/db.js', '/js/lib/firebase.js',
  '/js/lib/geo.js', '/js/lib/offlineReadiness.js', '/js/lib/offlineTiles.js',
  '/css/app.css', '/offline.html', '/manifest.webmanifest',
  '/icons/trail-192.png', '/icons/trail-512.png'
];

// Browser libraries are loaded as pinned ESM modules. They are warmed into a
// dedicated cache on first online installation and cached on later requests.
// No Node.js/npm runtime or frontend build is required by the Python app.
const VENDOR_HOSTS = new Set(['www.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com']);
const VENDOR_FILES = [
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js',
  'https://cdn.jsdelivr.net/npm/dexie@4.2.1/dist/dexie.mjs',
  'https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl.mjs',
  'https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl-worker.mjs',
  'https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl-shared.mjs',
  'https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl.css'
];

async function cacheShellResources() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(SHELL_FILES.map(async (path) => {
    const response = await fetch(path, { cache: 'reload' });
    if (response.ok) await cache.put(path, response.clone());
  }));
  for (const required of ['/index.html', '/js/main.js', '/css/app.css', '/manifest.webmanifest']) {
    if (!(await cache.match(required))) throw new Error(`Required Trail shell resource is missing: ${required}`);
  }
  const vendorCache = await caches.open(VENDOR_CACHE);
  await Promise.allSettled(VENDOR_FILES.map(async (url) => {
    try {
      const request = new Request(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') await vendorCache.put(request, response.clone());
    } catch { /* Keep installation available; the app records vendor cache misses on first use. */ }
  }));
  // Runtime configuration is cached only after a successful request. It is not
  // part of install's all-or-nothing precache because first install may be offline.
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) await cache.put('/api/config', response.clone());
  } catch { /* a saved public config may be used on a later offline launch */ }
}

async function findCachedMapResource(request) {
  const names = (await caches.keys()).filter((name) => name.startsWith(MAP_PACK_PREFIX));
  for (const name of names) {
    const cache = await caches.open(name);
    const cached = await cache.match(request, { ignoreSearch: false, ignoreVary: false });
    if (cached) return cached;
  }
  return undefined;
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShellResources().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('trail-shell-') && key !== SHELL_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'TRAIL_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    // Third-party ESM libraries are cached separately from customer map tiles.
    if (VENDOR_HOSTS.has(url.hostname)) {
      event.respondWith((async () => {
        const vendorCache = await caches.open(VENDOR_CACHE);
        const cached = await vendorCache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok || response.type === 'opaque') await vendorCache.put(request, response.clone());
          return response;
        } catch {
          return new Response('A required Trail library has not been cached yet. Open Trail online once, then retry offline.', { status: 504, statusText: 'Vendor library unavailable offline' });
        }
      })());
      return;
    }
    // MapLibre style JSON, TileJSON, vector/raster tiles, sprites and glyphs
    // are saved in a per-trip pack and served by their exact request URL.
    event.respondWith((async () => {
      const cached = await findCachedMapResource(request);
      if (cached) return cached;
      return fetch(request);
    })());
    return;
  }

  if (url.pathname === '/api/config') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) await cache.put('/api/config', response.clone());
        return response;
      } catch {
        const saved = await cache.match('/api/config');
        if (saved) return saved;
        return new Response(JSON.stringify({ error: 'Configuration is unavailable offline until Trail has been opened online once.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Some customers host licensed MapLibre styles or tiles behind their own
    // API path. Serve an exact saved map-pack match, but never cache arbitrary API responses.
    event.respondWith((async () => (await findCachedMapResource(request)) || fetch(request))());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || (await cache.match('/offline.html')) || new Response('Trail is unavailable. Open it online once to save the application shell.', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const packed = await findCachedMapResource(request);
    if (packed) return packed;
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/icons/') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.png'))) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline resource not cached' });
    }
  })());
});
