export interface TrailRuntimeConfig {
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
    messagingSenderId: string;
    storageBucket: string;
    measurementId: string;
  };
  appCheckSiteKey: string;
  appCheckEnforced: boolean;
  firebaseConfigured: boolean;
  mapsConfigured: boolean;
  aiModel: string;
  aiLocation: string;
  mapStyleUrl: string;
  offlineTileHosts: string;
  offlineTileDownloadsEnabled: boolean;
}

declare global {
  interface Window {
    TRAIL_CONFIG: TrailRuntimeConfig;
  }
}

export async function loadRuntimeConfig(): Promise<TrailRuntimeConfig> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Trail could not load its public application configuration from FastAPI.');
  const config = await response.json() as TrailRuntimeConfig;
  window.TRAIL_CONFIG = config;
  return config;
}
