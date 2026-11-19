import type { FieldGuide, Landmark, Trip } from '../types.js';

export interface OfflineResourceCheck {
  key: string;
  label: string;
  ready: boolean;
  detail: string;
  core: boolean;
}

export interface TripOfflineReadiness {
  items: OfflineResourceCheck[];
  completedCount: number;
  totalCount: number;
  coreCompletedCount: number;
  coreTotalCount: number;
  tripDataReady: boolean;
  fullyReady: boolean;
}

function validRoute(route: Trip['route']) {
  return route.length >= 2 && route.every((point) =>
    Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180
  );
}

function validGuide(guide: FieldGuide | undefined, tripId: string) {
  return Boolean(
    guide && guide.tripId === tripId && guide.wordCount >= 2000 &&
    guide.floraAndFauna.trim().length > 0 &&
    guide.navigationAndTerrain.trim().length > 0 &&
    guide.weatherAndHazards.trim().length > 0 &&
    guide.wildernessFirstAid.trim().length > 0
  );
}

export function evaluateTripOfflineReadiness(
  trip: Trip,
  landmarks: Landmark[],
  guide?: FieldGuide
): TripOfflineReadiness {
  const snapshot = trip.offlineSnapshot;
  const routeSaved = !trip.isDemo && validRoute(trip.route) && snapshot?.routeGeometryCaptured === true;
  const metadataSaved = Boolean(trip.id && trip.name && trip.activity && trip.difficulty && trip.startLabel && trip.endLabel);
  const poiSaved = snapshot?.pointsOfInterestResolved === true && Array.isArray(landmarks);
  const poiStatus = snapshot?.pointOfInterestSearchStatus ?? 'unknown';
  const elevationSaved = (trip.elevationProfile?.length ?? 0) >= 2;
  const trailChecked = snapshot?.trailNetworkChecked === true && Array.isArray(trip.officialTrailMatches);
  const trailStatus = snapshot?.trailNetworkCheckStatus ?? 'unavailable';
  const environmentSaved = snapshot?.environmentalContextCaptured === true && Boolean(trip.conditions);
  const sourcesSaved = snapshot?.sourceAttributionSaved === true && (trip.dataSources?.length ?? 0) > 0;
  const guideSaved = validGuide(guide, trip.id);
  const mapPackSaved = snapshot?.mapPackReady === true && (snapshot.mapPackTileCount ?? 0) > 0;

  const items: OfflineResourceCheck[] = [
    { key: 'trip', label: 'Trip details', ready: metadataSaved, detail: metadataSaved ? `${trip.activity.replace('-', ' ')} · ${trip.difficulty}` : 'Trip details are incomplete.', core: true },
    { key: 'route', label: 'Route geometry', ready: routeSaved, detail: routeSaved ? `${trip.route.length.toLocaleString()} route points saved` : trip.isDemo ? 'Demo geometry is not a navigable route.' : 'A validated route is not saved.', core: true },
    { key: 'elevation', label: 'Elevation profile', ready: elevationSaved, detail: elevationSaved ? `${trip.elevationProfile!.length.toLocaleString()} elevation samples saved` : 'Elevation profile is unavailable for this route.', core: true },
    { key: 'places', label: 'Nearby places and waypoints', ready: poiSaved, detail: poiSaved ? `${landmarks.length.toLocaleString()} places or waypoints saved` : poiStatus === 'partial' ? 'Only part of the Places search completed. Retry to confirm all route areas.' : poiStatus === 'not-configured' ? 'Configure Google Places to search and save nearby places.' : poiStatus === 'unavailable' ? 'The Places search was unavailable. Retry the trip preparation.' : 'The route place search has not been completed.', core: true },
    { key: 'trails', label: 'Regional trail references', ready: trailChecked, detail: trailChecked ? `${trip.officialTrailMatches?.length ?? 0} nearby trail matches; regional coverage may vary` : trailStatus === 'partial' ? 'Only part of the regional trail-data search completed. Retry trip preparation.' : trailStatus === 'unavailable' ? 'Regional trail providers did not respond. Retry trip preparation.' : trailStatus === 'no-coverage' ? 'No supported regional trail dataset covers this route. Confirm with the local land manager.' : 'The regional trail-data check is not recorded.', core: true },
    { key: 'conditions', label: 'Weather and daylight snapshot', ready: environmentSaved, detail: environmentSaved ? (trip.conditions?.forecastAvailable ? 'Forecast and daylight context saved' : 'Snapshot saved; forecast unavailable for the selected date') : 'No environmental snapshot is saved.', core: true },
    { key: 'sources', label: 'Source and licence notes', ready: sourcesSaved, detail: sourcesSaved ? `${trip.dataSources!.length.toLocaleString()} source records saved` : 'Source attribution is missing.', core: true },
    { key: 'guide', label: 'Trail field guide', ready: guideSaved, detail: guideSaved ? `${guide!.wordCount.toLocaleString()} words saved` : guide ? `${guide.wordCount.toLocaleString()} words saved; at least 2,000 are required` : 'The field guide has not been saved.', core: true },
    { key: 'map', label: 'Offline map tiles', ready: mapPackSaved, detail: mapPackSaved ? `${snapshot!.mapPackTileCount!.toLocaleString()} map tiles saved` : 'A licensed basemap pack has not been saved.', core: false },
  ];

  const coreItems = items.filter((item) => item.core);
  const completedCount = items.filter((item) => item.ready).length;
  const coreCompletedCount = coreItems.filter((item) => item.ready).length;
  return {
    items,
    completedCount,
    totalCount: items.length,
    coreCompletedCount,
    coreTotalCount: coreItems.length,
    tripDataReady: coreCompletedCount === coreItems.length,
    fullyReady: completedCount === items.length,
  };
}
