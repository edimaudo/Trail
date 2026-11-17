import pytest

from backend.app.geography import (
    distance_to_route,
    encode_polyline,
    haversine,
    parse_gpx,
)
from backend.app.main import _decode_polyline, _line_distance_to_route, _route_has_us_coverage


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
    from backend.app import main as trail_api

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
