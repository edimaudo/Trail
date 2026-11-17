# Trail v1.3.0 — Phase 2 and local-first interface validation

Validation date: 15 November 2026

## Interface changes in v1.3.0

- The header displays the name **Trail** only. No logo, monogram, tagline or duplicate brand footer is shown in the application interface.
- All section eyebrow/kicker labels have been removed. Section titles now stand on their own.
- The visible connection indicator and `Connected` copy have been removed.
- The device-readiness button and setup drawer have been removed from the interface. Local model capability is checked internally to select safe assistant behaviour.
- The `Simulate offline` toggle has been removed. Offline behaviour follows the browser's actual network state. Use browser network throttling or airplane mode for offline QA.
- The assistant header no longer shows a decorative mark or `HYBRID` status badge. Its subtitle explains that answers use the trip's saved route and field guide.
- The PWA installation icons show the word **Trail** only. The browser favicon graphic has been removed.
- Metric and section labels use title case rather than uppercase eyebrow styling. Supporting text sizes were increased.

## Phase 2 implementation retained

### Authoritative trail data

- Ontario Trail Network: queries provincial trail segment layer 19 and access point layer 20 when the route falls within Ontario coverage.
- U.S. National Park Service Public Trails: queries the national public-trail layer only for approximate U.S. coverage.
- USDA Forest Service National Forest System Trails: queries the national forest trail layer only for approximate U.S. coverage.
- Optional customer regional ArcGIS Feature Layer: one additional layer can be configured per deployment, with publisher, licence name and licence URL returned as source metadata.
- Trail features are compared to the complete route geometry using a local metric projection; line segments are included only when their calculated distance is at most 500 m. Missing source attributes are not treated as permission or access confirmation.
- Source publisher, data link, terms/licence link, coverage and check timestamp are retained in trip metadata and shown in the interface.

These are regional datasets, not a complete North American trail inventory. Ontario coverage is provincial; the NPS source is limited to National Park System trail data; USFS coverage is limited to National Forest System trail data. Other regions require customer-supplied GPX or an additional authoritative provider.

### GPX import

- GPX 1.0 and 1.1 route and track parsing.
- Track name, waypoint name/description and available elevation import.
- 2 MiB request limit and 100,000-point cap.
- Rejects invalid XML, document type/entity declarations, invalid coordinates and unusable routes.
- Rejects disconnected track segments when gaps exceed 50 m rather than drawing an invented straight connector.
- Imported waypoints are retained even when third-party POI providers return no results.

### POI discovery

- Google Places API (New) Search Text uses route-aware `searchAlongRouteParameters.polyline.encodedPolyline` requests.
- A local geometry check filters returned results to no more than 500 m from the full planned route.
- Imported GPX waypoints and regional trail features are processed separately from Google Places results.
- Search Along Route is not represented as exhaustive coverage; it does not guarantee every access point, facility or hazard is returned.

### Weather and daylight

- Weather is queried at the route start, midpoint and finish.
- Route-wide hazard values are aggregated from available samples.
- Forecast fields include temperature, precipitation, wind gusts, UV, weather code and daylight values when the selected date is in the forecast window.
- Sunrise and sunset are normalized to the forecast location's IANA timezone; absolute departure times from the browser are converted to that timezone before selecting the forecast hour.
- If the provider is unavailable, the interface labels forecast data as unavailable and uses an astronomical sunrise/sunset approximation where possible.
- The UI warns that model forecasts are planning context and not official severe-weather warnings.
- The free Open-Meteo public API is non-commercial. A commercial customer deployment must supply an appropriate paid subscription/customer endpoint and explicitly confirm licensing, or replace the provider with another commercially licensed weather service. The environment confirmation flag is an assertion; it does not purchase a licence.

## Automated system validation

| Check | Result |
|---|---:|
| Backend pytest suite | 20 passed |
| Python syntax compilation | Passed in prior Phase 2 validation |
| GPX parsing and validation cases | Passed in backend suite |
| Encoded-polyline and distance calculations | Passed in backend suite |
| Full line-to-line trail segment matching | Passed in backend suite |
| Regional coverage gating | Passed in backend suite |
| Weather route sampling and aggregation | Passed in backend suite |
| FastAPI health/config and server-secret non-disclosure | Passed in backend suite |
| TypeScript syntax transpilation | 9 source files, 0 syntax diagnostics |
| Package and PWA manifest JSON parsing | Passed |
| PWA icon dimensions | 192×192 and 512×512, valid PNG |

## Browser and UI validation

The current HTML shell and production CSS were rendered in Chromium with representative saved-trip, conditions, map, GPS, POI and assistant content. This is a visual/layout smoke test using an isolated document, not a run of the compiled application bundle. Firebase, IndexedDB, AI and external map/GIS services were not loaded in this isolated page.

| Viewport | Horizontal overflow | Browser page errors |
|---|---:|---:|
| 320 px | None | 0 |
| 390 px | None | 0 |
| 768 px | None | 0 |
| 1024 px | None | 0 |
| 1440 px | None | 0 |

DOM checks confirmed:

- Header text is exactly `Trail`.
- No logo/monogram/avatar elements are present in the application shell.
- No `.section-kicker` eyebrow elements are present.
- No connection, device-readiness or simulated-offline controls are present.
- The assistant uses local-trip copy and has no inference-status badge.

This pass verifies visual layout and element removal; it does not claim interaction testing of the compiled frontend, real map rendering, real GPS hardware or an actual offline AI session.

## Validation limitations and release blockers

1. `npm run build` could not complete because dependencies are not installed in this environment. It fails at the missing `esbuild` package. The TypeScript syntax-transpilation check is not a substitute for a dependency-backed full type check.
2. Live Google Maps Routes/Places/Elevation requests, Firebase AI Logic/App Check, live ArcGIS requests and the paid weather endpoint were not end-to-end tested with customer credentials.
3. Browser validation used the production CSS and an isolated representative document. The actual app JavaScript bundle, browser persistence, live MapLibre map, GPS hardware and Prompt API inference were not executed in this pass.
4. The weather integration must not be deployed commercially on Open-Meteo's free public endpoint. Confirm a suitable commercial licence and customer endpoint first.
5. Nearby official trail features do not certify that a route is open, legal, maintained or safe. Verify access and closures with the responsible land manager before publishing customer navigation guidance.

## Required customer-environment verification before release

- Install pinned frontend dependencies, run `npm run build` and `npm run typecheck`, and resolve any compiler errors.
- Configure Firebase AI Logic and production App Check; verify cloud field-guide generation and offline `ON_DEVICE` inference on supported desktop Chrome.
- Configure Google Maps Routes, Places and Elevation keys; test a real Ontario route and representative U.S. NPS/USFS route.
- Confirm the customer's selected regional GIS source, attributes, update cadence and licence.
- Configure a commercially licensed weather endpoint and validate a trip across a timezone boundary.
- Test GPX import, service-worker reload and local storage on actual target devices with network access disabled.
