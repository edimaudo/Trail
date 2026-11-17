import type { Coordinate } from '../types';

const CACHE_NAME = 'trail-licensed-map-tiles';
const MAX_TILE_COUNT = 1800;
const MIN_ZOOM = 10;
const MAX_ZOOM = 15;

interface TileSource {
  tiles?: string[];
  url?: string;
  minzoom?: number;
  maxzoom?: number;
  scheme?: 'xyz' | 'tms';
}

interface MapStyle {
  sources?: Record<string, TileSource>;
}

function allowedHosts(styleUrl: string) {
  const configured = (window.TRAIL_CONFIG?.offlineTileHosts || '').split(',').map((host) => host.trim()).filter(Boolean);
  configured.push(new URL(styleUrl).hostname);
  return new Set(configured);
}

function tileX(longitude: number, zoom: number) {
  return Math.floor((longitude + 180) / 360 * 2 ** zoom);
}

function tileY(latitude: number, zoom: number) {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = lat * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * 2 ** zoom);
}

function quadKey(x: number, y: number, zoom: number) {
  let key = '';
  for (let i = zoom; i > 0; i -= 1) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += digit;
  }
  return key;
}

function expandTemplate(template: string, x: number, y: number, z: number, scheme: 'xyz' | 'tms') {
  const finalY = scheme === 'tms' ? 2 ** z - y - 1 : y;
  return template
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(finalY))
    .replaceAll('{-y}', String(2 ** z - y - 1))
    .replaceAll('{z}', String(z))
    .replaceAll('{quadkey}', quadKey(x, y, z))
    .replaceAll('{r}', '');
}

async function sourceTileTemplates(source: TileSource, hosts: Set<string>, cache: Cache, styleUrl: string) {
  if (source.tiles?.length) return source.tiles;
  if (!source.url) return [];
  const tileJsonUrl = new URL(source.url, styleUrl);
  if (!hosts.has(tileJsonUrl.hostname)) return [];
  const response = await fetch(tileJsonUrl.toString());
  if (!response.ok) return [];
  await cache.put(tileJsonUrl.toString(), response.clone());
  const tileJson = await response.json() as { tiles?: string[] };
  return tileJson.tiles ?? [];
}

export interface TilePackResult {
  downloaded: number;
  cached: number;
  failed: number;
  total: number;
}

export async function downloadOfflineTilePack(route: Coordinate[], onProgress?: (done: number, total: number) => void): Promise<TilePackResult> {
  const styleUrl = window.TRAIL_CONFIG?.mapStyleUrl;
  if (!styleUrl) throw new Error('A MapLibre style URL is required before downloading a basemap pack.');
  if (!('caches' in window)) throw new Error('This browser does not support the Cache API needed for offline map tiles.');
  const hosts = allowedHosts(styleUrl);
  const styleHost = new URL(styleUrl).hostname;
  if (!hosts.has(styleHost)) throw new Error('The map style host is not in the licensed offline host allowlist.');

  const styleResponse = await fetch(styleUrl);
  if (!styleResponse.ok) throw new Error(`Could not load the map style (${styleResponse.status}).`);
  const style = await styleResponse.clone().json() as MapStyle;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(styleUrl, styleResponse.clone());

  const bounds = route.reduce((acc, point) => ({
    minLat: Math.min(acc.minLat, point.lat), maxLat: Math.max(acc.maxLat, point.lat),
    minLng: Math.min(acc.minLng, point.lng), maxLng: Math.max(acc.maxLng, point.lng)
  }), { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 });
  const latPadding = 500 / 111_320;
  const meanLat = (bounds.minLat + bounds.maxLat) / 2;
  const lngPadding = latPadding / Math.max(0.15, Math.cos(meanLat * Math.PI / 180));
  const minLat = bounds.minLat - latPadding;
  const maxLat = bounds.maxLat + latPadding;
  const minLng = bounds.minLng - lngPadding;
  const maxLng = bounds.maxLng + lngPadding;

  const urls = new Set<string>();
  for (const source of Object.values(style.sources ?? {})) {
    const templates = await sourceTileTemplates(source, hosts, cache, styleUrl);
    const minZoom = Math.max(MIN_ZOOM, source.minzoom ?? MIN_ZOOM);
    const maxZoom = Math.min(MAX_ZOOM, source.maxzoom ?? MAX_ZOOM);
    for (const template of templates) {
      for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
        const minX = tileX(minLng, zoom);
        const maxX = tileX(maxLng, zoom);
        const minY = tileY(maxLat, zoom);
        const maxY = tileY(minLat, zoom);
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            const url = new URL(expandTemplate(template, x, y, zoom, source.scheme ?? 'xyz'), styleUrl);
            if (hosts.has(url.hostname)) urls.add(url.toString());
            if (urls.size > MAX_TILE_COUNT) throw new Error(`This route needs more than ${MAX_TILE_COUNT.toLocaleString()} map tiles. Zoom coverage was capped to protect device storage.`);
          }
        }
      }
    }
  }

  const tileUrls = [...urls];
  if (!tileUrls.length) throw new Error('No tile URLs were found on an allowlisted host. Check the style sources and OFFLINE_TILE_HOSTS.');
  let downloaded = 0;
  let cached = 0;
  let failed = 0;
  const concurrency = 6;
  for (let index = 0; index < tileUrls.length; index += concurrency) {
    const batch = tileUrls.slice(index, index + concurrency);
    const responses = await Promise.allSettled(batch.map(async (url) => {
      const cached = await cache.match(url);
      if (cached) return 'cached' as const;
      const response = await fetch(url);
      if (!response.ok && response.type !== 'opaque') throw new Error(`Tile request failed: ${response.status}`);
      await cache.put(url, response.clone());
      return 'downloaded' as const;
    }));
    for (const result of responses) {
      if (result.status === 'rejected') failed += 1;
      else if (result.value === 'downloaded') downloaded += 1;
      else cached += 1;
    }
    onProgress?.(downloaded + cached + failed, tileUrls.length);
  }
  if (downloaded + cached === 0) throw new Error('No map tiles could be cached. Check the tile provider, host allowlist, network connection and storage quota.');
  return { downloaded, cached, failed, total: tileUrls.length };
}
