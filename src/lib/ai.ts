import { getGenerativeModel, InferenceMode } from 'firebase/ai';
import { getAIService } from './firebase';
import { apiPost } from './api';
import type { ActivityType, ChatMessage, Coordinate, FieldGuide, Landmark, Telemetry, Trip } from '../types';

const SAFETY_ADVISORY = 'For educational trail reference only. Never consume wild plants/fungi based solely on AI identification. Call local emergency services for severe injuries.';
const modelName = () => window.TRAIL_CONFIG?.aiModel || 'gemini-3.5-flash-lite';
const countWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Firebase AI Logic did not return valid field-guide JSON. Try again.');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

const asString = (value: unknown) => typeof value === 'string' ? value : '';

export async function compileFieldGuide(input: { trip: Trip; landmarks: Landmark[]; season: string }): Promise<FieldGuide> {
  const context = await apiPost<Record<string, unknown>>('/api/trips/guide-context', {
    trip: input.trip,
    landmarks: input.landmarks,
    season: input.season,
  });
  const model = getGenerativeModel(getAIService(), {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: {
      model: modelName(),
      generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json', temperature: 0.35 },
    },
  });

  const prompt = `You are a careful North American outdoor field-guide editor. Create a route-specific offline field guide. Return ONLY valid JSON with exact string keys: floraAndFauna, navigationAndTerrain, weatherAndHazards, wildernessFirstAid, markdown.

VERIFIED TRIP CONTEXT FROM FASTAPI
${JSON.stringify(context, null, 2)}

CONTENT REQUIREMENTS
- Write 2,300–2,900 useful words across the four sections (not counting headings). Avoid filler.
- floraAndFauna: regional habitat and likely groups, seasonal observations, toxic species and lookalikes where geographically plausible, and explicit non-consumption advice. Never claim species presence at an exact location without a verified observation.
- navigationAndTerrain: route reading, terrain, footwear, water crossings, ravines, slopes, pacing, navigation checks and bail-out planning. Separate verified POIs from general guidance.
- weatherAndHazards: seasonal microclimate, heat/cold/lightning/wind/ice/flash-flood risks, daylight, water planning, ticks and insects. Use the forecast and daylight context supplied in the FastAPI trip metadata only for its stated date and route sample points. Label it as model guidance, not an official warning. If forecastAvailable is false or the departure date is outside the forecast window, say so and do not invent weather. No current closures are supplied; direct users to official park/land-manager notices.
- wildernessFirstAid: practical immediate steps for sprains, blisters, heat exhaustion, heat stroke, hypothermia, bleeding, allergic reactions/bee stings, tick bites, dehydration and suspected fractures. Distinguish first aid from diagnosis, identify red flags and advise emergency services when indicated.
- Use the dataSources and source metadata supplied in the context when describing the origin of route, trail-network, POI or forecast information. Do not invent research, citations, legal rules, phone numbers, facilities, water availability, trail closures or current conditions. Flag uncertainty explicitly.
- Include a compact pre-trip checklist in markdown.
- This is educational trail reference, not medical diagnosis or emergency dispatch.
- ${SAFETY_ADVISORY}`;

  const result = await model.generateContent(prompt);
  const data = parseJsonObject(result.response.text());
  const sections = {
    floraAndFauna: asString(data.floraAndFauna),
    navigationAndTerrain: asString(data.navigationAndTerrain),
    weatherAndHazards: asString(data.weatherAndHazards),
    wildernessFirstAid: asString(data.wildernessFirstAid),
    markdown: asString(data.markdown),
  };
  const wordCount = countWords([sections.floraAndFauna, sections.navigationAndTerrain, sections.weatherAndHazards, sections.wildernessFirstAid].join('\n'));
  const missing = Object.entries(sections).filter(([key, value]) => key !== 'markdown' && value.length < 120).map(([key]) => key);
  if (missing.length) throw new Error(`The field guide is incomplete (${missing.join(', ')}). Generate it again.`);
  if (wordCount < 2000) throw new Error(`The guide currently contains ${wordCount.toLocaleString()} words. The offline-ready target is at least 2,000. Regenerate it.`);

  return {
    id: crypto.randomUUID(), tripId: input.trip.id, createdAt: Date.now(), wordCount,
    ...sections, source: 'firebase-cloud',
  };
}

function sectionsForQuestion(question: string, guide?: FieldGuide) {
  if (!guide) return '';
  const q = question.toLowerCase();
  const selected = new Set<keyof Pick<FieldGuide, 'floraAndFauna' | 'navigationAndTerrain' | 'weatherAndHazards' | 'wildernessFirstAid'>>();
  if (/plant|flower|tree|mushroom|fung|animal|wildlife|bird|snake|berry|forag|poison|toxic/.test(q)) selected.add('floraAndFauna');
  if (/map|route|lost|navigate|trail|terrain|steep|river|crossing|distance|elevation|landmark/.test(q)) selected.add('navigationAndTerrain');
  if (/weather|rain|storm|lightning|heat|cold|wind|ice|tick|insect|mosquito|flood/.test(q)) selected.add('weatherAndHazards');
  if (/injur|first aid|sting|bite|bleed|sprain|fracture|broken|hypothermia|heat stroke|dehydrat|blister|allerg|emergency/.test(q)) selected.add('wildernessFirstAid');
  if (!selected.size) { selected.add('navigationAndTerrain'); selected.add('weatherAndHazards'); }
  return [...selected].map((key) => `${key}:\n${guide[key].slice(0, 4200)}`).join('\n\n').slice(0, 8000);
}

function telemetryContext(telemetry: Telemetry, activity: ActivityType) {
  const nearest = telemetry.nearestLandmark;
  return [
    `Current GPS: ${telemetry.position.lat.toFixed(5)}, ${telemetry.position.lng.toFixed(5)}`,
    nearest ? `Nearest landmark: ${nearest.name}, ${Math.round(telemetry.nearestLandmarkDistanceM ?? 0)} m away. ${nearest.description}` : 'Nearest landmark: none in the saved POI list',
    `Elevation: ${Math.round(telemetry.elevationM)} m (may be simulated or estimated)`,
    `Activity: ${activity}`,
  ].join('\n');
}

async function fileToInlineImage(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('On-device image prompts support JPEG and PNG photos only.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose an image smaller than 8 MB.');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { inlineData: { data: btoa(binary), mimeType: file.type }, type: 'inlineData' as const };
}

export async function askTrailAssistant(input: {
  question: string;
  image?: File;
  history: ChatMessage[];
  trip: Trip;
  guide?: FieldGuide;
  telemetry: Telemetry;
  offline: boolean;
}): Promise<{ text: string; inferenceSource: 'ON_DEVICE' | 'IN_CLOUD' | undefined }> {
  const mode = input.offline ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE;
  const model = getGenerativeModel(getAIService(), {
    mode,
    inCloudParams: { model: modelName(), generationConfig: { maxOutputTokens: 900, temperature: 0.25 } },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
    },
  });
  const recent = input.history.slice(-6).map((message) => `${message.role === 'user' ? 'Hiker' : 'Trail Assistant'}: ${message.text}`).join('\n');
  const prompt = `You are Trail Assistant, a conservative offline field companion. Answer using the trip facts and cached guide excerpts below. Never invent current weather, trail closures, water sources, facilities or confirmed species observations. If the hiker is lost, seriously injured, exposed to severe weather or reports life-threatening symptoms, prioritize immediate safety and contacting local emergency services. For plant/fungi images, state uncertainty clearly and tell the user not to eat the subject based on AI identification.

SAFETY ADVISORY: ${SAFETY_ADVISORY}

TRIP: ${input.trip.name}; activity: ${input.trip.activity}; difficulty: ${input.trip.difficulty}; distance: ${(input.trip.distanceMeters / 1000).toFixed(1)} km
SPATIAL TELEMETRY
${telemetryContext(input.telemetry, input.trip.activity)}

RELEVANT CACHED GUIDE EXCERPTS
${sectionsForQuestion(input.question, input.guide) || 'No relevant field-guide section is cached.'}

RECENT CONVERSATION
${recent || 'No previous messages.'}

LATEST QUESTION
${input.question}

Respond in 2–6 short paragraphs. Give immediate safety steps first. Include the safety advisory when discussing identification or first aid.`;
  const parts: Array<string | { inlineData: { data: string; mimeType: string }; type: 'inlineData' }> = [prompt];
  if (input.image) parts.push(await fileToInlineImage(input.image));
  const result = await model.generateContent(parts);
  const text = result.response.text();
  if (!text.trim()) throw new Error('Trail Assistant returned an empty response.');
  return { text, inferenceSource: result.response.inferenceSource as 'ON_DEVICE' | 'IN_CLOUD' | undefined };
}

export async function getLocalModelCapability() {
  if (!('LanguageModel' in window) || !window.LanguageModel) return { available: false, status: 'unsupported' as const };
  try {
    const status = await window.LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    return { available: status === 'available', status };
  } catch {
    return { available: false, status: 'unavailable' as const };
  }
}

export async function downloadOnDeviceModel(onProgress?: (percent: number) => void) {
  const model = getGenerativeModel(getAIService(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
    },
  });
  await model.initializeDeviceModel((progress: number) => onProgress?.(Math.round(progress * 100)));
}
