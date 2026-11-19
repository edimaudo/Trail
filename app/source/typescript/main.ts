import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { loadRuntimeConfig, type TrailRuntimeConfig } from './config.js';
import { initializeFirebase, getAppCheckIssue } from './lib/firebase.js';
import { apiPost } from './lib/api.js';
import { askTrailAssistant, compileFieldGuide, getLocalModelCapability } from './lib/ai.js';
import { getTripBundle, getTripChat, listTripBundles, listMapPacks, saveMapPack, removeMapPackRecord, saveChatMessage, saveTripBundle } from './lib/db.js';
import { addGpsDrift, buildTelemetry, demoLandmarks, demoTrip, haversineMeters, pointAtProgress } from './lib/geo.js';
import { deleteOfflineTilePack, downloadOfflineTilePack, formatStorageSize, getOfflineStorageEstimate, hasOfflineTilePack, type TilePackProgress } from './lib/offlineTiles.js';
import { evaluateTripOfflineReadiness } from './lib/offlineReadiness.js';
import type { ActivityType, ChatMessage, Coordinate, Difficulty, FieldGuide, Landmark, MapPackMetadata, Telemetry, Trip, TripBundle, TrailConditions } from './types.js';

const SAFETY_ADVISORY = 'For educational trail reference only. Never consume wild plants/fungi based solely on AI identification. Call local emergency services for severe injuries.';

type CompiledTripResponse = { trip: Trip; landmarks: Landmark[]; provider: string; notice: string };

const state: {
  config?: TrailRuntimeConfig;
  bundles: TripBundle[];
  activeTripId: string;
  chat: ChatMessage[];
  localModelAvailable: boolean;
  isOnline: boolean;
  activeSection: 'trail' | 'guide';
  plannerOpen: boolean;
  compilingTrip: boolean;
  compilingGuide: boolean;
  compileMessage: string;
  assistantBusy: boolean;
  progress: number;
  playing: boolean;
  playbackSpeed: 1 | 5 | 10;
  deviceGps: boolean;
  devicePosition?: Coordinate;
  deviceSpeedKmh: number;
  gpsAccuracy: number;
  proximityRadiusM: number;
  proximityAlert?: Landmark;
  selectedLandmark?: string;
  attachedImage?: File;
  attachedPreview?: string;
  tilePackBusy: boolean;
  tilePackProgress?: TilePackProgress;
  mapPacks: MapPackMetadata[];
  storageEstimate: { usage: number; quota: number; persistent: boolean };
  toastTimer?: number;
  playbackTimer?: number;
  watchId?: number;
  alerted: Set<string>;
  lastDistances: Record<string, number>;
  collapsedSections: Set<string>;
} = {
  bundles: [], activeTripId: '', chat: [], localModelAvailable: false,
  isOnline: navigator.onLine, activeSection: 'trail', plannerOpen: false,
  compilingTrip: false, compilingGuide: false, compileMessage: '', assistantBusy: false,
  progress: 0.035, playing: false, playbackSpeed: 1, deviceGps: false, deviceSpeedKmh: 0,
  gpsAccuracy: 7, proximityRadiusM: 100, tilePackBusy: false, mapPacks: [], storageEstimate: { usage: 0, quota: 0, persistent: false }, alerted: new Set(), lastDistances: {}, collapsedSections: new Set(),
};

let map: MapLibreMap | undefined;
let mapLoaded = false;
let lastMapErrorToast = false;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);
const online = () => state.isOnline;
const activeBundle = () => state.bundles.find((item) => item.trip.id === state.activeTripId) ?? state.bundles[0];
const currentTrip = () => activeBundle()?.trip;
const currentGuide = () => activeBundle()?.guide;
const currentLandmarks = () => activeBundle()?.landmarks ?? [];
const guideIsReady = () => Boolean(currentGuide() && currentGuide()!.wordCount >= 2000);

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours ? `${hours}h ${remaining}m` : `${minutes} min`;
}

function formatClock(value?: string | null, timeZone?: string) {
  if (!value) return '—';
  // Open-Meteo returns sunrise/sunset as local wall-clock timestamps without an offset.
  // Preserve that local clock; only convert values that contain an explicit timezone.
  const localWallClock = value.match(/T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (localWallClock) {
    const hasExplicitZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
    if (!hasExplicitZone) {
      const hour = Number(localWallClock[1]);
      const minute = localWallClock[2];
      return `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(parsed);
}

function formatTemperature(value?: number | null) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}°`;
}

function weatherDescription(code?: number | null) {
  if (code === null || code === undefined) return 'Forecast unavailable';
  if (code === 0) return 'Clear';
  if ([1, 2].includes(code)) return 'Mostly clear / partly cloudy';
  if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Variable conditions';
}

function conditionsPanel(trip: Trip, conditions?: TrailConditions) {
  if (!conditions) return '';
  const departure = trip.departureAt ? new Date(trip.departureAt) : undefined;
  const sunset = conditions.sunset ? new Date(conditions.sunset) : undefined;
  const expectedFinish = departure && !Number.isNaN(departure.getTime()) ? new Date(departure.getTime() + trip.durationMinutes * 60_000) : undefined;
  const daylightWarning = expectedFinish && sunset && !Number.isNaN(sunset.getTime()) && expectedFinish.getTime() > sunset.getTime() - 30 * 60_000;
  const risks = conditions.planningNotes ?? [];
  const staleLabel = conditions.fetchedAt ? `Updated ${formatClock(conditions.fetchedAt, conditions.timezone)}` : 'No refresh timestamp';
  return `<section class="conditions-section">
    <div class="section-heading-row"><div><h2>Conditions for your trip</h2></div><span class="data-freshness">${escapeHtml(staleLabel)}</span></div>
    <div class="conditions-overview"><div class="conditions-primary"><span>${escapeHtml(weatherDescription(conditions.weatherCode))}</span><strong>${formatTemperature(conditions.temperatureC ?? conditions.temperatureMaxC)}</strong><small>${conditions.forecastAvailable ? 'At planned departure' : 'Forecast unavailable'}</small></div><div class="condition-stat"><span>High / low</span><strong>${formatTemperature(conditions.temperatureMaxC)} / ${formatTemperature(conditions.temperatureMinC)}</strong></div><div class="condition-stat"><span>Precipitation</span><strong>${conditions.precipitationProbabilityMax == null ? '—' : `${Math.round(conditions.precipitationProbabilityMax)}%`}</strong></div><div class="condition-stat"><span>Wind gusts</span><strong>${conditions.windGustMaxKmh == null ? '—' : `${Math.round(conditions.windGustMaxKmh)} km/h`}</strong></div><div class="condition-stat"><span>UV max</span><strong>${conditions.uvIndexMax == null ? '—' : Math.round(conditions.uvIndexMax)}</strong></div></div>
    <div class="daylight-row"><div><span class="daylight-icon">☼</span><span><small>Sunrise</small><strong>${formatClock(conditions.sunrise, conditions.timezone)}</strong></span></div><div><span class="daylight-icon">◒</span><span><small>Sunset</small><strong>${formatClock(conditions.sunset, conditions.timezone)}</strong></span></div><div><span class="daylight-icon">◷</span><span><small>Daylight</small><strong>${conditions.daylightMinutes == null ? '—' : `${Math.floor(conditions.daylightMinutes / 60)}h ${conditions.daylightMinutes % 60}m`}</strong></span></div><div><small>Local time zone</small><strong>${escapeHtml(conditions.timezone || 'Not available')}</strong></div></div>
    ${conditions.routeSamples?.length ? `<div class="route-weather-samples"><strong>Forecast along route</strong><div>${conditions.routeSamples.map((sample) => `<span><b>${escapeHtml(sample.label)}</b><small>${sample.forecastAvailable ? `${formatTemperature(sample.temperatureC)} · ${sample.precipitationProbabilityMax == null ? '—' : `${Math.round(sample.precipitationProbabilityMax)}% rain`} · ${sample.windGustMaxKmh == null ? '—' : `${Math.round(sample.windGustMaxKmh)} km/h gusts`}` : 'Forecast unavailable'}</small></span>`).join('')}</div></div>` : ''}
    ${daylightWarning ? '<div class="environment-warning"><strong>Limited daylight buffer</strong><p>Estimated trip completion is within 30 minutes of or after sunset. Shorten the route or plan an earlier start.</p></div>' : ''}
    ${risks.length ? `<div class="environment-notes">${risks.map((risk) => `<p>${escapeHtml(risk)}</p>`).join('')}</div>` : ''}
    ${!conditions.forecastAvailable ? `<p class="environment-footnote">${escapeHtml(conditions.note || conditions.forecastError || 'Forecast unavailable for the selected date. Daylight values may be astronomical estimates.')}</p>` : `<p class="environment-footnote">Forecast model data is planning context, not an official severe-weather warning. Check the responsible national or regional weather authority before departure.</p>`}
    <p class="source-attribution">Weather data: <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0 attribution</a>.</p>
    ${conditions.commercialLicenseConfigured === false ? '<div class="commercial-weather-warning"><strong>Development weather endpoint</strong><span>Open-Meteo’s free endpoint is for non-commercial use. A paid commercial licence and customer API key (or another licensed provider) are required before client production deployment.</span></div>' : ''}
    </section>`;
}

function trailNetworkPanel(trip: Trip) {
  const matches = trip.officialTrailMatches ?? [];
  const sources = trip.dataSources ?? [];
  const trailSources = sources.filter((source) => [
    'ontario-trail-network', 'nps-public-trails', 'usfs-national-forest-trails', 'regional-authority'
  ].includes(source.id));
  const matchList = matches.slice(0, 12).map((match) => `<article class="trail-match-row"><div><strong>${escapeHtml(match.name)}</strong><small>${escapeHtml(match.association || match.permittedUses || 'Trail network segment')}${match.status ? ` · ${escapeHtml(match.status)}` : ''}</small></div><span>${formatDistance(match.distanceFromRouteM)} from route</span></article>`).join('');
  const attribution = trailSources.map((source) => `<span><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a> · ${escapeHtml(source.license)}${source.licenseUrl ? ` · <a href="${escapeHtml(source.licenseUrl)}" target="_blank" rel="noopener">terms</a>` : ''}</span>`).join('<br>');
  return `<section class="trail-network-section">
    <div class="section-heading-row"><div><h2>Mapped trail network <span class="count-bubble">${matches.length}</span></h2></div><span class="data-freshness">${trailSources.length ? 'Regional sources checked' : 'No source configured'}</span></div>
    ${matches.length ? `<div class="trail-match-list">${matchList}</div>` : `<div class="source-empty">No authoritative trail segments were returned within 500 m of this route. This does not mean the trail does not exist; regional coverage varies and a missing match is not proof of absence.</div>`}
    ${trailSources.length ? `<p class="source-attribution">${attribution}</p>` : '<p class="source-attribution">Ontario Trail Network, U.S. National Park Service and U.S. Forest Service sources are queried only within their geographic coverage. Configure another regional authority layer for additional areas.</p>'}
    <p class="route-caveat">Nearby official trail data indicates geographic proximity only. It does not certify trail access, current opening status, permitted use or safety. Confirm with the managing organization.</p>
    </section>`;
}

function localDateTimeInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function currentSeason() {
  const month = new Date().getMonth();
  if (month <= 1 || month === 11) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}

function toast(message: string) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, 4200);
}

function setStatus() {
  const notice = $('#assistant-notice');
  const localAssistantUnavailable = !online() && !state.localModelAvailable;
  if (notice) {
    notice.hidden = !localAssistantUnavailable;
    notice.textContent = localAssistantUnavailable
      ? 'This browser cannot run the local assistant right now. Your saved route, landmarks and field guide remain available.'
      : '';
  }
}

function currentTelemetry(): Telemetry {
  const trip = currentTrip();
  if (!trip) return { position: { lat: 0, lng: 0 }, elevationM: 0, speedKmh: 0, accuracyM: 0, routeProgress: 0 };
  const position = state.devicePosition ?? addGpsDrift(pointAtProgress(trip.route, state.progress), 3.2);
  return buildTelemetry(
    trip, currentLandmarks(), state.progress, position, state.gpsAccuracy,
    state.deviceGps ? 1 : state.playing ? state.playbackSpeed : 0,
    state.deviceGps ? state.deviceSpeedKmh : undefined,
  );
}

function renderTripList() {
  const container = $('#saved-trips');
  if (!container) return;
  if (!state.bundles.length) {
    container.innerHTML = '<p class="sidebar-empty">No saved trips yet.</p>';
    return;
  }
  container.innerHTML = state.bundles.map(({ trip }) => `
    <button class="saved-trip-item ${trip.id === state.activeTripId ? 'active' : ''}" data-trip-id="${escapeHtml(trip.id)}" type="button">
      <span class="saved-trip-label"><strong>${escapeHtml(trip.name)}</strong><small>${formatDistance(trip.distanceMeters)} · ${escapeHtml(trip.activity.replace('-', ' '))}</small></span>
    </button>`).join('');
}

function renderMainView() {
  const target = $('#main-view');
  const trip = currentTrip();
  if (!target || !trip) return;
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach((button) => button.classList.toggle('active', button.dataset.section === state.activeSection));
  if (state.activeSection === 'guide') {
    target.innerHTML = renderGuideView(trip, currentGuide());
  } else {
    target.innerHTML = renderTrailView(trip, currentGuide(), currentLandmarks());
  }
  if (state.activeSection === 'trail') initializeMap();
  renderTripList();
  updateTelemetryUI();
}

function offlineReadinessPanel(trip: Trip, guide: FieldGuide | undefined, landmarks: Landmark[]) {
  const readiness = evaluateTripOfflineReadiness(trip, landmarks, guide);
  const summary = trip.isDemo
    ? 'This illustrative route is for preview only. Create a real route to prepare trip data.'
    : readiness.tripDataReady
      ? 'Your route, place data, trail references, conditions and field guide are saved on this device. The offline basemap is tracked separately.'
      : `${readiness.coreCompletedCount} of ${readiness.coreTotalCount} trip data groups are saved. Review what is still needed before leaving connectivity.`;
  return `<section class="offline-package-card" aria-labelledby="offline-package-title">
    <div class="offline-package-heading"><div><h2 id="offline-package-title">Saved for offline</h2><p>${escapeHtml(summary)}</p></div><strong>${readiness.completedCount}/${readiness.totalCount}</strong></div>
    <div class="offline-package-progress" role="progressbar" aria-label="Offline trip resources saved" aria-valuemin="0" aria-valuemax="${readiness.totalCount}" aria-valuenow="${readiness.completedCount}"><span style="width:${Math.round(readiness.completedCount / readiness.totalCount * 100)}%"></span></div>
    <details class="offline-package-details"><summary>View saved trip contents</summary><div class="offline-package-list">${readiness.items.map((item) => `<div class="offline-package-item ${item.ready ? 'is-saved' : 'is-missing'}"><span class="resource-state" aria-hidden="true">${item.ready ? '✓' : '–'}</span><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span></div>`).join('')}</div></details>
  </section>`;
}

function mapStoragePanel(trip: Trip) {
  const pack = state.mapPacks.find((item) => item.tripId === trip.id);
  const storage = state.storageEstimate;
  const used = storage.quota > 0 ? `${formatStorageSize(storage.usage)} used of ${formatStorageSize(storage.quota)}` : `${formatStorageSize(storage.usage)} stored on this device`;
  const styleChanged = Boolean(pack && window.TRAIL_CONFIG?.mapStyleUrl && pack.styleUrl !== window.TRAIL_CONFIG.mapStyleUrl);
  const currentStatus = pack
    ? `${pack.tileCount.toLocaleString()} map tiles · ${pack.resourceCount.toLocaleString()} map resources · ${formatStorageSize(pack.sizeBytes)} saved${styleChanged ? ' · basemap style update available' : ''}`
    : 'No offline basemap is saved for this trip.';
  const packRows = state.mapPacks.length
    ? state.mapPacks.map((item) => {
      const tripName = state.bundles.find((bundle) => bundle.trip.id === item.tripId)?.trip.name ?? 'Saved trip';
      return `<div class="map-pack-row"><span><strong>${escapeHtml(tripName)}</strong><small>${item.tileCount.toLocaleString()} tiles · ${formatStorageSize(item.sizeBytes)} · ${new Date(item.createdAt).toLocaleDateString()}</small></span><button class="text-button" type="button" data-remove-map-pack="${escapeHtml(item.tripId)}" ${state.tilePackBusy ? 'disabled' : ''}>Remove</button></div>`;
    }).join('')
    : '<p class="map-storage-empty">No downloaded map packs yet.</p>';
  const progress = state.tilePackProgress;
  return `<section class="map-storage-card" aria-label="Offline map storage">
    <div class="map-storage-main"><div><h3>Offline map</h3><p>${escapeHtml(currentStatus)}</p><small>${escapeHtml(used)} · ${storage.persistent ? 'Protected from routine browser cleanup' : 'Browser storage may be cleared when device space is low'}${!window.TRAIL_CONFIG?.offlineTileDownloadsEnabled ? ' · Offline area downloads require a tile source that permits prefetching.' : ''}</small></div>
      <div class="map-storage-actions"><button id="cache-basemap" class="secondary-button compact-button" type="button" ${(!window.TRAIL_CONFIG?.offlineTileDownloadsEnabled || !window.TRAIL_CONFIG?.mapStyleUrl || !online() || state.tilePackBusy || trip.isDemo) ? 'disabled' : ''}>${state.tilePackBusy ? 'Saving map…' : pack ? 'Update map' : 'Download map'}</button>${pack ? `<button id="remove-current-map-pack" class="text-button" type="button" ${state.tilePackBusy ? 'disabled' : ''}>Remove map</button>` : ''}</div></div>
    ${progress ? `<div class="map-download-progress"><div class="map-download-progress-heading"><span>${escapeHtml(progress.message)}</span><strong>${progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%</strong></div><div class="offline-package-progress" role="progressbar" aria-label="Offline map download progress" aria-valuemin="0" aria-valuemax="${Math.max(1, progress.total)}" aria-valuenow="${progress.completed}"><span style="width:${progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%"></span></div></div>` : ''}
    <details class="map-storage-details"><summary>Manage downloaded maps (${state.mapPacks.length})</summary><div class="map-pack-list">${packRows}</div></details>
  </section>`;
}

async function refreshMapStorage() {
  state.storageEstimate = await getOfflineStorageEstimate();
  state.mapPacks = await listMapPacks();
}

async function reconcileMapPacks() {
  const packs = await listMapPacks();
  const valid: MapPackMetadata[] = [];
  for (const pack of packs) {
    try {
      if (await hasOfflineTilePack(pack.cacheName, pack.resourceCount, pack.requiredResourceUrls)) valid.push(pack);
      else {
        await removeMapPackRecord(pack.tripId);
        const bundle = state.bundles.find((item) => item.trip.id === pack.tripId);
        if (bundle?.trip.offlineSnapshot) { bundle.trip.offlineSnapshot.mapPackReady = false; bundle.trip.offlineSnapshot.mapPackTileCount = 0; }
      }
    } catch {
      await removeMapPackRecord(pack.tripId);
      const bundle = state.bundles.find((item) => item.trip.id === pack.tripId);
      if (bundle?.trip.offlineSnapshot) { bundle.trip.offlineSnapshot.mapPackReady = false; bundle.trip.offlineSnapshot.mapPackTileCount = 0; }
    }
  }
  const knownTripIds = new Set(state.bundles.map((bundle) => bundle.trip.id));
  for (const pack of valid) {
    if (!knownTripIds.has(pack.tripId)) {
      await deleteOfflineTilePack(pack.cacheName);
      await removeMapPackRecord(pack.tripId);
    }
  }
  state.mapPacks = valid.filter((pack) => knownTripIds.has(pack.tripId));
  const retainedTripIds = new Set(state.mapPacks.map((pack) => pack.tripId));
  // The Cache Storage entry may be evicted independently from IndexedDB. Clear
  // stale trip flags even when the mapPacks table entry itself has disappeared.
  for (const bundle of state.bundles) {
    if (bundle.trip.offlineSnapshot?.mapPackReady && !retainedTripIds.has(bundle.trip.id)) {
      await removeMapPackRecord(bundle.trip.id);
      bundle.trip.offlineSnapshot.mapPackReady = false;
      bundle.trip.offlineSnapshot.mapPackTileCount = 0;
    }
  }
  const retained = new Set(state.mapPacks.map((pack) => pack.cacheName));
  if ('caches' in window) {
    const orphaned = (await caches.keys()).filter((name) => name.startsWith('trail-map-pack-') && !retained.has(name));
    await Promise.all(orphaned.map((name) => caches.delete(name)));
  }
  state.storageEstimate = await getOfflineStorageEstimate();
}

function elevationProfilePanel(trip: Trip) {
  const samples = trip.elevationProfile ?? [];
  if (samples.length < 2) {
    return `<section class="elevation-profile-section"><div class="section-heading-row"><h2>Elevation profile</h2></div><p class="elevation-profile-empty">Elevation samples are not available for this route.</p></section>`;
  }
  const width = 640;
  const height = 112;
  const padX = 8;
  const padY = 12;
  const minimum = Math.min(...samples.map((sample) => sample.elevationM));
  const maximum = Math.max(...samples.map((sample) => sample.elevationM));
  const spread = Math.max(1, maximum - minimum);
  const totalDistance = Math.max(1, samples[samples.length - 1].distanceM);
  const points = samples.map((sample) => {
    const x = padX + (sample.distanceM / totalDistance) * (width - padX * 2);
    const y = height - padY - ((sample.elevationM - minimum) / spread) * (height - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<section class="elevation-profile-section"><div class="section-heading-row"><h2>Elevation profile</h2><span>${Math.round(minimum)}–${Math.round(maximum)} m</span></div><svg class="elevation-profile-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Elevation profile from ${Math.round(minimum)} to ${Math.round(maximum)} metres over ${formatDistance(totalDistance)}"><line x1="8" y1="${height - padY}" x2="${width - 8}" y2="${height - padY}"/><polyline points="${points}"/><text x="8" y="10">${Math.round(maximum)} m</text><text x="8" y="${height - 17}">${Math.round(minimum)} m</text></svg><div class="elevation-profile-axis"><span>Start</span><span>${formatDistance(totalDistance)}</span><span>Finish</span></div></section>`;
}

function renderTrailView(trip: Trip, guide: FieldGuide | undefined, landmarks: Landmark[]) {
  const ready = Boolean(guide && guide.wordCount >= 2000);
  return `
    <section class="main-heading">
      <div><h1>${escapeHtml(trip.name)}</h1><p>${escapeHtml(trip.startLabel)} <span aria-hidden="true">→</span> ${escapeHtml(trip.endLabel)}</p></div>
      <div class="heading-actions"><button id="new-trip" class="secondary-button" type="button">＋ New trip</button><button id="compile-guide" class="primary-button" type="button" ${(!online() || state.compilingGuide || !state.config?.firebaseConfigured) ? 'disabled' : ''}>${state.compilingGuide ? 'Compiling guide…' : ready ? 'Update guide' : 'Create field guide'}</button></div>
    </section>
    <section class="metrics-row" aria-label="Route summary">
      <div class="metric-block"><span>Distance</span><strong>${formatDistance(trip.distanceMeters)}</strong><small>Route length</small></div>
      <div class="metric-block"><span>Estimated time</span><strong>${formatDuration(trip.durationMinutes)}</strong><small>Activity-based estimate</small></div>
      <div class="metric-block"><span>Elevation gain</span><strong>${Math.round(trip.elevationGainM)} m</strong><small>Sampled terrain</small></div>
      <div class="metric-block"><span>Field guide</span><strong>${guide ? `${guide.wordCount.toLocaleString()}` : '—'}</strong><small>${ready ? 'Saved on this device' : guide ? 'Saved · incomplete' : 'Not compiled'}</small></div>
    </section>
    ${offlineReadinessPanel(trip, guide, landmarks)}
    ${elevationProfilePanel(trip)}
    <section id="planner-card" class="planner-card" ${state.plannerOpen ? '' : 'hidden'}>
      <form id="planner-form" class="planner-form">
        <div class="form-heading"><div><h2>Build a trail plan</h2><p>Use a mapped route or import a GPX track, then add trail-network, POI, weather and daylight context.</p></div></div>
        <label class="field-label" for="trip-name">Trip name</label><input id="trip-name" name="name" class="text-field" value="New trail trip" maxlength="100" required>
        <div class="field-grid"><div><label class="field-label" for="trip-start">Start point</label><input id="trip-start" name="start" class="text-field" placeholder="Trailhead or address"></div><div><label class="field-label" for="trip-end">End point / loop turnaround</label><input id="trip-end" name="end" class="text-field" placeholder="Destination or loop waypoint"></div></div>
        <div class="field-grid"><div><label class="field-label" for="trip-activity">Activity</label><select id="trip-activity" name="activity" class="text-field select-field"><option value="hiking">Hiking</option><option value="trail-running">Trail running</option><option value="cycling">Cycling</option></select></div><div><label class="field-label" for="trip-difficulty">Difficulty</label><select id="trip-difficulty" name="difficulty" class="text-field select-field"><option value="easy">Easy</option><option value="moderate" selected>Moderate</option><option value="strenuous">Strenuous</option></select></div></div>
        <div class="field-grid"><div><label class="field-label" for="trip-departure">Planned departure</label><input id="trip-departure" name="departureAt" type="datetime-local" class="text-field" value="${localDateTimeInput(new Date(Date.now() + 60 * 60_000))}"></div><div><label class="field-label" for="gpx-file">Import GPX route (optional)</label><input id="gpx-file" name="gpx" type="file" class="text-field file-field" accept=".gpx,application/gpx+xml,application/xml,text/xml"><small class="field-hint">GPX 1.0 / 1.1 · up to 2 MB · one continuous track</small></div></div>
        <label class="loop-control"><input type="checkbox" name="loop"> Create an out-and-back loop (return to the start via the entered turnaround)</label>
        <div class="planner-note"><span class="note-icon">↗</span><span>${state.config?.mapsConfigured ? 'Google route geometry and route-aligned POIs will be resolved by FastAPI. Ontario and supported U.S. routes are checked against regional public trail datasets.' : 'Google Maps is not configured. Import a GPX for a real route, or use the illustrative demo for interface testing only.'}</span></div>
        <div id="planner-status" class="planner-status" role="status">${escapeHtml(state.compileMessage)}</div>
        <button class="primary-button planner-submit" type="submit" ${state.compilingTrip ? 'disabled' : ''}>${state.compilingTrip ? 'Preparing trip…' : 'Create trip'}</button>
      </form>
    </section>
    ${conditionsPanel(trip, trip.conditions)}
    <section class="map-section">
      <div class="section-heading-row"><div><h2>Trail map</h2></div><div class="map-heading-actions"><button id="use-device-gps" class="secondary-button compact-button" type="button">${state.deviceGps ? 'Stop device GPS' : 'Use device GPS'}</button></div></div>
      <div class="map-shell"><div id="trail-map" aria-label="Saved route and landmarks map"></div><div id="map-placeholder" class="map-placeholder"><div><strong>${trip.isDemo ? 'Illustrative route preview' : 'Saved route geometry'}</strong><p>${trip.isDemo ? 'Add a Google Maps server key to create live trip routes. This preview is not for field navigation.' : 'Route and points of interest are stored locally for offline access.'}</p></div></div><div class="map-legend"><span><i class="legend-dot legend-route"></i> Planned route</span><span><i class="legend-dot legend-official"></i> Official trail data</span><span><i class="legend-dot legend-poi"></i> Points of interest</span><span><i class="legend-dot legend-user"></i> Your position</span></div></div>
      <p class="map-caption">${trip.isDemo ? 'Demo geometry only. Configure the Google Maps Platform server key to compile a live route.' : 'The route and POI overlay are stored locally. OpenStreetMap provides the live basemap; offline area downloads require a tile provider that explicitly permits prefetching.'}</p>
      ${mapStoragePanel(trip)}
      <p class="route-caveat">${trip.routeSource === 'gpx-import' ? 'Imported GPX geometry is user-supplied and has not been independently certified. Nearby official trail segments indicate proximity, not proof that the uploaded line is on an open trail.' : 'Google walking and cycling directions are not verified hiking-trail geometry. Nearby official trail segments indicate proximity, not proof that the complete route is open or safe. Confirm access and closures with the land manager.'}</p>
    </section>
    <section class="simulator-panel">
      <div class="section-heading-row simulator-heading"><div><h2>${state.deviceGps ? 'Device GPS' : 'GPS simulator'}</h2></div><div class="telemetry-inline"><span><i class="telemetry-dot"></i><b id="telemetry-speed">0.0</b> km/h</span><span><b id="telemetry-elevation">0</b> m elevation</span><span>±<b id="telemetry-accuracy">7</b> m accuracy</span></div></div>
      <div class="simulator-controls"><div class="playback-buttons"><button id="play-simulator" class="play-button ${state.playing ? 'is-playing' : ''}" type="button" ${state.deviceGps || state.progress >= 1 ? 'disabled' : ''} aria-label="${state.playing ? 'Pause' : 'Play'} route simulation">${state.playing ? 'Ⅱ' : '▶'}</button><button id="reset-simulator" class="reset-button" type="button" aria-label="Reset route simulation">↺</button></div><div class="scrub-control"><div class="scrub-topline"><span id="progress-label">${Math.round(state.progress * 100)}% complete</span><span id="distance-label">${formatDistance(trip.distanceMeters * state.progress)} of ${formatDistance(trip.distanceMeters)}</span></div><input id="route-scrubber" type="range" min="0" max="100" value="${Math.round(state.progress * 100)}" aria-label="Scrub route progress" ${state.deviceGps ? 'disabled' : ''}></div><div class="speed-selector"><span>Speed</span>${[1, 5, 10].map((speed) => `<button data-speed="${speed}" class="${state.playbackSpeed === speed ? 'speed-active' : ''}" type="button">${speed}×</button>`).join('')}</div></div>
      <div class="position-readout"><span class="position-pin">⌖</span><span id="position-coordinates">—</span><span class="readout-divider"></span><span id="position-nearest">No nearby saved landmark</span></div>
    </section>
    <div id="proximity-container"></div>
    <section class="landmarks-section"><div class="section-heading-row"><div><h2>Points of interest <span class="count-bubble">${landmarks.length}</span></h2></div><label class="radius-control">Alert radius <select id="proximity-radius"><option value="50" ${state.proximityRadiusM === 50 ? 'selected' : ''}>50 m</option><option value="100" ${state.proximityRadiusM === 100 ? 'selected' : ''}>100 m</option><option value="150" ${state.proximityRadiusM === 150 ? 'selected' : ''}>150 m</option><option value="250" ${state.proximityRadiusM === 250 ? 'selected' : ''}>250 m</option></select></label></div>
      ${landmarks.length ? `<div class="landmark-list">${landmarks.map((landmark) => `<button class="landmark-row ${state.selectedLandmark === landmark.id ? 'landmark-selected' : ''}" data-landmark-id="${escapeHtml(landmark.id)}" type="button"><span class="landmark-type landmark-${landmark.category}">${landmark.category === 'hazard' ? '!' : landmark.category === 'water' ? '≈' : landmark.category === 'facility' ? '⌂' : '⌖'}</span><span class="landmark-copy"><strong>${escapeHtml(landmark.name)}</strong><small>${escapeHtml(landmark.description)}</small></span><span class="landmark-distance" data-distance-id="${escapeHtml(landmark.id)}">—</span><span class="landmark-chevron">›</span></button>`).join('')}</div>` : '<div class="empty-inline">No landmarks were returned for this route. You can still use the cached route and GPS simulator.</div>'}
      <div id="landmark-detail"></div>
    </section>
    ${trailNetworkPanel(trip)}
    <section class="guide-preview-section"><div class="section-heading-row"><div><h2>Field guide</h2></div><button class="text-action" data-section="guide" type="button">View full guide →</button></div>
      ${guide ? `<div class="guide-summary"><div class="guide-summary-icon">▤</div><div><strong>${guide.wordCount.toLocaleString()} words saved on this device</strong><p>Flora and fauna, terrain, seasonal hazards and first-aid notes are stored locally.</p></div><span class="guide-saved-tag ${ready ? '' : 'guide-warn-tag'}">${ready ? '✓ Guide ready' : '! Needs more detail'}</span></div>` : `<div class="guide-missing"><div><strong>Your field guide has not been compiled yet.</strong><p>Create a route-specific guide and keep it with this trip.</p></div><button class="primary-button compact-button" id="compile-guide-inline" type="button" ${(!online() || state.compilingGuide || !state.config?.firebaseConfigured) ? 'disabled' : ''}>Create field guide</button></div>`}
    </section>
    ${state.compileMessage ? `<div class="compile-status ${state.compilingGuide || state.compilingTrip ? 'status-working' : ''}" role="status">${state.compilingGuide || state.compilingTrip ? '<span class="button-spinner"></span>' : ''}${escapeHtml(state.compileMessage)}</div>` : ''}
  `;
}

function renderGuideView(trip: Trip, guide: FieldGuide | undefined) {
  const sections: Array<{ key: keyof FieldGuide; title: string; icon: string }> = [
    { key: 'floraAndFauna', title: 'Flora and fauna', icon: '❀' },
    { key: 'navigationAndTerrain', title: 'Navigation and terrain', icon: '⌖' },
    { key: 'weatherAndHazards', title: 'Weather and hazards', icon: '☼' },
    { key: 'wildernessFirstAid', title: 'Wilderness first aid', icon: '+' },
  ];
  return `<section class="main-heading"><div><h1>Field guide</h1><p>${escapeHtml(trip.name)} · ${guide ? `${guide.wordCount.toLocaleString()} words saved on this device` : 'No field guide created yet'}</p></div><div class="heading-actions"><button class="secondary-button" data-section="trail" type="button">← Back to trail</button><button id="compile-guide" class="primary-button" type="button" ${(!online() || state.compilingGuide || !state.config?.firebaseConfigured) ? 'disabled' : ''}>${state.compilingGuide ? 'Compiling…' : guide ? 'Update guide' : 'Compile guide'}</button></div></section>
  <section class="full-guide-section">${guide ? `<div class="guide-toolbar"><div><h2>${guide.wordCount.toLocaleString()} words</h2><p>Available on this device without an internet connection.</p></div><div class="guide-toolbar-status"><span class="saved-badge ${guide.wordCount >= 2000 ? '' : 'guide-warn-tag'}">${guide.wordCount >= 2000 ? '✓ Guide ready' : 'Needs 2,000 words'}</span></div></div><div class="guide-accordion">${sections.map((section) => { const text = guide[section.key] as string; const collapsed = state.collapsedSections.has(section.key); return `<div class="guide-accordion-item"><button class="guide-accordion-trigger" data-guide-toggle="${section.key}" type="button"><span class="guide-section-icon">${section.icon}</span><strong>${section.title}</strong><span class="guide-section-count">${text.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words</span><span class="accordion-chevron">${collapsed ? '+' : '−'}</span></button>${collapsed ? '' : `<div class="guide-copy">${escapeHtml(text)}</div>`}</div>`; }).join('')}</div>` : `<div class="guide-empty-state"><span>▤</span><h3>Nothing cached yet</h3><p>Create a field guide for this trip. Your route and saved points of interest remain available on this device.</p></div>`}<div class="safety-note"><strong>Safety advisory</strong><p>${SAFETY_ADVISORY}</p></div></section>`;
}

function mapFeatures() {
  const trip = currentTrip();
  if (!trip) return { type: 'FeatureCollection' as const, features: [] };
  const points = currentLandmarks().map((landmark) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [landmark.position.lng, landmark.position.lat] },
    properties: { id: landmark.id, name: landmark.name, category: landmark.category },
  }));
  const officialLines = (trip.officialTrailMatches ?? []).flatMap((match) => match.geometry.map((line) => ({
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: line.map((point) => [point.lng, point.lat]) },
    properties: { kind: 'official-trail', name: match.name, source: match.source },
  })));
  const routeLine = { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: trip.route.map((point) => [point.lng, point.lat]) }, properties: { kind: 'route' } };
  const endpoints = [
    { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [trip.route[0].lng, trip.route[0].lat] }, properties: { id: `${trip.id}-start`, name: 'Start', category: 'trip-start' } },
    { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [trip.route[trip.route.length - 1].lng, trip.route[trip.route.length - 1].lat] }, properties: { id: `${trip.id}-finish`, name: 'Finish', category: 'trip-end' } },
  ];
  return { type: 'FeatureCollection' as const, features: [...officialLines, routeLine, ...points, ...endpoints] };
}

function localMapStyle() {
  return {
    version: 8 as const,
    sources: {
      'openstreetmap-raster': {
        type: 'raster' as const,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      },
    },
    layers: [
      { id: 'openstreetmap-base', type: 'raster' as const, source: 'openstreetmap-raster', minzoom: 0, maxzoom: 19 },
    ],
  };
}


function initializeMap(useFallback = false) {
  const container = $('#trail-map');
  const trip = currentTrip();
  if (!container || !trip) return;
  if (map) { map.remove(); map = undefined; mapLoaded = false; }
  const savedPack = state.mapPacks.find((pack) => pack.tripId === trip.id);
  const configuredStyle = !useFallback ? (savedPack?.styleUrl ?? window.TRAIL_CONFIG?.mapStyleUrl) : ''; 
  map = new maplibregl.Map({
    container,
    style: configuredStyle || localMapStyle(),
    center: [trip.route[0]?.lng ?? -75.2, trip.route[0]?.lat ?? 40.05],
    zoom: 13,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    if (!map) return;
    mapLoaded = true;
    map.addSource('trail-data', { type: 'geojson', data: mapFeatures() as GeoJSON.FeatureCollection });
    map.addLayer({ id: 'official-trails', type: 'line', source: 'trail-data', filter: ['==', ['get', 'kind'], 'official-trail'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a3ad69', 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': 0.85 } });
    map.addLayer({ id: 'trail-route-casing', type: 'line', source: 'trail-data', filter: ['==', ['get', 'kind'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'trail-route', type: 'line', source: 'trail-data', filter: ['==', ['get', 'kind'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3f7955', 'line-width': 4 } });
    map.addLayer({ id: 'trail-poi', type: 'circle', source: 'trail-data', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'category'], 'trip-start'], ['!=', ['get', 'category'], 'trip-end']], paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'category'], 'hazard', '#c27a58', 'water', '#5c92a5', 'facility', '#b28c53', '#bd8a4f'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'trail-poi-label', type: 'symbol', source: 'trail-data', filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'category'], 'trip-start'], ['!=', ['get', 'category'], 'trip-end']], minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': '#526657', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } });
    map.addLayer({ id: 'trip-start-marker', type: 'circle', source: 'trail-data', filter: ['==', ['get', 'category'], 'trip-start'], paint: { 'circle-radius': 10, 'circle-color': '#285541', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'trip-finish-marker', type: 'circle', source: 'trail-data', filter: ['==', ['get', 'category'], 'trip-end'], paint: { 'circle-radius': 10, 'circle-color': '#b66e3f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'trip-start-label', type: 'symbol', source: 'trail-data', filter: ['==', ['get', 'category'], 'trip-start'], layout: { 'text-field': 'Start', 'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#285541', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'trip-finish-label', type: 'symbol', source: 'trail-data', filter: ['==', ['get', 'category'], 'trip-end'], layout: { 'text-field': 'Finish', 'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#984f2c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    map.addSource('trail-user', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'trail-user-halo', type: 'circle', source: 'trail-user', paint: { 'circle-radius': 15, 'circle-color': '#3478a1', 'circle-opacity': 0.15 } });
    map.addLayer({ id: 'trail-user-point', type: 'circle', source: 'trail-user', paint: { 'circle-radius': 6, 'circle-color': '#3478a1', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    const coordinates = trip.route.map((point) => [point.lng, point.lat] as [number, number]);
    if (coordinates.length) {
      const bounds = coordinates.reduce((value, coordinate) => value.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
      map?.fitBounds(bounds, { padding: 45, maxZoom: 15, duration: 0 });
    }
    updateMapData();
    const placeholder = $('#map-placeholder');
    if (placeholder) placeholder.hidden = true;
  });
  map.on('error', () => {
    if (!mapLoaded && configuredStyle && !lastMapErrorToast) {
      lastMapErrorToast = true;
      toast('The configured basemap is unavailable. Loading the saved route on a local schematic map.');
      window.setTimeout(() => { lastMapErrorToast = false; initializeMap(true); }, 500);
    }
  });
  map.on('click', 'trail-poi', (event: { features?: Array<{ properties?: { id?: string } }> }) => {
    const id = event.features?.[0]?.properties?.id as string | undefined;
    if (id) selectLandmark(id);
  });
  map.on('mouseenter', 'trail-poi', () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'trail-poi', () => { if (map) map.getCanvas().style.cursor = ''; });
}

function updateMapData() {
  if (!map || !mapLoaded) return;
  const routeSource = map.getSource('trail-data') as GeoJSONSource | undefined;
  routeSource?.setData(mapFeatures() as GeoJSON.FeatureCollection);
  const position = currentTelemetry().position;
  const userSource = map.getSource('trail-user') as GeoJSONSource | undefined;
  userSource?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [position.lng, position.lat] }, properties: {} }] });
}

function updateTelemetryUI() {
  const trip = currentTrip();
  if (!trip) return;
  const telemetry = currentTelemetry();
  const speed = $('#telemetry-speed'); if (speed) speed.textContent = telemetry.speedKmh.toFixed(1);
  const elevation = $('#telemetry-elevation'); if (elevation) elevation.textContent = String(Math.round(telemetry.elevationM));
  const accuracy = $('#telemetry-accuracy'); if (accuracy) accuracy.textContent = String(Math.round(telemetry.accuracyM));
  const coordinates = $('#position-coordinates'); if (coordinates) coordinates.textContent = `${telemetry.position.lat.toFixed(5)}°, ${telemetry.position.lng.toFixed(5)}°`;
  const nearest = $('#position-nearest'); if (nearest) nearest.textContent = telemetry.nearestLandmark ? `${telemetry.nearestLandmark.name} · ${formatDistance(telemetry.nearestLandmarkDistanceM ?? 0)}` : 'No nearby saved landmark';
  const scrubber = $('#route-scrubber') as HTMLInputElement | null; if (scrubber && !state.deviceGps) scrubber.value = String(Math.round(state.progress * 100));
  const progressLabel = $('#progress-label'); if (progressLabel) progressLabel.textContent = `${Math.round(state.progress * 100)}% complete`;
  const distanceLabel = $('#distance-label'); if (distanceLabel) distanceLabel.textContent = `${formatDistance(trip.distanceMeters * state.progress)} of ${formatDistance(trip.distanceMeters)}`;
  document.querySelectorAll<HTMLElement>('[data-distance-id]').forEach((element) => {
    const landmark = currentLandmarks().find((item) => item.id === element.dataset.distanceId);
    if (landmark) element.textContent = formatDistance(haversineMeters(telemetry.position, landmark.position));
  });
  updateMapData();
  evaluateProximity(telemetry);
}

function evaluateProximity(telemetry: Telemetry) {
  let candidate: Landmark | undefined;
  for (const landmark of currentLandmarks()) {
    const distance = haversineMeters(telemetry.position, landmark.position);
    const previous = state.lastDistances[landmark.id];
    if (distance <= state.proximityRadiusM && previous !== undefined && previous > state.proximityRadiusM && !state.alerted.has(landmark.id)) candidate = landmark;
    if (distance <= state.proximityRadiusM && previous === undefined && !state.alerted.has(landmark.id) && state.progress > 0.02) candidate = landmark;
    state.lastDistances[landmark.id] = distance;
  }
  if (candidate) {
    state.alerted.add(candidate.id);
    state.proximityAlert = candidate;
    const container = $('#proximity-container');
    if (container) container.innerHTML = `<div class="proximity-alert"><span class="alert-icon">!</span><div><strong>Approaching ${escapeHtml(candidate.name)}</strong><p>${escapeHtml(candidate.description)}</p></div><button id="dismiss-alert" type="button" aria-label="Dismiss alert">×</button></div>`;
  }
}

function selectLandmark(id: string) {
  const item = currentLandmarks().find((place) => place.id === id);
  if (!item) return;
  state.selectedLandmark = id;
  const detail = $('#landmark-detail');
  if (detail) detail.innerHTML = `<div class="landmark-detail"><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description)}</p><button class="text-action" id="close-landmark" type="button">Close details</button></div>`;
  document.querySelectorAll('.landmark-row').forEach((row) => row.classList.toggle('landmark-selected', (row as HTMLElement).dataset.landmarkId === id));
  map?.easeTo({ center: [item.position.lng, item.position.lat], zoom: Math.max(map.getZoom(), 14), duration: 350 });
}

function startPlayback() {
  const trip = currentTrip();
  if (!trip || state.deviceGps || state.progress >= 1) return;
  state.playing = true;
  if (state.playbackTimer) window.clearInterval(state.playbackTimer);
  state.playbackTimer = window.setInterval(() => {
    const baseKmh = trip.activity === 'trail-running' ? 8.4 : trip.activity === 'cycling' ? 15.5 : 4.3;
    const metresPerSecond = (baseKmh * state.playbackSpeed) / 3.6;
    state.progress = Math.min(1, state.progress + metresPerSecond / Math.max(1, trip.distanceMeters));
    if (state.progress >= 1) stopPlayback();
    updatePlaybackButtons();
    updateTelemetryUI();
  }, 1000);
  updatePlaybackButtons();
}

function stopPlayback() {
  state.playing = false;
  if (state.playbackTimer) window.clearInterval(state.playbackTimer);
  state.playbackTimer = undefined;
  updatePlaybackButtons();
}

function updatePlaybackButtons() {
  const button = $('#play-simulator');
  if (button) {
    button.textContent = state.playing ? 'Ⅱ' : '▶';
    button.classList.toggle('is-playing', state.playing);
    (button as HTMLButtonElement).disabled = state.deviceGps || state.progress >= 1;
    button.setAttribute('aria-label', state.playing ? 'Pause route simulation' : 'Play route simulation');
  }
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => button.classList.toggle('speed-active', Number(button.dataset.speed) === state.playbackSpeed));
}

function stopDeviceGps() {
  if (state.watchId !== undefined) navigator.geolocation?.clearWatch(state.watchId);
  state.watchId = undefined;
  state.deviceGps = false;
  state.devicePosition = undefined;
  state.deviceSpeedKmh = 0;
}

function toggleDeviceGps() {
  if (state.deviceGps) {
    stopDeviceGps();
    renderMainView();
    return;
  }
  if (!navigator.geolocation) { toast('This browser does not expose device GPS. Use the simulator instead.'); return; }
  stopPlayback();
  state.deviceGps = true;
  state.watchId = navigator.geolocation.watchPosition((position) => {
    state.devicePosition = { lat: position.coords.latitude, lng: position.coords.longitude, altitude: position.coords.altitude ?? undefined };
    state.gpsAccuracy = position.coords.accuracy || 10;
    state.deviceSpeedKmh = position.coords.speed && position.coords.speed > 0 ? position.coords.speed * 3.6 : 0;
    updateTelemetryUI();
  }, (error) => {
    stopDeviceGps();
    toast(`Device GPS unavailable: ${error.message}`);
    renderMainView();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  renderMainView();
}

async function handleCreateTrip(form: HTMLFormElement) {
  const data = new FormData(form);
  const name = String(data.get('name') || 'New trail trip').trim();
  const start = String(data.get('start') || '').trim();
  const end = String(data.get('end') || '').trim();
  const activity = String(data.get('activity') || 'hiking') as ActivityType;
  const difficulty = String(data.get('difficulty') || 'moderate') as Difficulty;
  const loop = data.get('loop') === 'on';
  const departureInput = String(data.get('departureAt') || '');
  // datetime-local is expressed in the browser's local zone; send an absolute instant so
  // FastAPI can convert it into the forecast location's IANA timezone.
  const departureAt = departureInput ? new Date(departureInput).toISOString() : undefined;
  const gpxFile = ($('#gpx-file') as HTMLInputElement | null)?.files?.[0];
  if (!name) { toast('Enter a trip name.'); return; }
  if (!gpxFile && (!start || !end)) { toast('Enter a start and destination, or import a GPX route.'); return; }
  if (!online()) { toast('Reconnect before compiling geographic data.'); return; }
  state.compilingTrip = true;
  state.compileMessage = gpxFile ? `Validating ${gpxFile.name} and matching nearby trail data…` : 'Resolving route geometry, authoritative trail matches, POIs and weather…';
  renderMainView();
  try {
    let trip: Trip;
    let landmarks: Landmark[];
    if (gpxFile) {
      if (!gpxFile.name.toLowerCase().endsWith('.gpx') && !['application/gpx+xml', 'application/xml', 'text/xml'].includes(gpxFile.type)) {
        throw new Error('Choose a GPX 1.0 or 1.1 file.');
      }
      if (gpxFile.size > 2 * 1024 * 1024) throw new Error('GPX file exceeds the 2 MB import limit.');
      const gpxXml = await gpxFile.text();
      const result = await apiPost<CompiledTripResponse>('/api/trips/compile-gpx', {
        name, start: start || 'Imported GPX start', end: end || 'Imported GPX finish', activity, difficulty, departureAt,
        filename: gpxFile.name, gpxXml,
      });
      trip = result.trip;
      landmarks = result.landmarks;
      state.compileMessage = result.notice;
    } else if (state.config?.mapsConfigured) {
      const result = await apiPost<CompiledTripResponse>('/api/trips/compile', { name, start, end, loop, activity, difficulty, departureAt });
      trip = result.trip;
      landmarks = result.landmarks;
      state.compileMessage = result.notice;
    } else {
      trip = demoTrip();
      trip.id = crypto.randomUUID();
      trip.name = name;
      trip.startLabel = start;
      trip.endLabel = loop ? `Loop via ${end}` : end;
      trip.activity = activity;
      trip.difficulty = difficulty;
      trip.departureAt = departureAt;
      trip.isDemo = true;
      trip.readyForOffline = false;
      landmarks = demoLandmarks(trip.id);
      state.compileMessage = 'Illustrative demo route created. Import a GPX or configure Google Maps for real route data. No authoritative trail match or live forecast was attached.';
    }
    await saveTripBundle(trip, landmarks);
    stopPlayback();
    stopDeviceGps();
    state.bundles = await listTripBundles();
    state.activeTripId = trip.id;
    state.activeSection = 'trail';
    state.progress = 0.035;
    state.alerted.clear();
    state.lastDistances = {};
    state.proximityAlert = undefined;
    state.plannerOpen = false;
    renderMainView();
    renderTripList();
    toast(trip.isDemo ? 'Demo trip saved on this device.' : 'Trip, trail matches, POIs and environmental context saved locally.');
  } catch (error) {
    state.compileMessage = errorMessage(error);
    renderMainView();
    toast(state.compileMessage);
  } finally {
    state.compilingTrip = false;
    renderMainView();
  }
}

async function handleCompileGuide() {
  const trip = currentTrip();
  if (!trip) return;
  if (!online()) { toast('Connect to the internet to compile or regenerate a field guide.'); return; }
  if (!state.config?.firebaseConfigured) { toast('Add Firebase Web configuration to the FastAPI environment before compiling AI content.'); return; }
  state.compilingGuide = true;
  state.compileMessage = 'Preparing verified trip context through FastAPI, then generating the guide with Firebase AI Logic…';
  renderMainView();
  try {
    const guide = await compileFieldGuide({ trip, landmarks: currentLandmarks(), season: currentSeason() });
    trip.readyForOffline = evaluateTripOfflineReadiness(trip, currentLandmarks(), guide).fullyReady;
    trip.updatedAt = Date.now();
    await saveTripBundle(trip, currentLandmarks(), guide);
    state.bundles = await listTripBundles();
    state.activeSection = 'trail';
    const readiness = evaluateTripOfflineReadiness(trip, currentLandmarks(), guide);
    state.compileMessage = `Field guide saved: ${guide.wordCount.toLocaleString()} words. ${readiness.tripDataReady ? 'Trip data is saved. The offline basemap is still separate.' : `${readiness.coreCompletedCount} of ${readiness.coreTotalCount} trip data groups are saved.`}`;
    renderMainView();
    toast(`Field guide saved with ${guide.wordCount.toLocaleString()} words.`);
  } catch (error) {
    state.compileMessage = errorMessage(error);
    renderMainView();
    toast(state.compileMessage);
  } finally {
    state.compilingGuide = false;
    renderMainView();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The attached photo could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function renderChat() {
  const container = $('#assistant-messages');
  if (!container) return;
  if (!state.chat.length) {
    container.innerHTML = `<div class="assistant-empty"><h3>Ask about the trail ahead.</h3><p>Answers use this trip’s saved route, nearby landmarks and field-guide notes.</p><div class="prompt-chips"><button class="prompt-chip" data-prompt="What terrain should I expect?" type="button">What terrain should I expect?</button><button class="prompt-chip" data-prompt="How do I treat a bee sting?" type="button">How do I treat a bee sting?</button><button class="prompt-chip" data-prompt="What should I watch for near water?" type="button">What should I watch for near water?</button></div></div>`;
  } else {
    container.innerHTML = state.chat.map((message) => `<div class="message-row ${message.role === 'user' ? 'message-user' : 'message-assistant'}"><div class="message-bubble">${message.imageDataUrl ? `<img class="message-image" src="${message.imageDataUrl}" alt="User-submitted trail observation">` : ''}<p>${escapeHtml(message.text)}</p>${message.role === 'assistant' && message.inferenceSource ? `<span class="message-source ${message.inferenceSource === 'ON_DEVICE' ? 'source-device' : message.inferenceSource === 'IN_CLOUD' ? 'source-cloud' : ''}">${message.inferenceSource === 'ON_DEVICE' ? '⚡ On-device · Gemini Nano' : message.inferenceSource === 'IN_CLOUD' ? 'Cloud · Gemini' : 'Local field guide reference'}</span>` : ''}</div></div>`).join('');
  }
  if (state.assistantBusy) container.insertAdjacentHTML('beforeend', '<div class="thinking-row"><span class="thinking-dots"><i></i><i></i><i></i></span><span>Checking the trip context…</span></div>');
  container.scrollTop = container.scrollHeight;
  const send = $('#send-message') as HTMLButtonElement | null;
  if (send) send.disabled = state.assistantBusy;
}

function cachedReferenceAnswer(question: string) {
  const guide = currentGuide();
  if (!guide) return online()
    ? 'Trail could not reach Firebase AI Logic. Check Firebase configuration and App Check. The saved route and POIs remain available.'
    : 'This trip does not have a saved field guide, and local AI is not available. Your saved route and landmarks remain available. Do not rely on this app for emergency response.';
  const q = question.toLowerCase();
  const section = /injur|sting|bite|bleed|sprain|fracture|heat|cold|first aid|dehydrat/.test(q) ? guide.wildernessFirstAid
    : /plant|tree|flower|mushroom|fung|animal|wildlife|poison/.test(q) ? guide.floraAndFauna
      : /weather|rain|storm|tick|wind|ice|hazard/.test(q) ? guide.weatherAndHazards
        : guide.navigationAndTerrain;
  return `The local assistant is unavailable, so this is a field-guide excerpt rather than an AI response:\n\n${section.slice(0, 1800)}\n\n${SAFETY_ADVISORY}`;
}

async function sendAssistantMessage(question: string, image?: File) {
  const trip = currentTrip();
  if (!trip || state.assistantBusy) return;
  const text = question.trim() || 'Please describe the subject in this photo. Explain uncertainty and safety concerns.';
  let imageDataUrl: string | undefined;
  try { if (image) imageDataUrl = await fileAsDataUrl(image); } catch (error) { toast(errorMessage(error)); return; }
  const userMessage: ChatMessage = { id: crypto.randomUUID(), tripId: trip.id, role: 'user', text, createdAt: Date.now(), imageDataUrl };
  state.chat.push(userMessage);
  await saveChatMessage(userMessage);
  state.assistantBusy = true;
  renderChat();
  try {
    const result = await askTrailAssistant({ question: text, image, history: state.chat.slice(0, -1), trip, guide: currentGuide(), telemetry: currentTelemetry(), offline: !online() });
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), tripId: trip.id, role: 'assistant', text: result.text, createdAt: Date.now(), inferenceSource: result.inferenceSource };
    state.chat.push(assistantMessage);
    await saveChatMessage(assistantMessage);
  } catch (error) {
    const fallback: ChatMessage = { id: crypto.randomUUID(), tripId: trip.id, role: 'assistant', text: `${cachedReferenceAnswer(text)}\n\n${online() ? `AI error: ${errorMessage(error)}` : 'Local-only mode did not make a network request.'}`, createdAt: Date.now(), inferenceSource: 'LOCAL_REFERENCE' };
    state.chat.push(fallback);
    await saveChatMessage(fallback);
  } finally {
    state.assistantBusy = false;
    renderChat();
  }
}

async function refreshLocalModelCapability() {
  const capability = await getLocalModelCapability();
  state.localModelAvailable = capability.available;
  setStatus();
}

async function cacheBasemap() {
  const trip = currentTrip();
  if (!trip || !window.TRAIL_CONFIG?.mapStyleUrl || !online() || trip.isDemo) return;
  state.tilePackBusy = true;
  state.tilePackProgress = { stage: 'preparing', completed: 0, total: 0, message: 'Preparing offline map' };
  renderMainView();
  try {
    const labels = [trip.name, trip.startLabel, trip.endLabel, ...currentLandmarks().map((landmark) => landmark.name)];
    const result = await downloadOfflineTilePack(trip.id, trip.route, labels, (progress) => {
      state.tilePackProgress = progress;
      const panel = $('.map-download-progress');
      if (panel) {
        const heading = panel.querySelector('.map-download-progress-heading span');
        const value = panel.querySelector('.map-download-progress-heading strong');
        const bar = panel.querySelector('.offline-package-progress > span') as HTMLElement | null;
        const percent = progress.total ? Math.round(progress.completed / progress.total * 100) : 0;
        if (heading) heading.textContent = progress.message;
        if (value) value.textContent = `${percent}%`;
        if (bar) bar.style.width = `${percent}%`;
      }
    });
    const previous = state.mapPacks.find((item) => item.tripId === trip.id);
    try {
      await saveMapPack({
        tripId: result.tripId, cacheName: result.cacheName, styleUrl: result.styleUrl, createdAt: result.createdAt,
        tileCount: result.tileCount, resourceCount: result.resourceCount, requiredResourceUrls: result.requiredResourceUrls, sizeBytes: result.sizeBytes,
        minZoom: result.minZoom, maxZoom: result.maxZoom, bufferMeters: result.bufferMeters, persistentStorage: result.persistentStorage,
      });
    } catch (error) {
      await deleteOfflineTilePack(result.cacheName);
      throw error;
    }
    if (previous && previous.cacheName !== result.cacheName) await deleteOfflineTilePack(previous.cacheName);
    toast(`Offline map saved: ${result.tileCount.toLocaleString()} tiles and ${result.resourceCount.toLocaleString()} resources${result.failed ? ` · ${result.failed} optional assets unavailable` : ''}.`);
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    state.tilePackBusy = false;
    state.tilePackProgress = undefined;
    await refreshMapStorage();
    const updated = state.bundles.find((bundle) => bundle.trip.id === trip.id);
    if (updated) {
      const refreshed = await dbTripSnapshot(trip.id);
      if (refreshed) updated.trip = refreshed;
    }
    renderMainView();
  }
}

async function dbTripSnapshot(tripId: string) {
  return (await getTripBundle(tripId))?.trip;
}

async function removeMapPack(tripId: string) {
  const pack = state.mapPacks.find((item) => item.tripId === tripId);
  if (!pack || state.tilePackBusy) return;
  if (!window.confirm('Remove this downloaded map from this device? Your saved route, places and field guide will remain.')) return;
  state.tilePackBusy = true;
  renderMainView();
  try {
    await deleteOfflineTilePack(pack.cacheName);
    await removeMapPackRecord(tripId);
    toast('Offline map removed from this device.');
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    state.tilePackBusy = false;
    await refreshMapStorage();
    const refreshed = await dbTripSnapshot(tripId);
    const bundle = state.bundles.find((item) => item.trip.id === tripId);
    if (bundle && refreshed) bundle.trip = refreshed;
    renderMainView();
  }
}

async function switchTrip(id: string) {
  stopPlayback();
  stopDeviceGps();
  state.activeTripId = id;
  state.progress = 0.035;
  state.activeSection = 'trail';
  state.selectedLandmark = undefined;
  state.proximityAlert = undefined;
  state.alerted.clear();
  state.lastDistances = {};
  state.chat = await getTripChat(id);
  renderMainView();
  renderChat();
}

function setSection(section: 'trail' | 'guide') {
  state.activeSection = section;
  renderMainView();
}

function registerEvents() {
  document.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const section = target.closest<HTMLElement>('[data-section]')?.dataset.section;
    if (section === 'trail' || section === 'guide') { setSection(section); return; }
    const removePackId = target.closest<HTMLElement>('[data-remove-map-pack]')?.dataset.removeMapPack;
    if (removePackId) { void removeMapPack(removePackId); return; }
    const tripId = target.closest<HTMLElement>('[data-trip-id]')?.dataset.tripId;
    if (tripId) { await switchTrip(tripId); return; }
    const prompt = target.closest<HTMLElement>('[data-prompt]')?.dataset.prompt;
    if (prompt) { const input = $('#assistant-question') as HTMLInputElement | null; if (input) { input.value = prompt; input.focus(); } return; }
    const speed = target.closest<HTMLElement>('[data-speed]')?.dataset.speed;
    if (speed) { state.playbackSpeed = Number(speed) as 1 | 5 | 10; updatePlaybackButtons(); return; }
    const landmarkId = target.closest<HTMLElement>('[data-landmark-id]')?.dataset.landmarkId;
    if (landmarkId) { selectLandmark(landmarkId); return; }
    const guideToggle = target.closest<HTMLElement>('[data-guide-toggle]')?.dataset.guideToggle;
    if (guideToggle) {
      state.collapsedSections.has(guideToggle) ? state.collapsedSections.delete(guideToggle) : state.collapsedSections.add(guideToggle);
      renderMainView(); return;
    }
    switch (target.closest<HTMLElement>('[id]')?.id) {
      case 'new-trip': case 'sidebar-new-trip':
        state.activeSection = 'trail'; state.plannerOpen = true; state.compileMessage = ''; renderMainView(); $('#trip-name')?.focus(); break;
      case 'compile-guide': case 'compile-guide-inline': void handleCompileGuide(); break;
      case 'play-simulator': state.playing ? stopPlayback() : startPlayback(); break;
      case 'reset-simulator': stopPlayback(); state.progress = 0.035; state.alerted.clear(); state.lastDistances = {}; state.devicePosition = undefined; stopDeviceGps(); renderMainView(); break;
      case 'use-device-gps': toggleDeviceGps(); break;
      case 'cache-basemap': void cacheBasemap(); break;
      case 'remove-current-map-pack': { const trip = currentTrip(); if (trip) void removeMapPack(trip.id); break; }
      case 'dismiss-alert': state.proximityAlert = undefined; $('#proximity-container')!.innerHTML = ''; break;
      case 'close-landmark': state.selectedLandmark = undefined; $('#landmark-detail')!.innerHTML = ''; document.querySelectorAll('.landmark-row').forEach((row) => row.classList.remove('landmark-selected')); break;
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'planner-form') { event.preventDefault(); void handleCreateTrip(form); }
  });
  $('#assistant-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#assistant-question') as HTMLInputElement;
    const question = input.value;
    if (!question.trim() && !state.attachedImage) return;
    const image = state.attachedImage;
    input.value = '';
    state.attachedImage = undefined;
    state.attachedPreview = undefined;
    updateAttachment();
    void sendAssistantMessage(question, image);
  });
  $('#gpx-file')?.addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      toast(`GPX selected: ${file.name}. Start/end text fields become optional.`);
      const start = $('#trip-start') as HTMLInputElement | null;
      const end = $('#trip-end') as HTMLInputElement | null;
      if (start) start.required = false;
      if (end) end.required = false;
    } else {
      const start = $('#trip-start') as HTMLInputElement | null;
      const end = $('#trip-end') as HTMLInputElement | null;
      if (start) start.required = true;
      if (end) end.required = true;
    }
  });
  $('#assistant-image')?.addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) { toast('Attach a JPEG or PNG image.'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('Choose an image smaller than 8 MB.'); return; }
    state.attachedImage = file;
    updateAttachment();
  });
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'route-scrubber') {
      state.progress = Number((target as HTMLInputElement).value) / 100;
      stopPlayback(); state.devicePosition = undefined; updateTelemetryUI();
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'proximity-radius') {
      state.proximityRadiusM = Number((target as HTMLSelectElement).value);
      state.alerted.clear(); state.lastDistances = {}; updateTelemetryUI();
    }
  });
  $('#attach-photo')?.addEventListener('click', () => $('#assistant-image')?.click());
  $('#remove-image')?.addEventListener('click', () => { state.attachedImage = undefined; state.attachedPreview = undefined; const input = $('#assistant-image') as HTMLInputElement; input.value = ''; updateAttachment(); });
  window.addEventListener('online', () => { state.isOnline = true; setStatus(); });
  window.addEventListener('offline', () => { state.isOnline = false; setStatus(); stopPlayback(); });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    const installEvent = event as Event & { prompt?: () => Promise<void> };
    const button = $('#install-app');
    if (button) { button.hidden = false; button.addEventListener('click', () => void installEvent.prompt?.()); }
  });
}

function updateAttachment() {
  const chip = $('#attachment-chip');
  const label = $('#attachment-name');
  if (chip) chip.hidden = !state.attachedImage;
  if (label) label.textContent = state.attachedImage ? `Photo attached · ${state.attachedImage.name}` : '';
}


function applyDisplayPreferences() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const scale = document.documentElement.style.getPropertyValue('--font-scale') || '1';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', theme === 'dark' ? '#151c17' : '#f6f7f3');
  const select = $('#font-size-setting') as HTMLSelectElement | null;
  if (select) select.value = ['0.75', '1', '1.25'].includes(scale) ? scale : '1';
  const toggle = $('#theme-toggle');
  if (toggle) {
    const dark = theme === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    const label = toggle.querySelector('.theme-toggle-label');
    if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
    const icon = toggle.querySelector('.theme-toggle-icon');
    if (icon) icon.textContent = dark ? '☀' : '◐';
  }
}

function registerDisplayControls() {
  applyDisplayPreferences();
  $('#font-size-setting')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const scale = ['0.75', '1', '1.25'].includes(value) ? value : '1';
    document.documentElement.style.setProperty('--font-scale', scale);
    try { localStorage.setItem('trail-font-scale', scale); } catch { /* preferences remain active for this session */ }
  });
  $('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', next === 'dark' ? '#151c17' : '#f6f7f3');
    try { localStorage.setItem('trail-theme', next); } catch { /* preferences remain active for this session */ }
    applyDisplayPreferences();
  });
}

async function bootstrap() {
  try {
    state.config = await loadRuntimeConfig();
    initializeFirebase(state.config);
    const loaded = await listTripBundles();
    if (loaded.length) {
      state.bundles = loaded.map((bundle) => ({
        ...bundle,
        trip: { ...bundle.trip, readyForOffline: evaluateTripOfflineReadiness(bundle.trip, bundle.landmarks, bundle.guide).fullyReady },
      }));
      state.activeTripId = loaded[0].trip.id;
    } else {
      const seed = demoTrip();
      seed.readyForOffline = false;
      const landmarks = demoLandmarks(seed.id);
      await saveTripBundle(seed, landmarks);
      state.bundles = [{ trip: seed, landmarks }];
      state.activeTripId = seed.id;
    }
    await reconcileMapPacks();
    registerDisplayControls();
    registerEvents();
    state.chat = await getTripChat(state.activeTripId);
    renderMainView();
    renderChat();
    setStatus();
    await refreshLocalModelCapability();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((error) => console.warn('Service worker registration failed:', error));
    }
    const appCheckIssue = getAppCheckIssue();
    if (appCheckIssue && state.config.appCheckEnforced) toast(appCheckIssue);
  } catch (error) {
    const target = $('#main-view');
    if (target) target.innerHTML = `<div class="guide-empty-state"><span>!</span><h3>Trail could not start</h3><p>${escapeHtml(errorMessage(error))}</p></div>`;
  }
}

void bootstrap();
