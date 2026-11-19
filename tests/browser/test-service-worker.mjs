import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class CacheStore {
  constructor() { this.items = new Map(); }
  key(input) { return new URL(typeof input === 'string' ? input : input.url, 'https://trail.test').toString(); }
  async match(input) { return this.items.get(this.key(input))?.clone(); }
  async put(input, response) { this.items.set(this.key(input), response.clone()); }
  async keys() { return [...this.items.keys()].map((url) => new Request(url)); }
}
class CacheStorageMock {
  constructor() { this.items = new Map(); }
  async open(name) { if (!this.items.has(name)) this.items.set(name, new CacheStore()); return this.items.get(name); }
  async keys() { return [...this.items.keys()]; }
  async delete(name) { return this.items.delete(name); }
  async match(request) {
    for (const cache of this.items.values()) { const result = await cache.match(request); if (result) return result; }
    return undefined;
  }
}

const listeners = new Map();
const caches = new CacheStorageMock();
let isOffline = false;
let configOffline = false;
const fetchCalls = [];
const self = {
  location: { origin: 'https://trail.test' },
  clients: { claim: async () => {} },
  skipWaiting: async () => {},
  addEventListener: (name, callback) => listeners.set(name, callback),
};
const fetchMock = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url, 'https://trail.test');
  fetchCalls.push(url.toString());
  if (isOffline || (configOffline && url.pathname === '/api/config')) throw new Error('offline');
  if (url.pathname === '/api/config') return new Response(JSON.stringify({ projectId: 'trail-test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/missing') return new Response('not found', { status: 404 });
  return new Response(`asset:${url.pathname}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
};
const context = { self, caches, fetch: fetchMock, URL, Request, Response, Headers, Promise, JSON, Error, console };
vm.runInNewContext(await readFile(new URL('../../app/static/service-worker.js', import.meta.url), 'utf8'), context);

async function dispatchFetch(url, mode = 'cors') {
  let responsePromise;
  const event = {
    request: { method: 'GET', mode, url, headers: new Headers() },
    respondWith: (value) => { responsePromise = Promise.resolve(value); },
  };
  listeners.get('fetch')(event);
  return responsePromise;
}

configOffline = true;
const old = await caches.open('trail-shell-v6');
await old.put('/old', new Response('old'));
let installPromise;
listeners.get('install')({ waitUntil: (promise) => { installPromise = promise; } });
await installPromise;
assert.ok((await caches.keys()).includes('trail-shell-v8'), 'new shell cache should be installed');
assert.ok(await (await caches.open('trail-shell-v8')).match('/index.html'), 'index should be cached on install');
assert.ok(!(await (await caches.open('trail-shell-v8')).match('/api/config')), 'offline initial config must not block shell install');
const vendorCache = await caches.open('trail-vendor-v1');
assert.ok(await vendorCache.match('https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js'), 'Firebase AI Logic SDK should be warmed into the vendor cache');
assert.ok(await vendorCache.match('https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl-worker.mjs'), 'MapLibre worker should be warmed into the vendor cache');

// Cache runtime config online, then verify offline fallback.
configOffline = false;
const configOnline = await dispatchFetch('https://trail.test/api/config');
assert.equal(configOnline.status, 200);
isOffline = true;
const configOfflineResponse = await dispatchFetch('https://trail.test/api/config');
assert.equal(configOfflineResponse.status, 200);
assert.match(await configOfflineResponse.text(), /trail-test/);
const firebaseAiOffline = await dispatchFetch('https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js');
assert.equal(firebaseAiOffline.status, 200, 'preloaded Firebase AI Logic module must remain available offline');

// Map pack resources must be served offline from their per-trip cache.
const mapCache = await caches.open('trail-map-pack-trip-a-1700000000000');
await mapCache.put('https://tiles.provider.test/styles/trail.json', new Response('cached-style'));
await mapCache.put('https://trail.test/tiles/10/2/3.pbf', new Response('cached-vector-tile'));
await mapCache.put('https://trail.test/api/maps/10/2/3.pbf', new Response('cached-api-tile')); 
const crossOriginTile = await dispatchFetch('https://tiles.provider.test/styles/trail.json');
assert.equal(await crossOriginTile.text(), 'cached-style');
const sameOriginTile = await dispatchFetch('https://trail.test/tiles/10/2/3.pbf');
assert.equal(await sameOriginTile.text(), 'cached-vector-tile');
const sameOriginApiTile = await dispatchFetch('https://trail.test/api/maps/10/2/3.pbf');
assert.equal(await sameOriginApiTile.text(), 'cached-api-tile', 'same-origin map resources under /api/ must be served from a saved map pack');

// Navigation must return the saved application shell when offline.
const offlineNavigation = await dispatchFetch('https://trail.test/saved-trip/123', 'navigate');
assert.equal(offlineNavigation.status, 200);
assert.match(await offlineNavigation.text(), /asset:\/index.html/);

// Uncached API calls remain network-only and reject while offline.
await assert.rejects(() => dispatchFetch('https://trail.test/api/other'), /offline/, 'uncached API paths remain network-only while offline');

let activatePromise;
listeners.get('activate')({ waitUntil: (promise) => { activatePromise = promise; } });
await activatePromise;
assert.ok(!(await caches.keys()).includes('trail-shell-v6'), 'old shell cache should be removed');
assert.ok((await caches.keys()).some((name) => name.startsWith('trail-map-pack-')), 'map pack caches must survive shell upgrades');


// A missing core bundle must prevent installing a worker that cannot run the cached shell.
const brokenListeners = new Map();
const brokenCaches = new CacheStorageMock();
const brokenSelf = { ...self, addEventListener: (name, callback) => brokenListeners.set(name, callback) };
const brokenContext = { ...context, self: brokenSelf, caches: brokenCaches, fetch: async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url, 'https://trail.test');
  if (url.pathname === '/css/app.css') return new Response('missing', { status: 404 });
  if (url.pathname === '/api/config') throw new Error('offline');
  return new Response(`asset:${url.pathname}`, { status: 200 });
} };
vm.runInNewContext(await readFile(new URL('../../app/static/service-worker.js', import.meta.url), 'utf8'), brokenContext);
let brokenInstall;
brokenListeners.get('install')({ waitUntil: (promise) => { brokenInstall = promise; } });
await assert.rejects(() => brokenInstall, /Required Trail shell resource is missing/);

console.log('Service worker tests passed: tolerant install, shell precache, config fallback, cross-origin/same-origin/API-path map cache hits, offline navigation, old shell cleanup and map-pack preservation.');
