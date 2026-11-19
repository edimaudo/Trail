import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { ts = require(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'typescript', 'lib', 'typescript.js')); }

const source = await readFile(new URL('../../app/source/typescript/lib/offlineTiles.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const compiledPath = join(tmpdir(), `trail-offline-tiles-${process.pid}.mjs`);
await writeFile(compiledPath, compiled, 'utf8');

class MemoryCache {
  constructor() { this.entries = new Map(); }
  key(value) { return typeof value === 'string' ? new URL(value, 'https://trail.test').toString() : value.url; }
  async match(request) { const response = this.entries.get(this.key(request)); return response?.clone(); }
  async put(request, response) { this.entries.set(this.key(request), response.clone()); }
  async delete(request) { return this.entries.delete(this.key(request)); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
}
class MemoryCaches {
  constructor() { this.items = new Map(); }
  async open(name) { if (!this.items.has(name)) this.items.set(name, new MemoryCache()); return this.items.get(name); }
  async delete(name) { return this.items.delete(name); }
  async keys() { return [...this.items.keys()]; }
}

const styleUrl = 'https://maps.provider.test/styles/trail.json?key=public';
const tileJsonUrl = 'https://maps.provider.test/tiles.json?key=public';
const style = {
  version: 8,
  sprite: [{ id: 'base', url: 'https://maps.provider.test/sprites/trail' }],
  glyphs: 'https://maps.provider.test/fonts/{fontstack}/{range}.pbf',
  sources: {
    trails: { type: 'vector', url: tileJsonUrl, minzoom: 10, maxzoom: 10 },
    aerial: { type: 'image', url: 'https://maps.provider.test/aerial.png', coordinates: [[-80, 44], [-79, 44], [-79, 43], [-80, 43]] },
    boundaries: { type: 'geojson', data: 'https://maps.provider.test/boundaries.geojson' },
    trailVideo: { type: 'video', urls: ['https://maps.provider.test/video/trail.mp4'] },
  },
  layers: [{ id: 'labels', type: 'symbol', source: 'trails', layout: { 'text-font': ['Noto Sans Regular'] } }],
};

async function runScenario({ failTiles = false, quotaBytes = 2 * 1024 ** 3, devicePixelRatio = 1, failHighDensitySprites = devicePixelRatio < 2, tileTemplate = 'https://maps.provider.test/{z}/{x}/{y}.pbf', extraHosts = '' } = {}) {
  const memoryCaches = new MemoryCaches();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: memoryCaches });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { caches: memoryCaches, devicePixelRatio, TRAIL_CONFIG: { mapStyleUrl: styleUrl, offlineTileHosts: ['maps.provider.test', extraHosts].filter(Boolean).join(',') } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {
    persisted: async () => true,
    persist: async () => true,
    estimate: async () => ({ quota: quotaBytes, usage: 0 }),
  } } });
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === styleUrl) return new Response(JSON.stringify(style), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === tileJsonUrl) return new Response(JSON.stringify({ tiles: [tileTemplate], subdomains: ['a', 'b', 'c'], minzoom: 10, maxzoom: 10 }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (failHighDensitySprites && url.includes('/sprites/trail@2x')) return new Response('high-density sprite not available', { status: 404 });
    if (failTiles && url.endsWith('.pbf') && url.includes('/10/')) return new Response('tile failure', { status: 503 });
    if (url.endsWith('.json') || url.endsWith('.geojson') || url.endsWith('.png') || url.endsWith('.pbf') || url.endsWith('.mp4')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    return new Response('unexpected resource', { status: 404 });
  };
  const module = await import(`file://${compiledPath}?scenario=${Math.random()}`);
  return { module, memoryCaches, calls };
}

const normal = await runScenario();
const progress = [];
const pack = await normal.module.downloadOfflineTilePack('trip-a', [
  { lat: 43.6501, lng: -79.3802 }, { lat: 43.6511, lng: -79.3782 },
], ['Trail', 'Québec'], (value) => progress.push(value));
assert.equal(pack.tripId, 'trip-a');
assert.ok(pack.tileCount > 0, 'route corridor should generate tile requests');
assert.ok(pack.resourceCount > pack.tileCount, 'style dependencies should also be cached');
assert.ok(pack.sizeBytes > 0, 'cached resource size should be measured');
assert.ok(pack.failed > 0, 'missing high-density sprite variants should be reported as optional resource failures');
assert.ok(normal.calls.some((url) => url.includes('/fonts/Noto%20Sans%20Regular/0-255.pbf')), 'glyph path must replace encoded font placeholders');
assert.ok(normal.calls.some((url) => url.includes('/sprites/trail.json')), 'base sprite JSON should be cached');
assert.ok(normal.calls.some((url) => url.includes('/sprites/trail.png')), 'base sprite image should be cached');
assert.ok(normal.calls.some((url) => url.endsWith('/aerial.png')), 'image sources must be saved');
assert.ok(normal.calls.some((url) => url.endsWith('/boundaries.geojson')), 'remote GeoJSON sources must be saved');
assert.ok(normal.calls.some((url) => url.endsWith('/video/trail.mp4')), 'video source assets must be saved');
assert.ok(progress.some((item) => item.stage === 'verifying'), 'download should report verification stage');
assert.equal(await normal.module.hasOfflineTilePack(pack.cacheName, pack.resourceCount, pack.requiredResourceUrls), true);
assert.ok(pack.requiredResourceUrls.length > 0, 'pack metadata must record required resources for exact integrity checks');
const integrityCache = await normal.memoryCaches.open(pack.cacheName);
await integrityCache.delete(pack.requiredResourceUrls[0]);
assert.equal(await normal.module.hasOfflineTilePack(pack.cacheName, pack.resourceCount, pack.requiredResourceUrls), false, 'a missing required URL must invalidate readiness even if a cache count looks plausible');
await normal.module.deleteOfflineTilePack(pack.cacheName);
assert.equal(await normal.module.hasOfflineTilePack(pack.cacheName), false, 'deleted pack should no longer exist');

const failed = await runScenario({ failTiles: true });
await assert.rejects(
  () => failed.module.downloadOfflineTilePack('trip-b', [{ lat: 43.65, lng: -79.38 }, { lat: 43.651, lng: -79.379 }], ['Trail']),
  /could not be saved for offline use/,
);
assert.equal((await failed.memoryCaches.keys()).length, 0, 'failed pack should be rolled back');

const invalid = await runScenario();
await assert.rejects(() => invalid.module.downloadOfflineTilePack('trip-c', [{ lat: 43, lng: -79 }], ['Trail']), /at least two points/);

const quotaLimited = await runScenario({ quotaBytes: 1024 * 1024 });
await assert.rejects(() => quotaLimited.module.downloadOfflineTilePack('trip-quota', [{ lat: 43.65, lng: -79.38 }, { lat: 43.651, lng: -79.379 }], ['Trail']), /Not enough device storage/);
assert.equal((await quotaLimited.memoryCaches.keys()).length, 0, 'quota preflight must happen before creating a pack');

const invalidCoordinates = await runScenario();
await assert.rejects(() => invalidCoordinates.module.downloadOfflineTilePack('trip-invalid', [{ lat: 43, lng: -79 }, { lat: 95, lng: -79 }], ['Trail']), /invalid latitude or longitude/);

const disallowed = await runScenario();
const untrustedStyle = structuredClone(style);
untrustedStyle.sources.trails.url = 'https://evil.test/tiles.json';
globalThis.fetch = async (input) => String(input) === styleUrl
  ? new Response(JSON.stringify(untrustedStyle), { status: 200, headers: { 'content-type': 'application/json' } })
  : new Response('unexpected resource', { status: 404 });
await assert.rejects(() => disallowed.module.downloadOfflineTilePack('trip-d', [{ lat: 43, lng: -79 }, { lat: 43.1, lng: -78.9 }], ['Trail']), /not in OFFLINE_TILE_HOSTS/);

// Verify high-density requests include @2x tiles and all configured tile subdomains.
const retina = await runScenario({
  devicePixelRatio: 2,
  tileTemplate: 'https://{s}.maps.provider.test/{z}/{x}/{y}{ratio}.pbf',
  extraHosts: 'a.maps.provider.test,b.maps.provider.test,c.maps.provider.test',
});
const retinaPack = await retina.module.downloadOfflineTilePack('trip-retina', [{ lat: 43.6501, lng: -79.3802 }, { lat: 43.6511, lng: -79.3782 }], ['Trail']);
assert.ok(retina.calls.some((url) => url.includes('/sprites/trail@2x.json')), 'high-density devices must request @2x sprites');
assert.ok(retina.calls.some((url) => url.includes('/10/') && url.includes('@2x.pbf')), 'high-density devices must cache @2x vector tiles');
for (const subdomain of ['a', 'b', 'c']) assert.ok(retina.calls.some((url) => url.includes(`https://${subdomain}.maps.provider.test/`)), `tile subdomain ${subdomain} should be cached`);
assert.ok(retinaPack.tileCount > 0);

const polar = await runScenario();
const polarPack = await polar.module.downloadOfflineTilePack('trip-polar', [{ lat: 84.9, lng: 20 }, { lat: 84.901, lng: 20.02 }], ['Polar trail']);
assert.ok(polarPack.tileCount > 0, 'tile corridor generation must remain valid near the Web Mercator latitude limit');
await assert.rejects(() => polar.module.downloadOfflineTilePack('trip-beyond-polar', [{ lat: 85.2, lng: 20 }, { lat: 85.21, lng: 20.02 }], ['Polar trail']), /cannot cover routes beyond 85.05/);

const unsupportedTemplate = await runScenario({ tileTemplate: 'https://maps.provider.test/{z}/{x}/{bbox-epsg-3857}.pbf' });
await assert.rejects(
  () => unsupportedTemplate.module.downloadOfflineTilePack('trip-unsupported', [{ lat: 43.65, lng: -79.38 }, { lat: 43.651, lng: -79.379 }], ['Trail']),
  /unsupported tile URL placeholder/,
);

assert.match(await readFile(new URL('../../app/source/typescript/main.ts', import.meta.url), 'utf8'), /attributionControl:\s*true/, 'MapLibre provider attribution must remain enabled');

console.log('Offline map tests passed: corridor coverage, style imports and source assets, sprite/glyph caching, high-density/subdomain requests, quota preflight, polar routes, exact integrity verification, rollback, deletion and provider-host validation.');
