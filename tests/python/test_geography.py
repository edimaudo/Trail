import pytest

from app.geography import (
    distance_to_route,
    encode_polyline,
    haversine,
    parse_gpx,
)
from app.main import _decode_polyline, _line_distance_to_route, _route_has_us_coverage


def test_haversine_known_distance() -> None:
    # Approximately one degree of latitude at the equator.
    distance = haversine({"lat": 0.0, "lng": 0.0}, {"lat": 1.0, "lng": 0.0})
    assert 111_000 < distance < 111_300


def test_polyline_round_trip() -> None:
    points = [
        {"lat": 43.6532, "lng": -79.3832},
        {"lat": 43.6540, "lng": -79.3810},
        {"lat": 43.6555, "lng": -79.3790},
    ]
    decoded = _decode_polyline(encode_polyline(points))
    assert len(decoded) == len(points)
    for actual, expected in zip(decoded, points):
        assert abs(actual["lat"] - expected["lat"]) < 0.00001
        assert abs(actual["lng"] - expected["lng"]) < 0.00001


def test_distance_to_route_uses_segment_not_only_vertices() -> None:
    route = [{"lat": 0.0, "lng": 0.0}, {"lat": 0.0, "lng": 0.01}]
    point = {"lat": 0.001, "lng": 0.005}
    assert 100 < distance_to_route(point, route) < 115


def test_authoritative_line_matching_finds_mid_segment_crossing() -> None:
    route = [{"lat": 43.6500, "lng": -79.4000}, {"lat": 43.6500, "lng": -79.3800}]
    # Trail line endpoints are not close to either route endpoint, but the
    # middle of the trail segment passes 50 m north of the route.
    trail = [[
        {"lat": 43.65045, "lng": -79.3900},
        {"lat": 43.65045, "lng": -79.3890},
    ]]
    assert _line_distance_to_route(trail, route) < 60


def test_region_gate_does_not_treat_toronto_as_us() -> None:
    toronto = [{"lat": 43.6532, "lng": -79.3832}, {"lat": 43.66, "lng": -79.37}]
    seattle = [{"lat": 47.6062, "lng": -122.3321}, {"lat": 47.61, "lng": -122.32}]
    vancouver = [{"lat": 49.2827, "lng": -123.1207}]
    buffalo = [{"lat": 42.8864, "lng": -78.8784}]
    assert not _route_has_us_coverage(toronto)
    assert not _route_has_us_coverage(vancouver)
    assert _route_has_us_coverage(buffalo)
    assert _route_has_us_coverage(seattle)


def test_parse_gpx_track_waypoint_and_elevation() -> None:
    xml = '''<?xml version="1.0" encoding="UTF-8"?>
    <gpx version="1.1" creator="Trail test" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="43.6535" lon="-79.3820"><name>Lookout</name><desc>Waypoint note</desc></wpt>
      <trk><name>Ravine loop</name><trkseg>
        <trkpt lat="43.6530" lon="-79.3830"><ele>100</ele></trkpt>
        <trkpt lat="43.6535" lon="-79.3820"><ele>112</ele></trkpt>
        <trkpt lat="43.6540" lon="-79.3810"><ele>108</ele></trkpt>
      </trkseg></trk>
    </gpx>'''
    result = parse_gpx(xml, "trip-1")
    assert result["name"] == "Ravine loop"
    assert result["pointCount"] == 3
    assert result["distanceMeters"] > 0
    assert result["elevationGainM"] == 12
    assert result["landmarks"][0]["name"] == "Lookout"
    assert result["landmarks"][0]["tripId"] == "trip-1"


def test_parse_gpx_rejects_entity_declarations() -> None:
    xml = '''<?xml version="1.0"?>
    <!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    <gpx version="1.1" creator="bad"><trk><trkseg>
      <trkpt lat="43" lon="-79"/><trkpt lat="43.1" lon="-79.1"/>
    </trkseg></trk></gpx>'''
    with pytest.raises(ValueError, match="entity declarations"):
        parse_gpx(xml, "trip-1")


def test_parse_gpx_rejects_disconnected_track_segments() -> None:
    xml = '''<gpx version="1.1" creator="Trail test">
    <trk><trkseg><trkpt lat="43.0" lon="-79.0"/><trkpt lat="43.0001" lon="-79.0"/></trkseg>
    <trkseg><trkpt lat="43.01" lon="-79.0"/><trkpt lat="43.0101" lon="-79.0"/></trkseg></trk></gpx>'''
    with pytest.raises(ValueError, match="disconnected segments"):
        parse_gpx(xml, "trip-2")


def test_parse_gpx_rejects_invalid_coordinates() -> None:
    xml = '''<gpx version="1.1" creator="Trail test"><trk><trkseg>
    <trkpt lat="999" lon="-79"/><trkpt lat="998" lon="-79"/>
    </trkseg></trk></gpx>'''
    with pytest.raises(ValueError, match="No usable GPX"):
        parse_gpx(xml, "trip-3")


@pytest.mark.asyncio
async def test_usfs_provider_queries_only_fields_present_in_published_layer(monkeypatch):
    from app import main as trail_api

    requests = []

    async def fake_query(client, layer_url, route, out_fields, max_records=500):
        requests.append((layer_url, out_fields))
        return []

    monkeypatch.setattr(trail_api, "_query_arcgis_layer", fake_query)
    route = [{"lat": 42.8864, "lng": -78.8784}, {"lat": 42.89, "lng": -78.87}]
    await trail_api._fetch_us_national_trails(object(), route)
    usfs = next(fields for url, fields in requests if "EDW_TrailNFSPublishWithDataStatus_01" in url)
    assert "trail_name" in usfs
    assert "trail_surface" in usfs
    assert "typical_trail_grade" in usfs
    assert "allowed_terra_use" in usfs
    assert "hiker_pedestrian_accpt" not in usfs
    assert "hiker_pedestrian_restricted" not in usfs


def test_distance_sampling_is_uniform_and_includes_endpoints() -> None:
    from app.main import _sample_route_at_distances, _sample_route

    route = [
        {"lat": 0.0, "lng": 0.0},
        {"lat": 0.0, "lng": 0.002},
        {"lat": 0.0, "lng": 0.02},
    ]
    samples = _sample_route_at_distances(route, interval_m=250, max_samples=20)
    assert len(samples) >= 2
    assert samples[0]["distanceM"] == 0
    total = samples[-1]["distanceM"]
    assert abs(samples[-1]["lat"] - route[-1]["lat"]) < 1e-9
    assert abs(samples[-1]["lng"] - route[-1]["lng"]) < 1e-9
    gaps = [right["distanceM"] - left["distanceM"] for left, right in zip(samples, samples[1:])]
    assert max(gaps) - min(gaps) < 1e-6

    fixed = _sample_route(route, 2)
    assert len(fixed) == 2
    assert fixed[0] == route[0]
    assert fixed[-1] == route[-1]
    assert total > 1_000


def test_distance_sampling_respects_google_elevation_limit() -> None:
    from app.main import _sample_route_at_distances

    route = [{"lat": 0.0, "lng": index * 0.001} for index in range(10_000)]
    samples = _sample_route_at_distances(route, interval_m=10, max_samples=512)
    assert len(samples) == 512
    assert samples[0]["distanceM"] == 0
    assert samples[-1]["lng"] == route[-1]["lng"]


@pytest.mark.asyncio
async def test_elevation_uses_distance_sampled_path_and_returns_profile(monkeypatch) -> None:
    from app import main as trail_api

    route = [
        {"lat": 43.6530, "lng": -79.3830},
        {"lat": 43.6535, "lng": -79.3820},
        {"lat": 43.6540, "lng": -79.3810},
    ]
    distance = trail_api._route_cumulative_distances(route)[-1]
    sample_count = max(2, len(trail_api._sample_route_at_distances(route, 50, 512)))
    captured = {}

    class FakeResponse:
        is_error = False

        def json(self):
            return {
                "status": "OK",
                "results": [{"elevation": value} for value in (100, 103, 101, 108, 110, 106)[:sample_count]],
            }

    class FakeClient:
        async def get(self, url, params):
            captured["url"] = url
            captured["params"] = params
            return FakeResponse()

    monkeypatch.setattr(trail_api, "MAPS_KEY", "test-key")
    enriched, gain, profile = await trail_api._fetch_elevation(FakeClient(), route)
    assert captured["url"].endswith("/elevation/json")
    assert captured["params"]["path"].startswith("enc:")
    assert 2 <= captured["params"]["samples"] <= 512
    assert profile[0]["distanceM"] == 0
    assert abs(profile[-1]["distanceM"] - distance) < 0.1
    assert len(profile) >= 2
    assert len(enriched) == len(route)
    assert all("altitude" in point for point in enriched)
    assert gain > 0


def test_offline_snapshot_distinguishes_trip_data_from_basemap() -> None:
    from app.main import _offline_snapshot

    snapshot = _offline_snapshot(
        [{"lat": 43.0, "lng": -79.0}, {"lat": 43.1, "lng": -79.1}],
        [], [], {"provider": "Open-Meteo", "forecastAvailable": False},
        [{"id": "gpx-import"}], {"status": "complete", "successfulQueries": 2, "totalQueries": 2},
    )
    assert snapshot["routeGeometryCaptured"] is True
    assert snapshot["pointsOfInterestResolved"] is True
    assert snapshot["pointOfInterestCount"] == 0
    assert snapshot["trailNetworkChecked"] is False
    assert snapshot["trailNetworkCheckStatus"] == "no-coverage"
    assert snapshot["environmentalContextCaptured"] is True
    assert snapshot["sourceAttributionSaved"] is True
    assert snapshot["mapPackReady"] is False
    assert snapshot["mapPackTileCount"] == 0


@pytest.mark.asyncio
async def test_places_readiness_is_not_claimed_when_maps_is_not_configured(monkeypatch):
    from app import main as trail_api

    monkeypatch.setattr(trail_api, "MAPS_KEY", "")
    landmarks, status = await trail_api._fetch_landmarks(
        object(), [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}], "trip-1", "encoded"
    )
    assert landmarks == []
    assert status["status"] == "not-configured"
    assert status["successfulQueries"] == 0


def test_offline_snapshot_does_not_mark_places_complete_without_search():
    from app.main import _offline_snapshot

    snapshot = _offline_snapshot(
        [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}],
        [], [], {"provider": "Open-Meteo", "forecastAvailable": False},
        [{"id": "open-meteo"}], {"status": "not-configured", "successfulQueries": 0, "totalQueries": 2},
    )
    assert snapshot["pointsOfInterestResolved"] is False
    assert snapshot["pointOfInterestSearchStatus"] == "not-configured"


def test_offline_snapshot_only_marks_trail_network_checked_when_provider_covers_region():
    from app.main import _offline_snapshot

    route = [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}]
    no_coverage = _offline_snapshot(route, [], [], {}, [{"id": "google-places"}], {"status": "complete"})
    assert no_coverage["trailNetworkChecked"] is False
    assert no_coverage["trailNetworkCheckStatus"] == "no-coverage"

    covered = _offline_snapshot(route, [], [], {}, [{"id": "ontario-trail-network", "queryStatus": "complete"}], {"status": "complete"})
    assert covered["trailNetworkChecked"] is True
    assert covered["trailNetworkCheckStatus"] == "complete"

    partial = _offline_snapshot(route, [], [], {}, [{"id": "ontario-trail-network", "queryStatus": "partial"}], {"status": "complete"})
    assert partial["trailNetworkChecked"] is False
    assert partial["trailNetworkCheckStatus"] == "partial"

    failed = _offline_snapshot(route, [], [], {}, [{"id": "ontario-trail-network", "queryStatus": "unavailable"}], {"status": "complete"})
    assert failed["trailNetworkChecked"] is False
    assert failed["trailNetworkCheckStatus"] == "unavailable"


@pytest.mark.asyncio
async def test_places_readiness_reports_partial_query_when_one_route_search_fails(monkeypatch):
    from app import main as trail_api

    monkeypatch.setattr(trail_api, "MAPS_KEY", "test-server-key")

    class Response:
        is_error = False
        def json(self):
            return {"places": []}

    class FakeClient:
        calls = 0
        async def post(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return Response()
            raise __import__("httpx").ConnectError("simulated failure")

    landmarks, status = await trail_api._fetch_landmarks(
        FakeClient(), [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}], "trip-2", "encoded"
    )
    assert landmarks == []
    assert status["status"] == "partial"
    assert status["successfulQueries"] == 1
    snapshot = trail_api._offline_snapshot(
        [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}], [], [], {},
        [{"id": "ontario-trail-network"}], status
    )
    assert snapshot["pointsOfInterestResolved"] is False


@pytest.mark.asyncio
async def test_arcgis_empty_result_is_distinct_from_failed_query():
    from app.main import _query_arcgis_layer

    class SuccessResponse:
        is_error = False
        def json(self):
            return {"features": []}

    class FailureResponse:
        is_error = True

    class Client:
        def __init__(self, response):
            self.response = response
        async def post(self, *args, **kwargs):
            return self.response

    route = [{"lat": 43.65, "lng": -79.38}, {"lat": 43.66, "lng": -79.37}]
    empty_success = await _query_arcgis_layer(Client(SuccessResponse()), "https://gis.example.org/layer", route, "*")
    failed = await _query_arcgis_layer(Client(FailureResponse()), "https://gis.example.org/layer", route, "*")

    assert empty_success == []
    assert empty_success.query_succeeded is True
    assert failed == []
    assert failed.query_succeeded is False
