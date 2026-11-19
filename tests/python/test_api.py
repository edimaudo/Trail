from pathlib import Path

from fastapi.testclient import TestClient

from app import main as trail_api

client = TestClient(trail_api.app)


def test_health_endpoint() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["service"] == "trail-api"


def test_public_config_does_not_expose_server_maps_key(monkeypatch) -> None:
    monkeypatch.setattr(trail_api, "MAPS_KEY", "server-secret-value")
    response = client.get("/api/config")
    assert response.status_code == 200
    assert "server-secret-value" not in response.text
    assert "GOOGLE_MAPS_SERVER_API_KEY" not in response.text


def test_trail_source_registry_includes_regional_provenance() -> None:
    response = client.get("/api/trails/sources")
    assert response.status_code == 200
    ids = {source["id"] for source in response.json()["sources"]}
    assert {"ontario-trail-network", "nps-public-trails", "usfs-national-forest-trails", "open-meteo", "gpx-1.1"} <= ids


def test_gpx_import_endpoint_saves_route_and_context(monkeypatch) -> None:
    async def fake_enrich(client, route, trip_id, departure_at, encoded=None):
        return [], [], {"provider": "Open-Meteo", "forecastAvailable": False, "commercialLicenseConfigured": False}, [], {"status": "complete", "successfulQueries": 2, "totalQueries": 2}

    monkeypatch.setattr(trail_api, "_enrich_trip", fake_enrich)
    payload = {
        "name": "Client test route",
        "activity": "hiking",
        "difficulty": "moderate",
        "filename": "sample.gpx",
        "departureAt": "2026-11-15T08:00",
        "gpxXml": '''<gpx version="1.1" creator="Trail API test">
          <trk><name>Sample route</name><trkseg>
            <trkpt lat="43.6530" lon="-79.3830"><ele>100</ele></trkpt>
            <trkpt lat="43.6535" lon="-79.3820"><ele>105</ele></trkpt>
            <trkpt lat="43.6540" lon="-79.3810"><ele>103</ele></trkpt>
          </trkseg></trk></gpx>''',
    }
    response = client.post("/api/trips/compile-gpx", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["trip"]["routeSource"] == "gpx-import"
    assert body["trip"]["gpxFilename"] == "sample.gpx"
    assert body["trip"]["gpxPointCount"] == 3
    assert body["trip"]["distanceMeters"] > 0
    assert body["trip"]["departureAt"] == "2026-11-15T08:00"
    assert body["trip"]["offlineSnapshot"]["pointsOfInterestResolved"] is True
    assert body["trip"]["offlineSnapshot"]["pointOfInterestSearchStatus"] == "complete"
    assert body["trip"]["offlineSnapshot"]["environmentalContextCaptured"] is True
    assert body["trip"]["offlineSnapshot"]["mapPackReady"] is False


def test_gpx_import_endpoint_rejects_invalid_xml() -> None:
    response = client.post("/api/trips/compile-gpx", json={
        "name": "Bad route", "gpxXml": "<not-gpx/>"
    })
    assert response.status_code == 422
    assert "GPX" in response.text


def test_runtime_config_exposes_weather_license_flag_not_secret(monkeypatch) -> None:
    monkeypatch.setattr(trail_api, "OPEN_METEO_API_KEY", "paid-weather-secret")
    monkeypatch.setattr(trail_api, "MAPS_KEY", "server-maps-secret")
    response = client.get("/api/config")
    assert response.status_code == 200
    assert "paid-weather-secret" not in response.text
    assert "server-maps-secret" not in response.text


def test_configured_authority_license_metadata_is_returned(monkeypatch) -> None:
    monkeypatch.setattr(trail_api, "TRAIL_AUTHORITY_LAYER_URL", "https://gis.example.org/FeatureServer/0")
    monkeypatch.setattr(trail_api, "TRAIL_AUTHORITY_SOURCE_NAME", "Client Regional Trails")
    monkeypatch.setattr(trail_api, "TRAIL_AUTHORITY_LICENSE_NAME", "Open Data Licence v2")
    monkeypatch.setattr(trail_api, "TRAIL_AUTHORITY_LICENSE_URL", "https://gis.example.org/licence")
    response = client.get("/api/trails/sources")
    assert response.status_code == 200
    source = next(item for item in response.json()["sources"] if item["id"] == "regional-authority")
    assert source["name"] == "Client Regional Trails"
    assert source["license"] == "Open Data Licence v2"
    assert source["licenseUrl"] == "https://gis.example.org/licence"


def test_fastapi_serves_installable_pwa_shell_and_manifest() -> None:
    home = client.get("/")
    assert home.status_code == 200
    assert "Trail" in home.text
    assert '/manifest.webmanifest' in home.text
    assert "register('/service-worker.js'" in (Path(trail_api.__file__).resolve().parent / 'source' / 'typescript' / 'main.ts').read_text(encoding='utf-8')
    assert '/css/app.css' in home.text
    assert '/js/main.js' in home.text

    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    assert manifest.json()["scope"] == "/"
    assert manifest.json()["start_url"] == "/"
    assert manifest.json()["icons"][0]["src"] == "/icons/trail-192.png"


def test_service_worker_is_root_scoped_and_offline_page_is_served() -> None:
    worker = client.get("/service-worker.js")
    assert worker.status_code == 200
    assert worker.headers["service-worker-allowed"] == "/"
    assert "trail-shell-v9" in worker.text
    assert "trail-vendor-v1" in worker.text
    assert "/js/main.js" in worker.text
    assert "/css/app.css" in worker.text

    offline = client.get("/offline.html")
    assert offline.status_code == 200
    assert "Trail" in offline.text


def test_unknown_api_paths_do_not_return_the_pwa_shell() -> None:
    response = client.get("/api/unknown-route")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


def test_fastapi_serves_pwa_icon_and_browser_css_source() -> None:
    icon = client.get("/icons/trail-192.png")
    assert icon.status_code == 200
    assert icon.headers["content-type"].startswith("image/png")

    css = client.get("/css/app.css")
    assert css.status_code == 200
    assert ".app-frame" in css.text

    app_js = client.get("/js/main.js")
    assert app_js.status_code == 200
    assert "maplibre-gl" in app_js.text
    assert "./lib/firebase.js" in app_js.text

    firebase_module = client.get("/js/lib/firebase.js")
    assert firebase_module.status_code == 200
    assert "firebase/ai" in firebase_module.text
