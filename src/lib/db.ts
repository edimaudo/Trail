import Dexie, { type EntityTable } from 'dexie';
import type { ChatMessage, FieldGuide, Landmark, Trip } from '../types';

class TrailDatabase extends Dexie {
  trips!: EntityTable<Trip, 'id'>;
  landmarks!: EntityTable<Landmark, 'id'>;
  knowledgeBases!: EntityTable<FieldGuide, 'id'>;
  chatHistory!: EntityTable<ChatMessage, 'id'>;

  constructor() {
    super('trail-local-v1');
    this.version(1).stores({
      trips: 'id, updatedAt, readyForOffline',
      landmarks: 'id, tripId, category',
      knowledgeBases: 'id, tripId, createdAt',
      chatHistory: 'id, tripId, createdAt'
    });
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
