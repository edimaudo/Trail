from fastapi.testclient import TestClient

from backend.app import main as trail_api

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
        return [], [], {"provider": "Open-Meteo", "forecastAvailable": False, "commercialLicenseConfigured": False}, []

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
