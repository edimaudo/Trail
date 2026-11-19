declare module 'maplibre-gl' {
  export type GeoJSONSource = any;
  export type Map = any;
  export const Map: any;
  export const LngLatBounds: any;
  export const NavigationControl: any;
}

declare module 'dexie' {
  export type EntityTable<T, Key extends keyof T> = any;
  export default class Dexie {
    constructor(databaseName: string);
    version(version: number): { stores(value: Record<string, string>): { upgrade(callback: (transaction: { table(name: string): any }) => Promise<void>): any }; };
    transaction(...args: any[]): Promise<any>;
  }
}

declare module 'firebase/app' {
  export interface FirebaseApp { [key: string]: any; }
  export function getApps(): FirebaseApp[];
  export function initializeApp(options: Record<string, unknown>): FirebaseApp;
}

declare module 'firebase/app-check' {
  import type { FirebaseApp } from 'firebase/app';
  export interface AppCheck { [key: string]: any; }
  export class ReCaptchaV3Provider { constructor(siteKey: string); }
  export function initializeAppCheck(app: FirebaseApp, options: Record<string, unknown>): AppCheck;
  export function getToken(appCheck: AppCheck, forceRefresh: boolean): Promise<{ token: string }>;
}

declare module 'firebase/ai' {
  import type { FirebaseApp } from 'firebase/app';
  export interface AI { [key: string]: any; }
  export class AgentPlatformBackend { constructor(location?: string); }
  export const InferenceMode: {
    ONLY_IN_CLOUD: unknown;
    PREFER_ON_DEVICE: unknown;
    ONLY_ON_DEVICE: unknown;
    PREFER_IN_CLOUD: unknown;
  };
  export function getAI(app: FirebaseApp, options: Record<string, unknown>): AI;
  export function getGenerativeModel(ai: AI, options: Record<string, unknown>): {
    generateContent(parts: unknown): Promise<{ response: { text(): string; inferenceSource?: string } }>;
    initializeDeviceModel(progress?: (fraction: number) => void): Promise<void>;
  };
}


declare namespace GeoJSON {
  interface FeatureCollection { type: 'FeatureCollection'; features: any[]; }
}
