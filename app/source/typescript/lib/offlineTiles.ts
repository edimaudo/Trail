import type { Coordinate, MapPackMetadata } from '../types.js';

const MAP_PACK_PREFIX = 'trail-map-pack-';
const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 15;
const MAX_TILE_COUNT = 2600;
const CORRIDOR_BUFFER_METERS = 500;
const MAX_STYLE_IMPORT_DEPTH = 3;
const TILE_ESTIMATE_BYTES = 32 * 1024;
const STORAGE_RESERVE_BYTES = 12 * 1024 * 1024;

type TileKind = 'style' | 'tilejson' | 'tile' | 'sprite' | 'glyph' | 'asset';
interface ResourceRequest { url: string; kind: TileKind; required: boolean; }
interface TileSource { type?: string; tiles?: string[]; url?: string; data?: string | Record<string, unknown>; urls?: string[]; templateBase?: string; minzoom?: number; maxzoom?: number; scheme?: 'xyz' | 'tms'; subdomains?: string[]; }
interface StyleLayer { layout?: Record<string, unknown>; }
interface MapStyle { sources?: Record<string, TileSource>; sprite?: string | string[] | Array<{ id: string; url: string }>; glyphs?: string; layers?: StyleLayer[]; imports?: Array<{ url?: string }>; }
interface TileJson { tiles?: string[]; minzoom?: number; maxzoom?: number; scheme?: 'xyz' | 'tms'; subdomains?: string[]; }
export interface TilePackProgress { stage: 'preparing' | 'downloading' | 'verifying'; completed: number; total: number; message: string; }
export interface TilePackResult extends MapPackMetadata { downloaded: number; reused: number; failed: number; }

function ensureCacheSupport() {
  if (!('caches' in window)) throw new Error('This browser does not support offline map storage.');
}
function configuredHosts(styleUrl: string): Set<string> {
  const configured = (window.TRAIL_CONFIG?.offlineTileHosts || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  configured.push(new URL(styleUrl).hostname.toLowerCase());
  return new Set(configured);
}
function assertAllowed(url: string, hosts: Set<string>) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') throw new Error('Offline map resources must use HTTPS.');
  if (!hosts.has(parsed.hostname.toLowerCase())) throw new Error(`The map provider host ${parsed.hostname} is not in OFFLINE_TILE_HOSTS.`);
  return parsed.toString();
}
function tileX(longitude: number, zoom: number) { return (longitude + 180) / 360 * 2 ** zoom; }
function tileY(latitude: number, zoom: number) {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom;
}
function wrapX(x: number, zoom: number) { const size = 2 ** zoom; return ((x % size) + size) % size; }
function clampY(y: number, zoom: number) { return Math.max(0, Math.min(2 ** zoom - 1, y)); }
function haversine(a: Coordinate, b: Coordinate) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function interpolate(a: Coordinate, b: Coordinate, ratio: number): Coordinate {
  let longitudeDelta = b.lng - a.lng;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  const longitude = ((a.lng + longitudeDelta * ratio + 540) % 360) - 180;
  return { lat: a.lat + (b.lat - a.lat) * ratio, lng: longitude };
}
function sampleRoute(route: Coordinate[], maxSpacingMeters: number): Coordinate[] {
  if (route.length < 2) throw new Error('A valid route with at least two points is required to prepare offline maps.');
  if (!route.every((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180)) throw new Error('The route contains invalid latitude or longitude coordinates.');
  if (route.some((point) => point.lat < -85.05112878 || point.lat > 85.05112878)) throw new Error('This MapLibre Web Mercator basemap cannot cover routes beyond 85.05° north or south. The route itself can still be saved, but choose a polar-capable map provider for a basemap.');
  const result: Coordinate[] = [route[0]];
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const distance = haversine(start, end);
    const count = Math.max(1, Math.ceil(distance / maxSpacingMeters));
    for (let step = 1; step <= count; step += 1) result.push(interpolate(start, end, step / count));
  }
  return result;
}
function routeTileCoordinates(route: Coordinate[], zoom: number, bufferMeters: number) {
  const meanLatitude = route.reduce((sum, point) => sum + point.lat, 0) / route.length;
  const approximateTileWidth = 40_075_016.686 * Math.max(0.08, Math.cos(meanLatitude * Math.PI / 180)) / (2 ** zoom);
  const points = sampleRoute(route, Math.min(1000, Math.max(25, approximateTileWidth / 2)));
  const found = new Set<string>();
  for (const point of points) {
    const xFloat = tileX(point.lng, zoom);
    const yFloat = tileY(point.lat, zoom);
    const centerX = Math.floor(xFloat);
    const centerY = Math.floor(yFloat);
    const latitudeScale = Math.max(0.08, Math.cos(point.lat * Math.PI / 180));
    const tileWidthMeters = 40_075_016.686 * latitudeScale / (2 ** zoom);
    const ratio = bufferMeters / tileWidthMeters;
    const radius = Math.ceil(ratio);
    for (let dx = -radius; dx <= radius; dx += 1) {
      const xDistance = dx < 0 ? (xFloat - centerX) + (-dx - 1) : dx > 0 ? (centerX + 1 - xFloat) + (dx - 1) : 0;
      if (dx !== 0 && xDistance > ratio) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yDistance = dy < 0 ? (yFloat - centerY) + (-dy - 1) : dy > 0 ? (centerY + 1 - yFloat) + (dy - 1) : 0;
        if (dy !== 0 && yDistance > ratio) continue;
        found.add(`${wrapX(centerX + dx, zoom)}/${clampY(centerY + dy, zoom)}/${zoom}`);
        if (found.size > MAX_TILE_COUNT) throw new Error(`This route requires more than ${MAX_TILE_COUNT.toLocaleString()} map tiles at zoom ${zoom}. Shorten the route or configure a lower maximum zoom.`);
      }
    }
  }
  return [...found].map((value) => value.split('/').map(Number) as [number, number, number]);
}
function quadKey(x: number, y: number, zoom: number) {
  let key = '';
  for (let level = zoom; level > 0; level -= 1) {
    let digit = 0;
    const mask = 1 << (level - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}
function replaceTemplate(template: string, x: number, y: number, z: number, scheme: 'xyz' | 'tms', subdomain = 'a', ratio = '') {
  const maxY = 2 ** z - y - 1;
  const result = template.replaceAll('{x}', String(x)).replaceAll('{y}', String(scheme === 'tms' ? maxY : y)).replaceAll('{-y}', String(maxY)).replaceAll('{z}', String(z)).replaceAll('{quadkey}', quadKey(x, y, z)).replaceAll('{s}', subdomain).replaceAll('{ratio}', ratio);
  if (/\{[^}]+\}/.test(result)) throw new Error(`The map provider uses an unsupported tile URL placeholder in ${template}.`);
  return result;
}
function uniqueResource(map: Map<string, ResourceRequest>, request: ResourceRequest) {
  const prior = map.get(request.url);
  if (!prior || (!prior.required && request.required)) map.set(request.url, request);
}
function getFontStacks(style: MapStyle) {
  const stacks = new Set<string>();
  for (const layer of style.layers ?? []) {
    const value = layer.layout?.['text-font'];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) stacks.add(value.join(','));
    else if (typeof value === 'string') stacks.add(value);
  }
  return [...stacks];
}
function glyphRanges(textValues: string[]) {
  const ranges = new Set<number>([0, 256, 768, 8192]);
  for (const text of textValues) {
    for (const character of text) ranges.add(Math.floor(character.codePointAt(0)! / 256) * 256);
  }
  return [...ranges].sort((a, b) => a - b).map((start) => `${start}-${start + 255}`);
}
async function fetchStyle(url: string, hosts: Set<string>, resources: Map<string, ResourceRequest>, depth = 0): Promise<MapStyle[]> {
  if (depth > MAX_STYLE_IMPORT_DEPTH) throw new Error('The map style contains too many nested style imports.');
  const safeUrl = assertAllowed(url, hosts);
  const existing = resources.get(safeUrl);
  if (!existing) resources.set(safeUrl, { url: safeUrl, kind: 'style', required: true });
  const response = await fetch(safeUrl, { mode: 'cors' });
  if (!response.ok) throw new Error(`Could not download map style (${response.status}).`);
  const style = await response.json() as MapStyle;
  for (const source of Object.values(style.sources ?? {})) {
    if (source.type === 'image' && source.url) {
      uniqueResource(resources, { url: assertAllowed(new URL(source.url, safeUrl).toString(), hosts), kind: 'asset', required: true });
    } else if (source.type === 'geojson' && typeof source.data === 'string') {
      uniqueResource(resources, { url: assertAllowed(new URL(source.data, safeUrl).toString(), hosts), kind: 'asset', required: true });
    } else if (source.type === 'video' && source.urls?.length) {
      for (const url of source.urls) uniqueResource(resources, { url: assertAllowed(new URL(url, safeUrl).toString(), hosts), kind: 'asset', required: true });
    } else if (source.url) {
      const sourceUrl = assertAllowed(new URL(source.url, safeUrl).toString(), hosts);
      uniqueResource(resources, { url: sourceUrl, kind: 'tilejson', required: true });
      const tileResponse = await fetch(sourceUrl, { mode: 'cors' });
      if (!tileResponse.ok) throw new Error(`Could not load map source metadata (${tileResponse.status}).`);
      const tileJson = await tileResponse.json() as TileJson;
      source.tiles = tileJson.tiles ?? [];
      source.templateBase = sourceUrl;
      source.minzoom = tileJson.minzoom ?? source.minzoom;
      source.maxzoom = tileJson.maxzoom ?? source.maxzoom;
      source.scheme = tileJson.scheme ?? source.scheme;
      source.subdomains = tileJson.subdomains ?? source.subdomains;
    }
  }
  const styleList: MapStyle[] = [style];
  for (const imported of style.imports ?? []) {
    if (imported.url) styleList.push(...await fetchStyle(new URL(imported.url, safeUrl).toString(), hosts, resources, depth + 1));
  }
  return styleList;
}
function appendResourceSuffix(value: string, suffix: string) {
  const url = new URL(value);
  url.pathname = `${url.pathname}${suffix}`;
  return url.toString();
}
function addStyleDependencies(style: MapStyle, styleUrl: string, hosts: Set<string>, resources: Map<string, ResourceRequest>, labelText: string[]) {
  if (style.sprite) {
    const sprites = Array.isArray(style.sprite) ? style.sprite : [style.sprite];
    for (const sprite of sprites) {
      const spriteUrl = typeof sprite === 'string' ? sprite : sprite.url;
      const base = assertAllowed(new URL(spriteUrl, styleUrl).toString(), hosts);
      for (const suffix of ['', '@2x']) {
        const highDensityRequired = suffix === '@2x' && window.devicePixelRatio >= 2;
        uniqueResource(resources, { url: appendResourceSuffix(base, `${suffix}.json`), kind: 'sprite', required: suffix === '' || highDensityRequired });
        uniqueResource(resources, { url: appendResourceSuffix(base, `${suffix}.png`), kind: 'sprite', required: suffix === '' || highDensityRequired });
      }
    }
  }
  if (style.glyphs) {
    const glyphTemplate = assertAllowed(new URL(style.glyphs, styleUrl).toString(), hosts);
    const fontStacks = getFontStacks(style);
    const ranges = glyphRanges(labelText);
    for (const font of fontStacks) {
      for (const range of ranges) {
        const url = glyphTemplate
          .replaceAll('%7Bfontstack%7D', encodeURIComponent(font)).replaceAll('{fontstack}', encodeURIComponent(font))
          .replaceAll('%7Brange%7D', range).replaceAll('{range}', range);
        uniqueResource(resources, { url, kind: 'glyph', required: true });
      }
    }
  }
}
async function cacheResources(cache: Cache, requests: ResourceRequest[], onProgress?: (progress: TilePackProgress) => void) {
  let downloaded = 0;
  let reused = 0;
  let failed = 0;
  let sizeBytes = 0;
  const concurrency = 4;
  for (let offset = 0; offset < requests.length; offset += concurrency) {
    const batch = requests.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(batch.map(async (resource) => {
      const cached = await cache.match(resource.url);
      if (cached) return { result: 'reused' as const, bytes: 0, resource };
      const response = await fetch(resource.url, { mode: 'cors' });
      if (!response.ok) throw new Error(`${resource.kind} request failed (${response.status}).`);
      const contentLength = Number(response.headers.get('content-length')) || 0;
      const body = await response.clone().arrayBuffer();
      await cache.put(resource.url, response.clone());
      return { result: 'downloaded' as const, bytes: Math.max(contentLength, body.byteLength), resource };
    }));
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === 'fulfilled') {
        if (result.value.result === 'downloaded') downloaded += 1; else reused += 1;
        sizeBytes += result.value.bytes;
      } else {
        failed += 1;
        if (requests[offset + index].required) throw new Error(`${requests[offset + index].kind} could not be saved for offline use: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`);
      }
    }
    onProgress?.({ stage: 'downloading', completed: Math.min(offset + batch.length, requests.length), total: requests.length, message: `Saving map resources ${Math.min(offset + batch.length, requests.length).toLocaleString()} of ${requests.length.toLocaleString()}` });
  }
  return { downloaded, reused, failed, sizeBytes };
}
async function requestPersistentStorage() {
  if (!navigator.storage) return false;
  let persistentStorage = false;
  try { persistentStorage = await navigator.storage.persisted(); } catch { /* unsupported permission query */ }
  if (!persistentStorage && navigator.storage.persist) {
    try { persistentStorage = await navigator.storage.persist(); } catch { /* denial does not block download */ }
  }
  return persistentStorage;
}
async function storagePreflight(resourceCount: number, persistentStorage: boolean) {
  if (!navigator.storage?.estimate) return { persistentStorage };
  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota > 0) {
    const required = resourceCount * TILE_ESTIMATE_BYTES + STORAGE_RESERVE_BYTES;
    const available = Math.max(0, quota - usage);
    if (available < required) throw new Error(`Not enough device storage for this map pack. About ${Math.ceil(required / 1024 / 1024)} MB is recommended; ${Math.floor(available / 1024 / 1024)} MB is currently available. Remove an older map pack or choose a smaller route.`);
  }
  return { persistentStorage };
}

export async function downloadOfflineTilePack(
  tripId: string,
  route: Coordinate[],
  labels: string[],
  onProgress?: (progress: TilePackProgress) => void,
): Promise<TilePackResult> {
  ensureCacheSupport();
  const styleUrl = window.TRAIL_CONFIG?.mapStyleUrl;
  if (!styleUrl) throw new Error('An offline-licensed MapLibre style URL must be configured first.');
  const persistentStorage = await requestPersistentStorage();
  const hosts = configuredHosts(styleUrl);
  const resourceMap = new Map<string, ResourceRequest>();
  const initialStyleUrl = assertAllowed(styleUrl, hosts);
  onProgress?.({ stage: 'preparing', completed: 0, total: 0, message: 'Preparing map resources' });
  const styles = await fetchStyle(initialStyleUrl, hosts, resourceMap);
  for (let index = 0; index < styles.length; index += 1) {
    const styleBase = index === 0 ? initialStyleUrl : [...resourceMap.keys()].filter((url) => resourceMap.get(url)?.kind === 'style')[index];
    addStyleDependencies(styles[index], styleBase, hosts, resourceMap, labels);
  }

  const tileRequests = new Set<string>();
  for (const style of styles) for (const source of Object.values(style.sources ?? {})) {
    const templates = source.tiles ?? [];
    const minZoom = Math.max(DEFAULT_MIN_ZOOM, source.minzoom ?? DEFAULT_MIN_ZOOM);
    const maxZoom = Math.min(DEFAULT_MAX_ZOOM, source.maxzoom ?? DEFAULT_MAX_ZOOM);
    for (const template of templates) {
      for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
        for (const [x, y, z] of routeTileCoordinates(route, zoom, CORRIDOR_BUFFER_METERS)) {
          const templateBase = source.templateBase ?? initialStyleUrl;
          const highDensity = window.devicePixelRatio >= 2 && template.includes('{ratio}');
          const ratios = highDensity ? ['@2x'] : [''];
          const subdomains = template.includes('{s}') ? (source.subdomains?.length ? source.subdomains : ['a', 'b', 'c']) : ['a'];
          for (const ratio of ratios) for (const subdomain of subdomains) {
            const url = assertAllowed(new URL(replaceTemplate(template, x, y, z, source.scheme ?? 'xyz', subdomain, ratio), templateBase).toString(), hosts);
            tileRequests.add(url);
            if (tileRequests.size > MAX_TILE_COUNT) throw new Error(`This route requires more than ${MAX_TILE_COUNT.toLocaleString()} map tiles at zoom levels ${DEFAULT_MIN_ZOOM}–${DEFAULT_MAX_ZOOM}. Shorten the route or configure a lower maximum zoom.`);
          }
        }
      }
    }
  }
  for (const url of tileRequests) uniqueResource(resourceMap, { url, kind: 'tile', required: true });
  if (!tileRequests.size) throw new Error('The selected style does not expose cacheable tiles for this route.');
  const requests = [...resourceMap.values()];
  const quota = await storagePreflight(requests.length, persistentStorage);
  const cacheName = `${MAP_PACK_PREFIX}${encodeURIComponent(tripId)}-${Date.now()}`;
  const cache = await caches.open(cacheName);
  try {
    const result = await cacheResources(cache, requests, onProgress);
    // Optional high-density sprite variants may be absent; required styles, glyphs and tiles are checked below.
    onProgress?.({ stage: 'verifying', completed: 0, total: requests.length, message: 'Verifying saved map resources' });
    const keys = await cache.keys();
    const missingRequired = requests.filter((request) => request.required && !keys.some((key) => key.url === request.url));
    if (missingRequired.length) throw new Error(`${missingRequired.length} required map resources are missing after download.`);
    const metadata: TilePackResult = {
      tripId, cacheName, styleUrl: initialStyleUrl, createdAt: Date.now(), tileCount: tileRequests.size,
      resourceCount: keys.length, requiredResourceUrls: requests.filter((request) => request.required).map((request) => request.url), sizeBytes: result.sizeBytes, minZoom: DEFAULT_MIN_ZOOM, maxZoom: DEFAULT_MAX_ZOOM,
      bufferMeters: CORRIDOR_BUFFER_METERS, persistentStorage: quota.persistentStorage,
      downloaded: result.downloaded, reused: result.reused, failed: result.failed,
    };
    onProgress?.({ stage: 'verifying', completed: requests.length, total: requests.length, message: 'Offline map saved and verified' });
    return metadata;
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

export async function deleteOfflineTilePack(cacheName: string) {
  if (!cacheName.startsWith(MAP_PACK_PREFIX)) throw new Error('Refusing to delete a cache outside Trail map packs.');
  await caches.delete(cacheName);
}
export async function hasOfflineTilePack(cacheName: string, minimumResources = 1, requiredResourceUrls: string[] = []) {
  if (!cacheName.startsWith(MAP_PACK_PREFIX)) return false;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length < minimumResources) return false;
  if (!requiredResourceUrls.length) return true;
  const cachedUrls = new Set(keys.map((key) => key.url));
  return requiredResourceUrls.every((url) => cachedUrls.has(url));
}
export async function getOfflineStorageEstimate() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0, persistent: false };
  const [estimate, persistent] = await Promise.all([
    navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 })),
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(false),
  ]);
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persistent };
}
export function formatStorageSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
