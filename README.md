# Trail (v1.3.0)

Trail is an installable offline-first Progressive Web App. The frontend uses **vanilla HTML, TypeScript and CSS**. It does not use React, Tailwind CSS or Vite. TypeScript is bundled with esbuild; the application backend is Python FastAPI.

The app combines two distinct services in the supported way:

1. **FastAPI (Python backend):** compiles routes, elevation samples and nearby Google Places results using a server-only Google Maps API key; prepares validated guide context; serves the PWA; and verifies Firebase App Check tokens for its API endpoints.
2. **Firebase AI Logic (Firebase JavaScript SDK):** runs in the browser. It compiles the field guide through the Firebase AI Logic proxy using cloud Gemini and handles hybrid assistant prompts with on-device Gemini Nano where supported. It uses Firebase App Check. The Firebase AI Logic web SDK is a client SDK; there is no supported Firebase AI Logic Python SDK for FastAPI. Keeping it in the browser is also necessary for on-device inference.

The browser stores trips, route geometry, POIs, field guides and chat history in IndexedDB using Dexie. The service worker caches the app shell. MapLibre renders the saved route and POIs offline; a full offline basemap requires a tile provider that explicitly permits offline caching.

## Stack

- Frontend: semantic HTML5, TypeScript, plain CSS, esbuild
- Backend: Python 3.12, FastAPI, Uvicorn, HTTPX, Pydantic
- AI: Firebase AI Logic (`firebase/ai`) + Firebase App Check
- Mapping: Google Maps Routes API, Places API (New), Elevation API, MapLibre GL JS
- Local persistence: Dexie.js / IndexedDB
- PWA: Web App Manifest + Service Worker
- Deployment: Google Cloud Run (single container serving frontend and API)

## Requirements

- Node.js 22+
- Python 3.11+
- Firebase project with Firebase AI Logic enabled and a registered Web app
- Firebase App Check configured for the Web app
- Google Cloud project with Routes API, Places API (New) and Elevation API enabled
- Desktop Chrome 139+ with the Prompt API multimodal flag enabled for the on-device demo

## Local setup

```bash
cp .env.example .env
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\\Scripts\\activate
pip install -r backend/requirements.txt
npm install
npm run build
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

`npm run dev` performs the frontend build and starts the FastAPI server. Run `npm run build` after frontend changes. `npm run typecheck` runs TypeScript type checking.

## Environment configuration

Copy `.env.example` to `.env` and configure:

### FastAPI and Google Maps

- `GOOGLE_MAPS_SERVER_API_KEY`: server-side key used only by FastAPI for Routes, Places and Elevation. It is never returned by `/api/config` or shipped in the browser bundle. Restrict the key to the required APIs and the production server's network identity where available.
- `APP_CHECK_ENFORCED`: set to `false` for local development and `true` in production.
- `FIREBASE_PROJECT_ID`: used by Firebase Admin SDK when verifying App Check tokens.
- `GOOGLE_APPLICATION_CREDENTIALS`: optional local path to a service-account file. On Cloud Run, prefer the service identity / Application Default Credentials rather than a downloaded key file.
- `ALLOWED_ORIGINS`: relevant when the frontend and API are hosted on different origins. The provided single-service deployment is same-origin.

### Firebase Web app and AI Logic

- `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, and the optional Firebase messaging/storage/measurement values.
- `FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY`: public reCAPTCHA v3 site key used by the Firebase Web App Check provider. Configure the matching secret key/provider in Firebase Console.
- `FIREBASE_AI_MODEL`: cloud fallback model for Firebase AI Logic. The starter defaults to `gemini-3.5-flash-lite`; change it to a model enabled for your Firebase project's selected backend and region.
- `FIREBASE_AI_LOCATION`: Agent Platform location, default `global`.

The Firebase Web configuration and reCAPTCHA site key are public browser configuration. The Google Maps server API key and service-account credentials are secrets.

## How the combined AI/backend flow works

### Online trip preparation

1. The browser sends a trip request to `POST /api/trips/compile`.
2. FastAPI verifies the `X-Firebase-AppCheck` token when App Check enforcement is enabled.
3. FastAPI calls Google Routes, samples Elevation results and discovers nearby Places within approximately 500 metres of sampled route points.
4. The browser saves the returned route, landmarks and metadata to IndexedDB.
5. When the user compiles a field guide, the browser calls `POST /api/trips/guide-context`. FastAPI returns normalized route and POI context.
6. The browser sends that context to Firebase AI Logic using `PREFER_IN_CLOUD`. The generated four-section field guide is validated for the 2,000-word minimum and saved locally.

### Offline trail execution

- The Service Worker serves cached application assets and the cached public `/api/config` response.
- Dexie supplies the saved trip, landmarks, field guide and chat transcript without calling FastAPI.
- MapLibre draws the locally stored route and POIs. A GPS simulator or device geolocation updates the user marker and Haversine proximity engine.
- Firebase AI Logic uses `ONLY_ON_DEVICE` when the browser reports that it is offline. This prevents an offline request from silently falling back to cloud inference. For offline testing, use Chrome DevTools Network throttling or the operating system’s airplane mode; the application does not expose a simulated-offline control.
- When online, assistant requests use `PREFER_ON_DEVICE`; Firebase AI Logic can fall back to the configured cloud model if local inference is unavailable. The UI displays the returned `inferenceSource`.

Firebase AI Logic's current web on-device implementation has a narrower feature set than cloud inference. This build uses single-turn text or text-plus-JPEG/PNG prompts and includes the most recent local transcript in the prompt. On-device inference does not support native multi-turn chat sessions or every cloud-only feature. See the Firebase hybrid web documentation before changing prompt features.

## Google Maps setup

Enable Routes API, Places API (New) and Elevation API in the Google Cloud project. Put the API key in `GOOGLE_MAPS_SERVER_API_KEY` on the FastAPI server; do not put it in the TypeScript client configuration.

For a loop, the user enters a start and a turnaround waypoint. FastAPI requests a route from the start back to the start via that intermediate waypoint.

**Trail safety:** Google walking and cycling directions are not an authoritative hiking-trail dataset. They may follow roads, sidewalks or paths that are not maintained trails. Confirm route geometry, permissions, closures and hazards against official park/land-manager GPX or GIS data before use.

Without a Maps server key, the app creates a clearly labelled illustrative Wissahickon demo route. It exists for interface and offline workflow testing only and must not be used for navigation.


## Regional trail intelligence, GPX, weather and daylight (Phase 2)

### Authoritative trail datasets

FastAPI queries regional public trail GIS services only when the route falls within the provider's approximate geographic coverage. Results are matched against the complete route polyline and retained when the nearest line-to-line distance is 500 m or less. The backend returns source publisher, coverage, source link, licence link and check timestamp alongside each match. A nearby match is evidence of proximity only; it is not proof that the planned route itself is open, authorized, maintained or safe.

Included providers:

- **Ontario Trail Network (Canada):** OTN trail segments (ArcGIS layer 19) and access points (layer 20), published through Geospatial Ontario / the Ontario Ministry of Natural Resources. The catalogue identifies the Open Government Licence – Ontario. Coverage is provincial and partner-submitted; it is not an all-Canada trail dataset.
- **National Park Service Public Trails (United States):** NPS published trail features with names, use, surface, status, seasonal notes and public-access attributes, queried only for approximate U.S. coverage. Attribute availability varies by feature and park unit.
- **National Forest System Trails (United States):** USDA Forest Service National Forest System trail layer. Trail attributes are incomplete in some forests; the provider describes different publication subsets ranging from centerline-only to management attributes. The application does not infer missing access permissions.
- **Configured regional authority:** one optional ArcGIS Feature Layer per deployment. Configure an HTTPS layer URL and explicit publisher/licence metadata in the server environment. Its field names should expose common trail name, manager/owner, use and description attributes; unrecognized fields are ignored.

The providers above do **not** give North American-wide coverage. Routes outside their datasets should use a customer-provided GPX or a deployment-specific authoritative trail source. Do not present a missing result as evidence that no trail exists.

### GPX import and validation

The `/api/trips/compile-gpx` endpoint accepts GPX 1.0/1.1 XML, up to 2 MiB and 100,000 route/track points. It imports route/track geometry, track name, waypoint names/descriptions and available elevations. It rejects invalid WGS84 coordinates, XML document type/entity declarations, unusable tracks, and disconnected track segments with gaps greater than 50 m. The parser selects the route/track with the largest usable point count. GPX source licensing remains the responsibility of the user who supplies the file.

### Google Places along route

For Google-routed trips, FastAPI calls Places API (New) Search Text with `searchAlongRouteParameters.polyline.encodedPolyline`. The route bias is applied by Google, then every returned place is filtered again against the full route and discarded when it is more than 500 m away. Search Along Route does not guarantee an exhaustive directory of every trail facility or hazard. Imported GPX and provider-specific POIs are still checked independently.

### Forecast and daylight context

Weather is sampled at the route start, midpoint and finish. The trip stores per-sample temperature, precipitation probability and wind gust context, while hazard maxima and warnings are aggregated across the available samples. Open-Meteo daily/hourly forecast fields include weather code, temperature, precipitation, wind gusts, UV index and sunrise/sunset where the selected date is within the forecast window. If a forecast is unavailable, the trip carries a clear unavailable state and an astronomical sunrise/sunset estimate where possible. Forecasts are planning context, not official watches or warnings.

**Commercial licensing:** Open-Meteo's free public API is non-commercial only. It must not be used for this client's commercial service. For production, buy the commercial subscription and customer API key, use the customer endpoint, and set both `OPEN_METEO_API_KEY` and `OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED=true`. The confirmation flag is an explicit deployment assertion; setting it does not itself purchase a licence. Keep the data attribution link visible in the UI. Alternatively, integrate another weather provider under a suitable commercial licence.

`departureAt` from the browser is sent as an absolute UTC instant. FastAPI converts it to the IANA timezone returned for the route coordinates before selecting the forecast hour. Sunrise/sunset values are normalized with the route timezone, and the UI displays them in that timezone rather than the viewing device's timezone.

### Phase 2 environment variables

- `TRAIL_AUTHORITY_FEATURE_LAYER_URL`: optional HTTPS ArcGIS Feature Layer URL for one customer-approved regional source.
- `TRAIL_AUTHORITY_SOURCE_NAME`: publisher/source display name.
- `TRAIL_AUTHORITY_LICENSE_NAME`: human-readable licence/terms name returned with each match.
- `TRAIL_AUTHORITY_LICENSE_URL`: explicit source terms/licence page.
- `OPEN_METEO_API_KEY`: paid Open-Meteo customer API key.
- `OPEN_METEO_API_BASE_URL`: defaults to the paid customer endpoint when a key is set; set explicitly only for a licensed provider endpoint.
- `OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED`: set `true` only after the customer has confirmed the applicable commercial agreement.

## Offline basemaps and licensing

The saved route, POIs and GPS position render on an offline-safe local MapLibre schematic. A geographic street/topographic basemap is optional and must come from a tile provider that explicitly grants offline storage rights.

Configure:

- `MAP_STYLE_URL`: MapLibre-compatible style JSON URL.
- `OFFLINE_TILE_HOSTS`: comma-separated host allowlist covering the style, TileJSON, tiles, sprites and glyphs.

Use **Cache basemap** while online to download tiles intersecting the trip bounds at zoom levels 10–15, with a safety cap. The Service Worker checks Cache Storage for these previously saved tile URLs while offline. Do not cache public community tile services unless their licence and policies explicitly permit it.

## Firebase App Check security

- Enable App Check for Firebase AI Logic in Firebase Console.
- Configure a production Web attestation provider and enforce App Check for AI Logic.
- Set `APP_CHECK_ENFORCED=true` on FastAPI in production. Every FastAPI trip/guide-context POST then requires an `X-Firebase-AppCheck` token verified by the Firebase Admin Python SDK.
- The Admin SDK uses Application Default Credentials on Cloud Run. Grant the Cloud Run service account the permissions needed for App Check token verification.
- Keep the development setting `APP_CHECK_ENFORCED=false` local only. Do not deploy with the development bypass.

## Deploy to Google Cloud Run

Build the container from the project root:

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/trail:latest
```

Deploy it:

```bash
gcloud run deploy trail \\
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/trail:latest \\
  --region REGION \\
  --allow-unauthenticated \\
  --set-env-vars APP_ENV=production,APP_CHECK_ENFORCED=true,FIREBASE_PROJECT_ID=PROJECT_ID,FIREBASE_APP_ID=WEB_APP_ID,FIREBASE_API_KEY=WEB_API_KEY,FIREBASE_AUTH_DOMAIN=PROJECT_ID.firebaseapp.com,FIREBASE_AI_MODEL=gemini-3.5-flash-lite,FIREBASE_AI_LOCATION=global \\
  --set-secrets GOOGLE_MAPS_SERVER_API_KEY=trail-google-maps-key:latest,FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY=trail-appcheck-site-key:latest
```

Replace the sample identifiers with the correct project, region, App ID and secret names. Grant the Cloud Run runtime service account the required Firebase App Check verification and Secret Manager access. Use Secret Manager for private credentials; do not commit `.env` files or service-account JSON.

## Acceptance checks

1. Import a known GPX 1.0 and 1.1 track; verify track, waypoints, elevation and source attribution. Confirm malformed XML, entity declarations, invalid coordinates, over-limit files and disconnected tracks are rejected.
2. Validate an Ontario route against OTN layer 19/20 and a U.S. national forest/park route against the corresponding public trail sources; confirm out-of-coverage routes do not claim a match.
3. Confirm an official line whose midpoint crosses the route is matched by line-to-line distance, including a feature with distant endpoints. Confirm only matches at 500 m or less are included.
4. Confirm Places Search Along Route results are locally filtered to a maximum 500 m from the entire route.
5. Test a route in a timezone different from the browser's timezone; confirm planned departure is converted to the route's local hour and sunrise/sunset are displayed in the route timezone.
6. Confirm Open-Meteo's free endpoint displays a non-commercial warning; only a customer with a paid commercial subscription and explicit confirmation flag should clear it. Test forecast dates outside the 16-day window and provider failure.
7. Create a live trip with Google Maps configured; confirm the response contains a real encoded-route decode, elevations and nearby POIs.
8. Generate the field guide online; confirm its four required sections and 2,000+ total words are stored in IndexedDB.
9. Prepare Gemini Nano while online; verify the browser reports local model availability.
10. Install the PWA, then set DevTools Network to Offline and reload. The app shell, saved trip, guide, POIs and simulator should still load.
11. Play/scrub the route and confirm the 100-metre (configurable) POI proximity banner triggers.
12. Ask a text question and attach a JPEG/PNG photo offline. Confirm the response label reports `ON_DEVICE` only when Firebase AI Logic reports `inferenceSource: ON_DEVICE`.
13. Set Chrome DevTools Network to Offline or disable network connectivity. Assistant calls must not fall back to cloud; trip compilation and guide-context endpoints are not used offline.

## Safety and known limitations

- AI plant/fungi identification is uncertain. Never consume wild plants or fungi based on AI output.
- First-aid content is educational reference, not a diagnosis or emergency-response service. Call local emergency services for severe injuries or life-threatening conditions.
- No live weather provider, official trail closure feed, emergency dispatch or satellite SOS is included.
- The local map overlay is offline-safe; a full geographic basemap depends on a legally cacheable tile package.
- The demo route is illustrative only. Google walking/cycling geometry is not certified hiking-trail geometry.
- On-device Gemini Nano availability depends on supported Chrome versions, flags, model download and device resources. A 2-second latency target cannot be guaranteed across end-user hardware.


## Interface direction (1.3.0)

The application shell is local-first and intentionally minimal: the header displays the name Trail only, with no logo, eyebrow labels, connection badge, device-readiness drawer or offline-simulation control. Real network state and local model capability remain internal runtime signals. The PWA installation icons use the word Trail only.
