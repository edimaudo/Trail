import Dexie, { type EntityTable } from 'dexie';
import type { ChatMessage, FieldGuide, Landmark, MapPackMetadata, Trip } from '../types.js';

class TrailDatabase extends Dexie {
  trips!: EntityTable<Trip, 'id'>;
  landmarks!: EntityTable<Landmark, 'id'>;
  knowledgeBases!: EntityTable<FieldGuide, 'id'>;
  chatHistory!: EntityTable<ChatMessage, 'id'>;
  mapPacks!: EntityTable<MapPackMetadata, 'tripId'>;

  constructor() {
    super('trail-local-v1');
    const stores = {
      trips: 'id, updatedAt, readyForOffline',
      landmarks: 'id, tripId, category',
      knowledgeBases: 'id, tripId, createdAt',
      chatHistory: 'id, tripId, createdAt'
    };
    this.version(1).stores(stores);
    this.version(2).stores(stores).upgrade(async (transaction) => {
      // Older builds marked a trip ready as soon as a 2,000-word guide existed.
      // Clear that optimistic flag; current readiness is derived from every saved resource.
      await transaction.table('trips').toCollection().modify((trip: Trip) => {
        trip.readyForOffline = false;
      });
    });
    this.version(3).stores({ ...stores, mapPacks: 'tripId, createdAt' });
  }
}

export const db = new TrailDatabase();

export async function saveTripBundle(trip: Trip, landmarks: Landmark[], guide?: FieldGuide) {
  await db.transaction('rw', db.trips, db.landmarks, db.knowledgeBases, async () => {
    await db.trips.put(trip);
    await db.landmarks.where('tripId').equals(trip.id).delete();
    if (landmarks.length) await db.landmarks.bulkPut(landmarks);
    if (guide) await db.knowledgeBases.put(guide);
  });
}

export async function getTripBundle(tripId: string) {
  const [trip, landmarks, guide] = await Promise.all([
    db.trips.get(tripId),
    db.landmarks.where('tripId').equals(tripId).toArray(),
    db.knowledgeBases.where('tripId').equals(tripId).last()
  ]);
  if (!trip) return undefined;
  return { trip, landmarks, guide };
}

export async function listTripBundles() {
  const trips = await db.trips.orderBy('updatedAt').reverse().toArray();
  return Promise.all(trips.map(async (trip: Trip) => {
    const [landmarks, guide] = await Promise.all([
      db.landmarks.where('tripId').equals(trip.id).toArray(),
      db.knowledgeBases.where('tripId').equals(trip.id).last()
    ]);
    return { trip, landmarks, guide };
  }));
}

export async function saveChatMessage(message: ChatMessage) {
  await db.chatHistory.put(message);
}

export async function getTripChat(tripId: string) {
  return db.chatHistory.where('tripId').equals(tripId).sortBy('createdAt');
}

export async function listMapPacks() {
  return db.mapPacks.orderBy('createdAt').reverse().toArray();
}

export async function getMapPack(tripId: string) {
  return db.mapPacks.get(tripId);
}

export async function saveMapPack(pack: MapPackMetadata) {
  await db.transaction('rw', db.mapPacks, db.trips, async () => {
    await db.mapPacks.put(pack);
    const trip = await db.trips.get(pack.tripId);
    if (trip) {
      trip.offlineSnapshot = {
        ...trip.offlineSnapshot,
        capturedAt: trip.offlineSnapshot?.capturedAt ?? new Date().toISOString(),
        routeGeometryCaptured: trip.offlineSnapshot?.routeGeometryCaptured ?? true,
        pointsOfInterestResolved: trip.offlineSnapshot?.pointsOfInterestResolved ?? false,
        trailNetworkChecked: trip.offlineSnapshot?.trailNetworkChecked ?? false,
        environmentalContextCaptured: trip.offlineSnapshot?.environmentalContextCaptured ?? false,
        sourceAttributionSaved: trip.offlineSnapshot?.sourceAttributionSaved ?? false,
        mapPackReady: pack.tileCount > 0 && pack.resourceCount > 0,
        mapPackTileCount: pack.tileCount,
      };
      trip.updatedAt = Date.now();
      await db.trips.put(trip);
    }
  });
}

export async function removeMapPackRecord(tripId: string) {
  await db.transaction('rw', db.mapPacks, db.trips, async () => {
    await db.mapPacks.delete(tripId);
    const trip = await db.trips.get(tripId);
    if (trip?.offlineSnapshot) {
      trip.offlineSnapshot.mapPackReady = false;
      trip.offlineSnapshot.mapPackTileCount = 0;
      trip.updatedAt = Date.now();
      await db.trips.put(trip);
    }
  });
}
