export type ActivityType = 'hiking' | 'trail-running' | 'cycling';
export type Difficulty = 'easy' | 'moderate' | 'strenuous';

export interface Coordinate {
  lat: number;
  lng: number;
  altitude?: number;
}

export interface Landmark {
  id: string;
  tripId: string;
  name: string;
  category: 'viewpoint' | 'trailhead' | 'water' | 'hazard' | 'landmark' | 'facility';
  description: string;
  position: Coordinate;
  source: 'google-places' | 'curated-demo' | 'ontario-trail-network' | 'gpx-import';
  distanceFromRouteM?: number;
  url?: string;
}

export interface FieldGuide {
  id: string;
  tripId: string;
  createdAt: number;
  wordCount: number;
  floraAndFauna: string;
  navigationAndTerrain: string;
  weatherAndHazards: string;
  wildernessFirstAid: string;
  markdown: string;
  source: 'firebase-cloud' | 'demo-reference';
}

export interface TrailMatch {
  id: string;
  name: string;
  association?: string;
  associationWebsite?: string;
  permittedUses?: string;
  status?: string;
  surface?: string;
  description?: string;
  lengthKm?: number | null;
  locationAccuracy?: string;
  distanceFromRouteM: number;
  geometry: Coordinate[][];
  source: string;
}

export interface TripDataSource {
  id: string;
  name: string;
  publisher: string;
  url: string;
  license: string;
  licenseUrl?: string;
  coverage: string;
  checkedAt?: string;
  note?: string;
  segmentCount?: number;
  accessPointCount?: number;
  commercialLicenseConfigured?: boolean;
}

export interface TrailConditions {
  provider: string;
  forecastAvailable: boolean;
  commercialLicenseConfigured?: boolean;
  forecastDate?: string;
  departureLocalTime?: string;
  timezone?: string;
  temperatureC?: number | null;
  apparentTemperatureC?: number | null;
  precipitationProbability?: number | null;
  precipitationMm?: number | null;
  windKmh?: number | null;
  windGustKmh?: number | null;
  visibilityM?: number | null;
  uvIndex?: number | null;
  weatherCode?: number | null;
  routeSamples?: Array<{ label: string; position?: Coordinate; temperatureC?: number | null; precipitationProbabilityMax?: number | null; windGustMaxKmh?: number | null; weatherCode?: number | null; forecastAvailable: boolean; timezone?: string }>;
  routeCoverage?: string;
  temperatureMaxC?: number | null;
  temperatureMinC?: number | null;
  apparentTemperatureMaxC?: number | null;
  precipitationProbabilityMax?: number | null;
  precipitationSumMm?: number | null;
  snowfallSumCm?: number | null;
  windGustMaxKmh?: number | null;
  uvIndexMax?: number | null;
  sunrise?: string | null;
  sunset?: string | null;
  daylightMinutes?: number | null;
  planningNotes?: string[];
  note?: string;
  forecastError?: string;
  fetchedAt?: string;
  solarStatus?: string;
  method?: string;
  forecastWindow?: { start?: string | null; end?: string | null };
}

export interface Trip {
  id: string;
  name: string;
  startLabel: string;
  endLabel: string;
  activity: ActivityType;
  difficulty: Difficulty;
  route: Coordinate[];
  distanceMeters: number;
  durationMinutes: number;
  elevationGainM: number;
  createdAt: number;
  updatedAt: number;
  isDemo: boolean;
  readyForOffline: boolean;
  mapStyleUrl?: string;
  routeSource?: 'google-routes' | 'gpx-import' | string;
  gpxFilename?: string;
  gpxTrackName?: string;
  gpxPointCount?: number;
  departureAt?: string;
  officialTrailMatches?: TrailMatch[];
  conditions?: TrailConditions;
  dataSources?: TripDataSource[];
}

export interface ChatMessage {
  id: string;
  tripId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  inferenceSource?: 'ON_DEVICE' | 'IN_CLOUD' | 'LOCAL_REFERENCE';
  imageDataUrl?: string;
}

export interface Telemetry {
  position: Coordinate;
  elevationM: number;
  speedKmh: number;
  accuracyM: number;
  routeProgress: number;
  nearestLandmark?: Landmark;
  nearestLandmarkDistanceM?: number;
}

export interface TripBundle {
  trip: Trip;
  landmarks: Landmark[];
  guide?: FieldGuide;
}
