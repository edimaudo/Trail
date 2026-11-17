import type { Coordinate, Landmark, Telemetry, Trip } from '../types';

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(a: Coordinate, b: Coordinate) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(value));
}

export function pointAtProgress(route: Coordinate[], progress: number): Coordinate {
  if (!route.length) return { lat: 0, lng: 0 };
  if (route.length === 1) return route[0];
  const lengths = route.slice(1).map((point, index) => haversineMeters(route[index], point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = Math.max(0, Math.min(1, progress)) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const ratio = lengths[i] === 0 ? 0 : remaining / lengths[i];
      const from = route[i];
      const to = route[i + 1];
      return {
        lat: from.lat + (to.lat - from.lat) * ratio,
        lng: from.lng + (to.lng - from.lng) * ratio,
        altitude: from.altitude !== undefined && to.altitude !== undefined
          ? from.altitude + (to.altitude - from.altitude) * ratio
          : undefined
      };
    }
    remaining -= lengths[i];
  }
  return route[route.length - 1];
}

export function nearestLandmark(position: Coordinate, landmarks: Landmark[]) {
  if (!landmarks.length) return undefined;
  return landmarks
    .map((landmark) => ({ landmark, distance: haversineMeters(position, landmark.position) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

export function buildTelemetry(trip: Trip, landmarks: Landmark[], progress: number, positionOverride?: Coordinate, accuracyM = 7, speedMultiplier = 1, speedOverride?: number): Telemetry {
  const position = positionOverride ?? pointAtProgress(trip.route, progress);
  const nearest = nearestLandmark(position, landmarks);
  const fallbackElevation = position.altitude ?? 110 + Math.round(Math.sin(progress * Math.PI * 3) * 18);
  return {
    position,
    elevationM: position.altitude ?? fallbackElevation,
    speedKmh: Math.max(0, speedOverride ?? (trip.activity === 'trail-running' ? 8.4 : trip.activity === 'cycling' ? 15.5 : 4.3) * speedMultiplier * (0.9 + 0.13 * Math.sin(progress * Math.PI * 8))),
    accuracyM,
    routeProgress: progress,
    nearestLandmark: nearest?.landmark,
    nearestLandmarkDistanceM: nearest?.distance
  };
}

export function makeDemoRoute(): Coordinate[] {
  const points: Coordinate[] = [];
  const start = { lat: 40.0505, lng: -75.2168 };
  const end = { lat: 40.0650, lng: -75.2135 };
  for (let i = 0; i <= 30; i += 1) {
    const t = i / 30;
    points.push({
      lat: start.lat + (end.lat - start.lat) * t + Math.sin(t * Math.PI * 4) * 0.00024,
      lng: start.lng + (end.lng - start.lng) * t + Math.sin(t * Math.PI * 3) * 0.00034,
      altitude: 95 + Math.sin(t * Math.PI * 2) * 24 + t * 9
    });
  }
  return points;
}

export function demoTrip(): Trip {
  const route = makeDemoRoute();
  return {
    id: 'demo-wissahickon',
    name: 'Wissahickon Valley · Devil’s Pool approach',
    startLabel: 'Valley Green Inn, Philadelphia',
    endLabel: 'Devil’s Pool, Philadelphia',
    activity: 'hiking',
    difficulty: 'moderate',
    route,
    distanceMeters: 2450,
    durationMinutes: 48,
    elevationGainM: 74,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isDemo: true,
    readyForOffline: false
  };
}

export function demoLandmarks(tripId = 'demo-wissahickon'): Landmark[] {
  return [
    {
      id: `${tripId}-valley-green`, tripId, name: 'Valley Green Inn', category: 'facility',
      description: 'Historic inn and familiar access point near Forbidden Drive. Confirm current access and services before relying on facilities.',
      position: { lat: 40.05055, lng: -75.21682 }, source: 'curated-demo'
    },
    {
      id: `${tripId}-covered-bridge`, tripId, name: 'Thomas Mill Covered Bridge', category: 'landmark',
      description: 'Historic covered bridge in the Wissahickon Valley. Watch for other trail users and keep clear of the roadway.',
      position: { lat: 40.0545, lng: -75.2162 }, source: 'curated-demo'
    },
    {
      id: `${tripId}-devils-pool`, tripId, name: 'Devil’s Pool', category: 'hazard',
      description: 'Rocky streamside area. Wet rock can be slippery; avoid entering fast or high water and stay back from ledges.',
      position: { lat: 40.0649, lng: -75.2135 }, source: 'curated-demo'
    }
  ];
}

export function routeDistance(route: Coordinate[]) {
  return route.slice(1).reduce((sum, point, index) => sum + haversineMeters(route[index], point), 0);
}

export function addGpsDrift(point: Coordinate, amplitudeM = 4): Coordinate {
  const latOffset = (Math.random() - 0.5) * 2 * amplitudeM / 111_320;
  const lngScale = Math.max(0.2, Math.cos(point.lat * Math.PI / 180));
  const lngOffset = (Math.random() - 0.5) * 2 * amplitudeM / (111_320 * lngScale);
  return { ...point, lat: point.lat + latOffset, lng: point.lng + lngOffset };
}
