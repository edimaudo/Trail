from __future__ import annotations

import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from uuid import uuid4

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .geography import distance_to_route, encode_polyline, haversine, parse_gpx

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

APP_ENV = os.getenv("APP_ENV", "development")
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "")
FIREBASE_APP_ID = os.getenv("FIREBASE_APP_ID", "")
MAPS_KEY = os.getenv("GOOGLE_MAPS_SERVER_API_KEY", "")
TRAIL_AUTHORITY_LAYER_URL = os.getenv("TRAIL_AUTHORITY_FEATURE_LAYER_URL", "").strip()
TRAIL_AUTHORITY_SOURCE_NAME = os.getenv("TRAIL_AUTHORITY_SOURCE_NAME", "Configured regional trail authority").strip()
TRAIL_AUTHORITY_LICENSE_NAME = os.getenv("TRAIL_AUTHORITY_LICENSE_NAME", "See source terms").strip()
TRAIL_AUTHORITY_LICENSE_URL = os.getenv("TRAIL_AUTHORITY_LICENSE_URL", "").strip()
OPEN_METEO_API_KEY = os.getenv("OPEN_METEO_API_KEY", "").strip()
OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED = os.getenv("OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED", "false").lower() == "true"
OPEN_METEO_API_BASE_URL = os.getenv("OPEN_METEO_API_BASE_URL", "").strip() or (
    "https://customer-api.open-meteo.com/v1/forecast" if OPEN_METEO_API_KEY else "https://api.open-meteo.com/v1/forecast"
)
APP_CHECK_ENFORCED = os.getenv("APP_CHECK_ENFORCED", "false").lower() == "true"

app = FastAPI(
    title="Trail PWA",
    version="1.7.0",
    description="Python-first Trail Progressive Web App. FastAPI serves the installable PWA and application APIs; Firebase AI Logic runs through its supported browser SDK.",
    docs_url="/api/docs" if APP_ENV != "production" else None,
    redoc_url=None,
)

origins = [item.strip() for item in os.getenv("ALLOWED_ORIGINS", "http://localhost:8000").split(",") if item.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Firebase-AppCheck"],
)


class TripCompileRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    start: str = Field(min_length=2, max_length=250)
    end: str = Field(min_length=2, max_length=250)
    loop: bool = False
    activity: Literal["hiking", "trail-running", "cycling"] = "hiking"
    difficulty: Literal["easy", "moderate", "strenuous"] = "moderate"
    departure_at: str | None = Field(default=None, alias="departureAt", max_length=40)

    model_config = {"populate_by_name": True}


class GpxImportRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    start: str = Field(default="Imported GPX start", max_length=250)
    end: str = Field(default="Imported GPX finish", max_length=250)
    activity: Literal["hiking", "trail-running", "cycling"] = "hiking"
    difficulty: Literal["easy", "moderate", "strenuous"] = "moderate"
    departure_at: str | None = Field(default=None, alias="departureAt", max_length=40)
    filename: str = Field(default="trail.gpx", max_length=160)
    gpx_xml: str = Field(alias="gpxXml", min_length=1, max_length=2_000_000)

    model_config = {"populate_by_name": True}


class GuideContextRequest(BaseModel):
    trip: dict[str, Any]
    landmarks: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    season: str = Field(default="unknown", max_length=20)


def _firebase_admin_app():
    try:
        import firebase_admin
        return firebase_admin.get_app()
    except ValueError:
        if not FIREBASE_PROJECT_ID:
            raise HTTPException(status_code=503, detail="FIREBASE_PROJECT_ID is required to verify App Check tokens.")
        return firebase_admin.initialize_app(options={"projectId": FIREBASE_PROJECT_ID})


async def require_app_check(x_firebase_appcheck: str | None = Header(default=None)) -> None:
    if not APP_CHECK_ENFORCED:
        return
    if not x_firebase_appcheck:
        raise HTTPException(status_code=401, detail="Missing Firebase App Check token.")
    try:
        from firebase_admin import app_check
        claims = app_check.verify_token(x_firebase_appcheck, app=_firebase_admin_app())
        if FIREBASE_APP_ID and claims.get("sub") != FIREBASE_APP_ID:
            raise ValueError("App Check token belongs to a different Firebase app.")
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Firebase App Check token.") from exc


def _decode_polyline(encoded: str) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    index = lat = lng = 0
    while index < len(encoded):
        result = shift = 0
        while True:
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        lat += ~(result >> 1) if result & 1 else result >> 1

        result = shift = 0
        while True:
            byte = ord(encoded[index]) - 63
            index += 1
            result |= (byte & 0x1F) << shift
            shift += 5
            if byte < 0x20:
                break
        lng += ~(result >> 1) if result & 1 else result >> 1
        points.append({"lat": lat / 1e5, "lng": lng / 1e5})
    return points


def _haversine(a: dict[str, float], b: dict[str, float]) -> float:
    return haversine(a, b)


def _route_cumulative_distances(points: list[dict[str, float]]) -> list[float]:
    """Return cumulative geodesic distance at every route vertex."""
    cumulative = [0.0]
    for start, end in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + _haversine(start, end))
    return cumulative


def _sample_route_at_distances(
    points: list[dict[str, float]], interval_m: float = 50.0, max_samples: int = 512
) -> list[dict[str, float]]:
    """Sample a route at near-uniform distance intervals, including both endpoints."""
    if not points:
        return []
    if len(points) == 1:
        return [{"distanceM": 0.0, **points[0]}]
    if interval_m <= 0 or max_samples < 2:
        raise ValueError("Route sampling requires a positive interval and at least two samples.")

    cumulative = _route_cumulative_distances(points)
    total = cumulative[-1]
    if total <= 0:
        return [{"distanceM": 0.0, **points[0]}, {"distanceM": 0.0, **points[-1]}]
    count = min(max_samples, max(2, math.ceil(total / interval_m) + 1))
    targets = [total * index / (count - 1) for index in range(count)]
    sampled: list[dict[str, float]] = []
    segment = 0
    for sample_index, target in enumerate(targets):
        if sample_index == 0:
            sampled.append({"distanceM": 0.0, **points[0]})
            continue
        if sample_index == count - 1:
            sampled.append({"distanceM": total, **points[-1]})
            continue
        while segment < len(cumulative) - 2 and cumulative[segment + 1] < target:
            segment += 1
        start_distance, end_distance = cumulative[segment], cumulative[segment + 1]
        span = end_distance - start_distance
        fraction = 0.0 if span <= 0 else (target - start_distance) / span
        start, end = points[segment], points[segment + 1]
        point: dict[str, float] = {
            "distanceM": target,
            "lat": start["lat"] + (end["lat"] - start["lat"]) * fraction,
            "lng": start["lng"] + (end["lng"] - start["lng"]) * fraction,
        }
        if isinstance(start.get("altitude"), (int, float)) and isinstance(end.get("altitude"), (int, float)):
            point["altitude"] = float(start["altitude"]) + (float(end["altitude"]) - float(start["altitude"])) * fraction
        sampled.append(point)
    return sampled


def _sample_route(points: list[dict[str, float]], count: int) -> list[dict[str, float]]:
    """Compatibility helper: sample count evenly by distance, not vertex index."""
    if len(points) <= count:
        return points
    if count < 2:
        raise ValueError("At least two route samples are required.")
    total = _route_cumulative_distances(points)[-1]
    if total <= 0:
        return [points[0], points[-1]]
    return [{key: value for key, value in sample.items() if key != "distanceM"}
            for sample in _sample_route_at_distances(points, max_samples=count, interval_m=total / (count - 1))]


def _elevation_profile_from_route(points: list[dict[str, float]], max_samples: int = 256) -> list[dict[str, float]]:
    if len(points) < 2 or not all(isinstance(point.get("altitude"), (int, float)) for point in points):
        return []
    samples = _sample_route_at_distances(points, max_samples=max_samples, interval_m=50.0)
    return [
        {"distanceM": round(sample["distanceM"], 1), "elevationM": round(float(sample["altitude"]), 1)}
        for sample in samples if isinstance(sample.get("altitude"), (int, float))
    ]


def _elevation_at_distance(profile: list[dict[str, float]], distance_m: float) -> float:
    if not profile:
        return 0.0
    if distance_m <= profile[0]["distanceM"]:
        return profile[0]["elevationM"]
    for left, right in zip(profile, profile[1:]):
        if distance_m <= right["distanceM"]:
            span = right["distanceM"] - left["distanceM"]
            fraction = 0.0 if span <= 0 else (distance_m - left["distanceM"]) / span
            return left["elevationM"] + (right["elevationM"] - left["elevationM"]) * fraction
    return profile[-1]["elevationM"]


def _place_category(types: list[str]) -> str:
    joined = " ".join(types).lower()
    if any(word in joined for word in ("scenic_lookout", "viewpoint", "observation_deck")):
        return "viewpoint"
    if any(word in joined for word in ("hiking_area", "trailhead", "national_park", "park")):
        return "trailhead"
    if any(word in joined for word in ("waterfall", "river", "lake", "beach")):
        return "water"
    if any(word in joined for word in ("restroom", "visitor_center", "campground", "picnic_ground")):
        return "facility"
    return "landmark"


async def _request_route(client: httpx.AsyncClient, request: TripCompileRequest) -> dict[str, Any]:
    if not MAPS_KEY:
        raise HTTPException(status_code=503, detail="Live route compilation is not configured. Add GOOGLE_MAPS_SERVER_API_KEY to the FastAPI environment.")

    origin = {"address": request.start}
    destination = {"address": request.start if request.loop else request.end}
    payload: dict[str, Any] = {
        "origin": origin,
        "destination": destination,
        "travelMode": "BICYCLE" if request.activity == "cycling" else "WALK",
        "computeAlternativeRoutes": False,
        "languageCode": "en-CA",
        "units": "METRIC",
    }
    if request.loop:
        payload["intermediates"] = [{"address": request.end}]
        payload["optimizeWaypointOrder"] = False

    response = await client.post(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        params={"key": MAPS_KEY},
        headers={
            "Content-Type": "application/json",
            "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
        },
        json=payload,
    )
    if response.is_error:
        try:
            message = response.json().get("error", {}).get("message", "Google Routes API rejected the request.")
        except Exception:
            message = "Google Routes API rejected the request."
        raise HTTPException(status_code=502, detail=f"Route provider error: {message}")

    data = response.json()
    routes = data.get("routes") or []
    if not routes:
        raise HTTPException(status_code=422, detail="No route was returned for the selected start and destination.")
    route_data = routes[0]
    encoded = route_data.get("polyline", {}).get("encodedPolyline")
    if not encoded:
        raise HTTPException(status_code=502, detail="The route provider returned no route geometry.")
    coordinates = _decode_polyline(encoded)
    if len(coordinates) < 2:
        raise HTTPException(status_code=502, detail="The route geometry is incomplete.")
    duration_seconds = int(str(route_data.get("duration", "0s")).rstrip("s") or 0)
    distance = int(route_data.get("distanceMeters") or sum(_haversine(coordinates[i - 1], coordinates[i]) for i in range(1, len(coordinates))))
    return {"route": coordinates, "distanceMeters": distance, "durationMinutes": max(1, round(duration_seconds / 60)), "encodedPolyline": encoded}


async def _fetch_elevation(
    client: httpx.AsyncClient, route: list[dict[str, float]]
) -> tuple[list[dict[str, float]], float, list[dict[str, float]]]:
    """Retrieve evenly spaced elevation samples and interpolate them onto route vertices.

    Google Elevation supports at most 512 samples per request. A 50 m target interval
    gives useful detail for ordinary trips while the cap bounds cost for long routes.
    """
    if not route:
        return route, 0.0, []
    route_samples = _sample_route_at_distances(route, interval_m=50.0, max_samples=512)
    total_distance = route_samples[-1]["distanceM"] if route_samples else 0.0
    existing_profile = _elevation_profile_from_route(route)
    if not MAPS_KEY:
        if not existing_profile:
            return route, 0.0, []
        gain = sum(max(0.0, right["elevationM"] - left["elevationM"]) for left, right in zip(existing_profile, existing_profile[1:]))
        enriched = [{**point, "altitude": _elevation_at_distance(existing_profile, distance)}
                    for point, distance in zip(route, _route_cumulative_distances(route))]
        return enriched, round(gain), existing_profile

    encoded_route = encode_polyline(route)
    sample_count = max(2, len(route_samples))
    if len(encoded_route) <= 12_000:
        params = {"path": f"enc:{encoded_route}", "samples": sample_count, "key": MAPS_KEY}
    else:
        # Keep the URL below the web-service request-size ceiling using a <=512-point
        # distance-resampled representation. Its path still follows the complete route.
        sampled_points = [{"lat": item["lat"], "lng": item["lng"]} for item in route_samples]
        params = {"locations": f"enc:{encode_polyline(sampled_points)}", "key": MAPS_KEY}

    try:
        response = await client.get("https://maps.googleapis.com/maps/api/elevation/json", params=params)
        if response.is_error:
            return route, 0.0, []
        data = response.json()
        if data.get("status") != "OK":
            return route, 0.0, []
        results = data.get("results") or []
        elevations = [float(item["elevation"]) for item in results if isinstance(item.get("elevation"), (int, float))]
        if len(elevations) < 2:
            return route, 0.0, []
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return route, 0.0, []

    profile = [
        {"distanceM": round(total_distance * index / (len(elevations) - 1), 1), "elevationM": round(value, 1)}
        for index, value in enumerate(elevations)
    ]
    cumulative = _route_cumulative_distances(route)
    enriched = [{**point, "altitude": _elevation_at_distance(profile, distance)}
                for point, distance in zip(route, cumulative)]
    gain = sum(max(0.0, right["elevationM"] - left["elevationM"]) for left, right in zip(profile, profile[1:]))
    return enriched, round(gain), profile


def _route_is_in_ontario(route: list[dict[str, float]]) -> bool:
    if not route:
        return False
    latitudes = [point["lat"] for point in route]
    longitudes = [point["lng"] for point in route]
    return max(latitudes) >= 41.676 and min(latitudes) <= 56.86 and max(longitudes) >= -95.154 and min(longitudes) <= -74.32


def _route_distance(point: dict[str, float], route: list[dict[str, float]]) -> float:
    # Keep all original vertices unless there are unusually dense imported tracks.
    return distance_to_route(point, _sample_route(route, min(5000, max(2, len(route)))))


def _densify_line(line: list[dict[str, float]], spacing_m: float = 75.0) -> list[dict[str, float]]:
    if len(line) < 2:
        return line
    points: list[dict[str, float]] = [line[0]]
    for start, end in zip(line, line[1:]):
        length = haversine(start, end)
        steps = max(1, min(250, math.ceil(length / spacing_m)))
        for index in range(1, steps + 1):
            fraction = index / steps
            points.append({
                "lat": start["lat"] + (end["lat"] - start["lat"]) * fraction,
                "lng": start["lng"] + (end["lng"] - start["lng"]) * fraction,
            })
    return points


def _line_distance_to_route(lines: list[list[dict[str, float]]], route: list[dict[str, float]]) -> float:
    if not lines or len(route) < 2:
        return min((_route_distance(point, route) for line in lines for point in line), default=float("inf"))
    try:
        # Local equirectangular projection is accurate for a regional 500 m corridor.
        # Shapely performs the line-to-line calculation in GEOS rather than an O(n²)
        # loop over every vertex of long GPX tracks and public trail geometries.
        from shapely.geometry import LineString, MultiLineString
        latitude = sum(point["lat"] for point in route[::max(1, len(route) // 1000)]) / len(route[::max(1, len(route) // 1000)])
        x_scale = 111_320.0 * max(0.01, math.cos(math.radians(latitude)))
        y_scale = 111_320.0
        route_line = LineString([(point["lng"] * x_scale, point["lat"] * y_scale) for point in route])
        feature_lines = [
            [(point["lng"] * x_scale, point["lat"] * y_scale) for point in line]
            for line in lines if len(line) >= 2
        ]
        if not feature_lines:
            return float("inf")
        feature_geometry = MultiLineString(feature_lines)
        return float(feature_geometry.distance(route_line))
    except ImportError:
        samples = [point for line in lines for point in _densify_line(line, 200.0)]
        route_sample = _sample_route(route, min(500, max(2, len(route))))
        return min((distance_to_route(point, route_sample) for point in samples), default=float("inf"))


def _route_has_us_coverage(route: list[dict[str, float]]) -> bool:
    # Approximate contiguous-U.S. boundary polygon avoids querying US layers for
    # nearby Canadian cities inside the broad rectangular bounding box.
    contiguous_us = [
        (-125.0, 24.3), (-125.0, 49.0), (-114.0, 49.0), (-104.0, 49.0),
        (-97.0, 49.0), (-95.0, 49.0), (-93.5, 48.4), (-91.0, 47.2),
        (-89.5, 46.7), (-87.0, 46.5), (-85.0, 46.5), (-84.0, 45.8),
        (-83.0, 45.5), (-82.4, 43.5), (-82.5, 42.2), (-80.5, 42.0),
        (-79.7, 43.0), (-79.0, 43.2), (-77.8, 43.3), (-76.5, 43.5),
        (-76.0, 44.2), (-75.5, 45.0), (-71.5, 45.0), (-67.0, 45.0),
        (-67.0, 24.3), (-125.0, 24.3),
    ]

    def inside_polygon(lng: float, lat: float) -> bool:
        inside = False
        for index, (x1, y1) in enumerate(contiguous_us):
            x2, y2 = contiguous_us[(index + 1) % len(contiguous_us)]
            if (y1 > lat) != (y2 > lat):
                crossing = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
                if lng < crossing:
                    inside = not inside
        return inside

    for point in route:
        lat, lng = point["lat"], point["lng"]
        if inside_polygon(lng, lat):
            return True
        if 51.0 <= lat <= 71.5 and (-180.0 <= lng <= -141.0):
            return True
        if 18.7 <= lat <= 22.5 and -161.0 <= lng <= -154.0:
            return True
    return False


def _geojson_lines(geometry: dict[str, Any] | None) -> list[list[dict[str, float]]]:
    if not geometry:
        return []
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    lines = [coords] if kind == "LineString" else coords if kind == "MultiLineString" else []
    output = []
    for line in lines:
        points = []
        for pair in line:
            if len(pair) >= 2:
                try:
                    lng, lat = float(pair[0]), float(pair[1])
                    if -180 <= lng <= 180 and -90 <= lat <= 90:
                        points.append({"lat": lat, "lng": lng})
                except (TypeError, ValueError):
                    continue
        if len(points) >= 2:
            output.append(points)
    return output


class ArcGISFeatureResults(list[dict[str, Any]]):
    """List-compatible ArcGIS result set with an explicit successful-query flag."""

    def __init__(self, features: list[dict[str, Any]] | None = None, query_succeeded: bool = False):
        super().__init__(features or [])
        self.query_succeeded = query_succeeded


async def _query_arcgis_layer(
    client: httpx.AsyncClient,
    layer_url: str,
    route: list[dict[str, float]],
    out_fields: str,
    max_records: int = 500,
) -> ArcGISFeatureResults:
    if not layer_url:
        return ArcGISFeatureResults()
    # ArcGIS REST supports geometry-distance queries for layers with Query With Distance.
    sampled = _sample_route(route, min(1000, max(2, len(route))))
    geometry = {"paths": [[[point["lng"], point["lat"]] for point in sampled]], "spatialReference": {"wkid": 4326}}
    try:
        response = await client.post(
            f"{layer_url.rstrip('/')}/query",
            data={
                "f": "geojson", "where": "1=1", "geometry": __import__("json").dumps(geometry),
                "geometryType": "esriGeometryPolyline", "inSR": "4326", "outSR": "4326",
                "spatialRel": "esriSpatialRelIntersects", "distance": "500", "units": "esriSRUnit_Meter",
                "outFields": out_fields, "returnGeometry": "true", "resultRecordCount": str(max_records),
            },
            timeout=httpx.Timeout(18.0, connect=6.0),
        )
    except httpx.HTTPError:
        return ArcGISFeatureResults()
    if response.is_error:
        return ArcGISFeatureResults()
    try:
        payload = response.json()
    except ValueError:
        return ArcGISFeatureResults()
    if payload.get("error") or not isinstance(payload.get("features"), list):
        return ArcGISFeatureResults()
    # An empty feature list is still a successful regional query.
    return ArcGISFeatureResults(payload["features"], query_succeeded=True)


async def _fetch_ontario_trails(client: httpx.AsyncClient, route: list[dict[str, float]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None]:
    if not _route_is_in_ontario(route):
        return [], [], None
    base = "https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open04/MapServer"
    segment_features, access_features = await __import__("asyncio").gather(
        _query_arcgis_layer(client, f"{base}/19", route, "OGF_ID,TRAIL_NAME,TRAIL_ASSOCIATION,TRAIL_ASSOCIATION_WEBSITE,PERMITTED_USES,DESCRIPTION,TRAIL_LENGTH_KM,LOCATION_ACCURACY,EFFECTIVE_DATETIME,SYSTEM_DATETIME", 500),
        _query_arcgis_layer(client, f"{base}/20", route, "OGF_ID,LOCATION_ACCURACY,GEOMETRY_UPDATE_DATETIME,EFFECTIVE_DATETIME,SYSTEM_DATETIME", 300),
    )
    matches: list[dict[str, Any]] = []
    for feature in segment_features:
        attributes = feature.get("properties") or feature.get("attributes") or {}
        lines = _geojson_lines(feature.get("geometry"))
        if not lines:
            continue
        distance = _line_distance_to_route(lines, route)
        if distance > 500:
            continue
        matches.append({
            "id": f"otn-{attributes.get('OGF_ID') or attributes.get('OBJECTID') or len(matches)}",
            "name": str(attributes.get("TRAIL_NAME") or "Unnamed Ontario Trail Network segment")[:200],
            "association": str(attributes.get("TRAIL_ASSOCIATION") or "")[:160],
            "associationWebsite": str(attributes.get("TRAIL_ASSOCIATION_WEBSITE") or "")[:300],
            "permittedUses": str(attributes.get("PERMITTED_USES") or "")[:250],
            "description": str(attributes.get("DESCRIPTION") or "")[:1000],
            "lengthKm": attributes.get("TRAIL_LENGTH_KM"),
            "locationAccuracy": str(attributes.get("LOCATION_ACCURACY") or "")[:80],
            "effectiveAt": attributes.get("EFFECTIVE_DATETIME"),
            "distanceFromRouteM": round(distance),
            "geometry": lines,
            "source": "ontario-trail-network",
        })
    matches.sort(key=lambda item: item["distanceFromRouteM"])
    accesses: list[dict[str, Any]] = []
    for feature in access_features:
        attributes = feature.get("properties") or feature.get("attributes") or {}
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if geometry.get("type") != "Point" or len(coords) < 2:
            continue
        position = {"lat": float(coords[1]), "lng": float(coords[0])}
        distance = _route_distance(position, route)
        if distance > 500:
            continue
        oid = attributes.get("OGF_ID") or attributes.get("OBJECTID") or len(accesses)
        accesses.append({
            "id": f"otn-access-{oid}", "tripId": "", "name": "Official trail access point",
            "category": "trailhead", "description": "Access point published in the Ontario Trail Network. Confirm current access conditions with the managing organization.",
            "position": position, "source": "ontario-trail-network", "distanceFromRouteM": round(distance),
        })
    source = {
        "id": "ontario-trail-network", "name": "Ontario Trail Network (OTN)",
        "publisher": "Ontario Ministry of Natural Resources / Geospatial Ontario",
        "url": "https://data.ontario.ca/dataset/ontario-trail-network",
        "license": "Open Government Licence – Ontario",
        "licenseUrl": "https://www.ontario.ca/page/open-government-licence-ontario",
        "coverage": "Ontario, Canada", "checkedAt": datetime.now(timezone.utc).isoformat(),
        "queryStatus": "complete" if all(getattr(result, "query_succeeded", False) for result in (segment_features, access_features)) else "partial" if any(getattr(result, "query_succeeded", False) for result in (segment_features, access_features)) else "unavailable",
        "segmentCount": len(matches), "accessPointCount": len(accesses),
        "note": "A named, maintained, publicly accessible trail network. Coverage and update frequency vary by partner data.",
    }
    return matches[:100], accesses[:100], source


async def _fetch_us_national_trails(client: httpx.AsyncClient, route: list[dict[str, float]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not route:
        return [], []
    if not _route_has_us_coverage(route):
        return [], []
    nps_url = "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0"
    usfs_url = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublishWithDataStatus_01/MapServer/0"
    nps_task = _query_arcgis_layer(client, nps_url, route, "OBJECTID,TRLNAME,TRLALTNAME,TRLSTATUS,TRLSURFACE,TRLTYPE,TRLCLASS,TRLUSE,OPENTOPUBLIC,ACCESSNOTES,UNITNAME,SEASONAL,SEASDESC,MAINTAINER", 500)
    usfs_task = _query_arcgis_layer(client, usfs_url, route, "objectid,trail_name,trail_type,segment_length,trail_class,trail_surface,typical_trail_grade,allowed_terra_use,accessibility_status,attributesubset,admin_org,managing_org", 500)
    nps_features, usfs_features = await __import__("asyncio").gather(nps_task, usfs_task)
    matches: list[dict[str, Any]] = []
    for source_id, features in (("nps-public-trails", nps_features), ("usfs-national-forest-trails", usfs_features)):
        for feature in features:
            attributes = feature.get("properties") or feature.get("attributes") or {}
            attrs = {str(key).lower(): value for key, value in attributes.items()}
            lines = _geojson_lines(feature.get("geometry"))
            if not lines:
                continue
            distance = _line_distance_to_route(lines, route)
            if distance > 500:
                continue
            if source_id == "nps-public-trails":
                name = attrs.get("trlname") or attrs.get("trlaltname") or "National Park Service public trail"
                status = attrs.get("trlstatus") or ""
                open_public = str(attrs.get("opentopublic") or "").lower()
                if open_public in ("no", "false", "0", "not open"):
                    status = f"{status}; public access not confirmed".strip("; ")
                description = "; ".join(str(value) for value in (attrs.get("accessnotes"), attrs.get("seasdesc")) if value)
                metadata = {
                    "association": attrs.get("unitname") or "National Park Service",
                    "permittedUses": attrs.get("trluse") or attrs.get("trltype") or "",
                    "surface": attrs.get("trlsurface") or "", "status": status,
                    "description": description[:1000], "source": source_id,
                }
            else:
                name = attrs.get("trail_name") or f"USFS trail {attrs.get('trail_no') or ''}".strip()
                metadata = {
                    "association": attrs.get("managing_org") or attrs.get("admin_org") or "USDA Forest Service",
                    "permittedUses": attrs.get("allowed_terra_use") or attrs.get("trail_type") or "",
                    "surface": attrs.get("trail_surface") or "",
                    "status": f"Class {attrs.get('trail_class')} · {attrs.get('attributesubset')}" if attrs.get("trail_class") else str(attrs.get("attributesubset") or ""),
                    "description": "; ".join(str(value) for value in (attrs.get("typical_trail_grade"), attrs.get("accessibility_status")) if value),
                    "source": source_id,
                }
            matches.append({
                "id": f"{source_id}-{attrs.get('objectid') or len(matches)}",
                "name": str(name)[:254], **metadata,
                "lengthKm": attrs.get("segment_length"), "distanceFromRouteM": round(distance),
                "geometry": lines, "locationAccuracy": "Provider-published geometry; verify with local land manager",
            })
    matches.sort(key=lambda item: item["distanceFromRouteM"])
    sources = [{
            "id": "nps-public-trails", "name": "National Park Service Public Trails", "publisher": "U.S. National Park Service",
            "url": "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
            "license": "See National Park Service data terms", "licenseUrl": "https://www.nps.gov/aboutus/disclaimer.htm",
            "coverage": "National Park System public trails in the United States", "checkedAt": datetime.now(timezone.utc).isoformat(),
            "queryStatus": "complete" if getattr(nps_features, "query_succeeded", False) else "unavailable",
            "note": f"Public visitor-use trails contributed and reviewed by park units; {len([m for m in matches if m['source'] == 'nps-public-trails'])} nearby segment match(es). Formal and informal visitor trail representations.",
        }, {
            "id": "usfs-national-forest-trails", "name": "National Forest System Trails", "publisher": "USDA Forest Service",
            "url": "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublishWithDataStatus_01/MapServer/0",
            "license": "See USDA Forest Service geospatial dataset terms", "licenseUrl": "https://data.fs.usda.gov/geodata/edw/datasets.php",
            "coverage": "National Forest System trails in the United States", "checkedAt": datetime.now(timezone.utc).isoformat(),
            "queryStatus": "complete" if getattr(usfs_features, "query_succeeded", False) else "unavailable",
            "note": f"Attribute completeness varies by forest; {len([m for m in matches if m['source'] == 'usfs-national-forest-trails'])} nearby segment match(es).",
        }]
    return matches[:150], sources


async def _fetch_configured_authority_trails(client: httpx.AsyncClient, route: list[dict[str, float]]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if not TRAIL_AUTHORITY_LAYER_URL:
        return [], None
    parsed_url = urlparse(TRAIL_AUTHORITY_LAYER_URL)
    if parsed_url.scheme != "https" or not parsed_url.hostname:
        return [], {"id": "regional-authority", "name": TRAIL_AUTHORITY_SOURCE_NAME, "coverage": "Not queried: configured layer URL must use HTTPS", "configured": False}
    try:
        features = await _query_arcgis_layer(client, TRAIL_AUTHORITY_LAYER_URL, route, "*", 500)
    except httpx.HTTPError:
        features = []
    matches = []
    for feature in features:
        attributes = feature.get("properties") or feature.get("attributes") or {}
        lines = _geojson_lines(feature.get("geometry"))
        if not lines:
            continue
        # Compare complete polylines so a feature crossing the route is not missed
        # merely because its vertices are far from the route.
        distance = _line_distance_to_route(lines, route)
        if distance > 500:
            continue
        matches.append({
            "id": f"authority-{attributes.get('OBJECTID') or len(matches)}",
            "name": str(attributes.get("TRAIL_NAME") or attributes.get("NAME") or attributes.get("name") or "Regional trail segment")[:200],
            "association": str(attributes.get("MANAGER") or attributes.get("OWNER") or "")[:160],
            "permittedUses": str(attributes.get("USE") or attributes.get("USES") or "")[:250],
            "description": str(attributes.get("DESCRIPTION") or "")[:1000],
            "distanceFromRouteM": round(distance), "geometry": lines, "source": "regional-authority",
        })
    source = {
        "id": "regional-authority", "name": TRAIL_AUTHORITY_SOURCE_NAME,
        "publisher": TRAIL_AUTHORITY_SOURCE_NAME, "url": TRAIL_AUTHORITY_LAYER_URL,
        "license": TRAIL_AUTHORITY_LICENSE_NAME, "licenseUrl": TRAIL_AUTHORITY_LICENSE_URL,
        "coverage": "Configured service coverage", "checkedAt": datetime.now(timezone.utc).isoformat(),
        "queryStatus": "complete" if getattr(features, "query_succeeded", False) else "unavailable",
        "segmentCount": len(matches),
    }
    return matches[:100], source


async def _fetch_landmarks(client: httpx.AsyncClient, route: list[dict[str, float]], trip_id: str, encoded_polyline: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not MAPS_KEY:
        return [], {"status": "not-configured", "successfulQueries": 0, "totalQueries": 2}
    landmarks: dict[str, dict[str, Any]] = {}
    headers = {
        "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress,places.types,places.editorialSummary,places.googleMapsUri",
    }
    # Search along the whole route rather than six isolated 500 m circles.
    queries = [
        "Scenic viewpoints, waterfalls, natural landmarks and parks along this hiking route",
        "Trailheads, visitor centres, campgrounds, restrooms and trail facilities along this route",
    ]
    requests = []
    for query in queries:
        payload = {
            "textQuery": query,
            "searchAlongRouteParameters": {"polyline": {"encodedPolyline": encoded_polyline}},
            "maxResultCount": 20,
            "languageCode": "en-CA",
        }
        requests.append(client.post("https://places.googleapis.com/v1/places:searchText", headers=headers, json=payload))
    responses = await __import__("asyncio").gather(*requests, return_exceptions=True)
    successful_queries = 0
    for response in responses:
        if isinstance(response, Exception) or response.is_error:
            continue
        try:
            payload = response.json()
        except ValueError:
            continue
        successful_queries += 1
        for place in payload.get("places", []):
            place_id = place.get("id")
            location = place.get("location") or {}
            if not place_id or location.get("latitude") is None or location.get("longitude") is None:
                continue
            position = {"lat": float(location["latitude"]), "lng": float(location["longitude"])}
            distance = _route_distance(position, route)
            if distance > 500:
                continue
            types = place.get("types") or []
            summary = (place.get("editorialSummary") or {}).get("text")
            description = summary or place.get("formattedAddress") or "Nearby point of interest. Confirm access and current conditions before relying on it."
            landmarks[place_id] = {
                "id": f"{trip_id}-{place_id}", "tripId": trip_id,
                "name": (place.get("displayName") or {}).get("text", "Nearby point of interest"),
                "category": _place_category(types), "description": description,
                "position": position, "source": "google-places", "distanceFromRouteM": round(distance),
                "url": place.get("googleMapsUri"),
            }
    status = "complete" if successful_queries == len(requests) else "partial" if successful_queries else "unavailable"
    query_result = {"status": status, "successfulQueries": successful_queries, "totalQueries": len(requests)}
    return sorted(landmarks.values(), key=lambda item: item.get("distanceFromRouteM", 99999))[:40], query_result


def _solar_times(day: date, latitude: float, longitude: float, tz_name: str) -> dict[str, Any]:
    """NOAA-style sunrise/sunset estimate; weather-model timestamps supersede it when available."""
    def event(is_sunrise: bool):
        n = day.timetuple().tm_yday
        lng_hour = longitude / 15
        t = n + ((6 - lng_hour) / 24 if is_sunrise else (18 - lng_hour) / 24)
        mean = 0.9856 * t - 3.289
        true_long = (mean + 1.916 * math.sin(math.radians(mean)) + 0.020 * math.sin(2 * math.radians(mean)) + 282.634) % 360
        right_ascension = math.degrees(math.atan(0.91764 * math.tan(math.radians(true_long)))) % 360
        right_ascension += (math.floor(true_long / 90) * 90) - (math.floor(right_ascension / 90) * 90)
        right_ascension /= 15
        sin_dec = 0.39782 * math.sin(math.radians(true_long))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_hour = (math.cos(math.radians(90.833)) - sin_dec * math.sin(math.radians(latitude))) / (cos_dec * math.cos(math.radians(latitude)))
        if cos_hour > 1:
            return None, "polar_night"
        if cos_hour < -1:
            return None, "polar_day"
        hour_angle = (360 - math.degrees(math.acos(cos_hour)) if is_sunrise else math.degrees(math.acos(cos_hour))) / 15
        local_mean = hour_angle + right_ascension - 0.06571 * t - 6.622
        utc_hour = (local_mean - lng_hour) % 24
        hour = int(utc_hour); minute_float = (utc_hour - hour) * 60
        minute = int(minute_float); second = int(round((minute_float - minute) * 60))
        from datetime import timedelta
        utc_dt = datetime.combine(day, time(0, 0), tzinfo=timezone.utc) + timedelta(hours=hour, minutes=minute, seconds=second)
        try:
            return utc_dt.astimezone(ZoneInfo(tz_name)).isoformat(), "normal"
        except ZoneInfoNotFoundError:
            return utc_dt.isoformat(), "normal"
    sunrise, sun_state = event(True)
    sunset, set_state = event(False)
    status = "polar_day" if "polar_day" in (sun_state, set_state) else "polar_night" if "polar_night" in (sun_state, set_state) else "normal"
    daylight_minutes = None
    if sunrise and sunset:
        daylight_minutes = round((datetime.fromisoformat(sunset) - datetime.fromisoformat(sunrise)).total_seconds() / 60)
    elif status == "polar_day":
        daylight_minutes = 1440
    else:
        daylight_minutes = 0
    return {"sunrise": sunrise, "sunset": sunset, "daylightMinutes": daylight_minutes, "solarStatus": status, "timezone": tz_name, "method": "NOAA solar-position approximation"}


async def _fetch_weather_at(
    client: httpx.AsyncClient, coordinate: dict[str, float], departure_at: str | None
) -> dict[str, Any]:
    target_date = date.today()
    target_time = "09:00"
    requested_instant: datetime | None = None
    if departure_at:
        try:
            parsed = datetime.fromisoformat(departure_at.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                requested_instant = parsed
            else:
                # Backward compatibility for previously saved local-wall-clock requests.
                target_date = parsed.date()
                target_time = parsed.strftime("%H:%M")
        except ValueError:
            pass
    base = _solar_times(target_date, coordinate["lat"], coordinate["lng"], "UTC")
    params = {
        "latitude": coordinate["lat"], "longitude": coordinate["lng"], "timezone": "auto", "forecast_days": 16,
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,precipitation_sum,snowfall_sum,wind_gusts_10m_max,uv_index_max,sunrise,sunset,daylight_duration",
        "hourly": "temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,visibility,uv_index",
    }
    if OPEN_METEO_API_KEY:
        params["apikey"] = OPEN_METEO_API_KEY
    try:
        response = await client.get(OPEN_METEO_API_BASE_URL, params=params, timeout=httpx.Timeout(15.0, connect=5.0))
        response.raise_for_status()
        data = response.json()
    except Exception:
        return {
            "provider": "Open-Meteo", "forecastAvailable": False,
            "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED, **base,
            "forecastError": "Weather forecast could not be retrieved. Daylight values are astronomical estimates.",
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }

    timezone_name = data.get("timezone") or base.get("timezone", "UTC")
    if requested_instant is not None:
        try:
            target_local = requested_instant.astimezone(ZoneInfo(timezone_name))
            target_date = target_local.date()
            target_time = target_local.strftime("%H:%M")
        except (ZoneInfoNotFoundError, ValueError):
            pass

    daily = data.get("daily") or {}
    hourly = data.get("hourly") or {}
    dates = daily.get("time") or []
    try:
        day_index = dates.index(target_date.isoformat())
    except ValueError:
        return {
            "provider": "Open-Meteo", "forecastAvailable": False,
            "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED, **base,
            "forecastWindow": {"start": dates[0] if dates else None, "end": dates[-1] if dates else None},
            "note": "Forecast is not available for this trip date. Sunrise and sunset are calculated for the selected date.",
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
    hourly_times = hourly.get("time") or []
    hourly_index = next((i for i, value in enumerate(hourly_times) if value == f"{target_date.isoformat()}T{target_time}"), None)
    if hourly_index is None:
        hourly_index = next((i for i, value in enumerate(hourly_times) if value.startswith(target_date.isoformat())), None)

    def daily_value(key: str):
        values = daily.get(key) or []
        return values[day_index] if day_index < len(values) else None

    def hourly_value(key: str):
        values = hourly.get(key) or []
        return values[hourly_index] if hourly_index is not None and hourly_index < len(values) else None

    def localize_provider_datetime(value: str | None) -> str | None:
        if not value:
            return None
        try:
            parsed_value = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed_value.tzinfo is None:
                parsed_value = parsed_value.replace(tzinfo=ZoneInfo(timezone_name))
            return parsed_value.isoformat()
        except (ValueError, ZoneInfoNotFoundError):
            return value

    sunrise = localize_provider_datetime(daily_value("sunrise")) or localize_provider_datetime(base.get("sunrise"))
    sunset = localize_provider_datetime(daily_value("sunset")) or localize_provider_datetime(base.get("sunset"))
    daylight_seconds = daily_value("daylight_duration")
    daylight_minutes = round(float(daylight_seconds) / 60) if daylight_seconds is not None else base.get("daylightMinutes")
    condition = {
        "provider": "Open-Meteo", "forecastAvailable": True,
        "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED,
        "forecastDate": target_date.isoformat(), "departureLocalTime": target_time,
        "timezone": timezone_name,
        "temperatureC": hourly_value("temperature_2m"), "apparentTemperatureC": hourly_value("apparent_temperature"),
        "precipitationProbability": hourly_value("precipitation_probability"), "precipitationMm": hourly_value("precipitation"),
        "windKmh": hourly_value("wind_speed_10m"), "windGustKmh": hourly_value("wind_gusts_10m"),
        "visibilityM": hourly_value("visibility"), "uvIndex": hourly_value("uv_index"),
        "weatherCode": daily_value("weather_code"), "temperatureMaxC": daily_value("temperature_2m_max"),
        "temperatureMinC": daily_value("temperature_2m_min"), "apparentTemperatureMaxC": daily_value("apparent_temperature_max"),
        "precipitationProbabilityMax": daily_value("precipitation_probability_max"), "precipitationSumMm": daily_value("precipitation_sum"),
        "snowfallSumCm": daily_value("snowfall_sum"), "windGustMaxKmh": daily_value("wind_gusts_10m_max"),
        "uvIndexMax": daily_value("uv_index_max"), "sunrise": sunrise, "sunset": sunset,
        "daylightMinutes": daylight_minutes, "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    risks = []
    if (condition.get("windGustMaxKmh") or 0) >= 50: risks.append("Strong wind gusts forecast; exposed ridges and trees may be hazardous.")
    if (condition.get("precipitationProbabilityMax") or 0) >= 60: risks.append("High precipitation probability; expect wet or slippery surfaces.")
    if (condition.get("snowfallSumCm") or 0) >= 1: risks.append("Snowfall is forecast; check traction, visibility and temperature exposure.")
    if (condition.get("uvIndexMax") or 0) >= 8: risks.append("Very high UV index; plan sun protection and hydration.")
    if condition.get("weatherCode") in (95, 96, 99): risks.append("Thunderstorm signal in the model forecast; check official local warnings before departure.")
    condition["planningNotes"] = risks
    condition["solarStatus"] = base.get("solarStatus", "normal")
    return condition


async def _fetch_weather(client: httpx.AsyncClient, route: list[dict[str, float]], departure_at: str | None) -> dict[str, Any]:
    if not route:
        return {"provider": "Open-Meteo", "forecastAvailable": False, "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED, "note": "No route coordinates were available."}
    sample_points = [("Start", route[0]), ("Mid-route", route[len(route) // 2]), ("Finish", route[-1])]
    unique: list[tuple[str, dict[str, float]]] = []
    seen: set[tuple[int, int]] = set()
    for label, point in sample_points:
        key = (round(point["lat"] * 10000), round(point["lng"] * 10000))
        if key not in seen:
            seen.add(key)
            unique.append((label, point))
    results = await __import__("asyncio").gather(
        *(_fetch_weather_at(client, point, departure_at) for _, point in unique),
        return_exceptions=True,
    )
    samples = []
    for (label, point), result in zip(unique, results):
        if isinstance(result, Exception):
            continue
        samples.append({
            "label": label, "position": {"lat": point["lat"], "lng": point["lng"]},
            "temperatureC": result.get("temperatureC"),
            "precipitationProbabilityMax": result.get("precipitationProbabilityMax"),
            "windGustMaxKmh": result.get("windGustMaxKmh"),
            "weatherCode": result.get("weatherCode"), "forecastAvailable": result.get("forecastAvailable", False),
            "timezone": result.get("timezone"),
        })
    primary_result = next((result for (label, _), result in zip(unique, results) if label == "Mid-route" and isinstance(result, dict)), None)
    if not primary_result:
        primary_result = next((result for result in results if isinstance(result, dict)), None)
    if not primary_result:
        return {"provider": "Open-Meteo", "forecastAvailable": False, "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED, "routeSamples": samples, "forecastError": "Weather forecast could not be retrieved."}
    condition = dict(primary_result)
    condition["routeSamples"] = samples
    condition["routeCoverage"] = "start, midpoint and finish"
    available = [result for result in results if isinstance(result, dict) and result.get("forecastAvailable")]
    if available:
        for key in ("windGustMaxKmh", "precipitationProbabilityMax", "uvIndexMax", "snowfallSumCm", "precipitationSumMm"):
            values = [result.get(key) for result in available if isinstance(result.get(key), (int, float))]
            if values:
                condition[key] = max(values)
        max_temps = [result.get("temperatureMaxC") for result in available if isinstance(result.get("temperatureMaxC"), (int, float))]
        min_temps = [result.get("temperatureMinC") for result in available if isinstance(result.get("temperatureMinC"), (int, float))]
        if max_temps: condition["temperatureMaxC"] = max(max_temps)
        if min_temps: condition["temperatureMinC"] = min(min_temps)
        notes = []
        for result in available:
            notes.extend(result.get("planningNotes", []))
        condition["planningNotes"] = list(dict.fromkeys(notes))
    return condition


async def _enrich_trip(client: httpx.AsyncClient, route: list[dict[str, float]], trip_id: str, departure_at: str | None, encoded: str | None = None):
    encoded = encoded or encode_polyline(route)
    tasks = [
        _fetch_landmarks(client, route, trip_id, encoded),
        _fetch_ontario_trails(client, route),
        _fetch_us_national_trails(client, route),
        _fetch_configured_authority_trails(client, route),
        _fetch_weather(client, route, departure_at),
    ]
    (landmarks, places_query), otn_result, us_result, custom_result, weather = await __import__("asyncio").gather(*tasks)
    otn_matches, otn_access, otn_source = otn_result
    us_matches, us_sources = us_result
    custom_matches, custom_source = custom_result
    for landmark in otn_access:
        landmark["tripId"] = trip_id
        landmarks.append(landmark)
    sources = []
    if otn_source:
        sources.append(otn_source)
    sources.extend(us_sources)
    if custom_source:
        sources.append(custom_source)
    sources.append({
        "id": "google-places", "name": "Google Maps Platform – Places API (New)",
        "publisher": "Google", "url": "https://developers.google.com/maps/documentation/places/web-service/search-along-route",
        "license": "Google Maps Platform terms", "licenseUrl": "https://cloud.google.com/maps-platform/terms",
        "coverage": "Places search results biased to the route; filtered to 500 m straight-line distance", "checkedAt": datetime.now(timezone.utc).isoformat(),
        "queryStatus": places_query["status"], "successfulQueries": places_query["successfulQueries"],
    })
    sources.append({
        "id": "open-meteo", "name": "Open-Meteo Forecast API", "publisher": "Open-Meteo",
        "url": "https://open-meteo.com/en/docs", "license": "CC BY 4.0 data attribution; commercial subscription confirmed" if OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED else "CC BY 4.0 data attribution; free endpoint is non-commercial only", "licenseUrl": "https://open-meteo.com/en/terms",
        "coverage": "Forecast sampled at start, midpoint and finish; route-wide hazard aggregates", "checkedAt": weather.get("fetchedAt"),
        "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED,
    })
    matches = sorted(otn_matches + us_matches + custom_matches, key=lambda item: item.get("distanceFromRouteM", 99999))[:150]
    return landmarks[:80], matches, weather, sources, places_query


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "trail-api", "environment": APP_ENV}


@app.get("/api/config")
async def public_config() -> dict[str, Any]:
    """Only public browser configuration is returned here. Never expose the Maps server key."""
    return {
        "firebase": {
            "apiKey": os.getenv("FIREBASE_API_KEY", ""),
            "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
            "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
            "appId": os.getenv("FIREBASE_APP_ID", ""),
            "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
            "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
            "measurementId": os.getenv("FIREBASE_MEASUREMENT_ID", ""),
        },
        "appCheckSiteKey": os.getenv("FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY", ""),
        "appCheckEnforced": APP_CHECK_ENFORCED,
        "firebaseConfigured": bool(os.getenv("FIREBASE_API_KEY") and FIREBASE_PROJECT_ID and FIREBASE_APP_ID),
        "mapsConfigured": bool(MAPS_KEY),
        "aiModel": os.getenv("FIREBASE_AI_MODEL", "gemini-3.5-flash-lite"),
        "aiLocation": os.getenv("FIREBASE_AI_LOCATION", "global"),
        "mapStyleUrl": os.getenv("MAP_STYLE_URL", ""),
        "offlineTileHosts": os.getenv("OFFLINE_TILE_HOSTS", ""),
    }


def _estimated_duration_minutes(distance_m: float, activity: str, difficulty: str) -> int:
    base = {"hiking": 4.2, "trail-running": 8.0, "cycling": 15.0}.get(activity, 4.2)
    modifier = {"easy": 1.12, "moderate": 1.0, "strenuous": 0.82}.get(difficulty, 1.0)
    return max(1, round(distance_m / 1000 / (base * modifier) * 60))


def _offline_snapshot(
    route: list[dict[str, float]], landmarks: list[dict[str, Any]], trail_matches: list[dict[str, Any]],
    conditions: dict[str, Any], sources: list[dict[str, Any]], places_query: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Describe which trip-planning resources were successfully captured for local storage."""
    trail_source_ids = {"ontario-trail-network", "nps-public-trails", "usfs-national-forest-trails", "regional-authority"}
    trail_source_statuses = [str(source.get("queryStatus", "unknown")) for source in sources if source.get("id") in trail_source_ids]
    if not trail_source_statuses:
        trail_status = "no-coverage"
    elif "complete" in trail_source_statuses:
        trail_status = "complete"
    elif "partial" in trail_source_statuses:
        trail_status = "partial"
    else:
        trail_status = "unavailable"
    places_status = (places_query or {}).get("status", "unknown")
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "routeGeometryCaptured": len(route) >= 2,
        "pointsOfInterestResolved": places_status == "complete",
        "pointOfInterestSearchStatus": places_status,
        "pointOfInterestCount": len(landmarks),
        "trailNetworkChecked": trail_status == "complete",
        "trailNetworkCheckStatus": trail_status,
        "trailMatchCount": len(trail_matches),
        "environmentalContextCaptured": isinstance(conditions, dict) and bool(conditions),
        "sourceAttributionSaved": isinstance(sources, list) and bool(sources),
        # Basemap resources are a separate pack and are completed in the offline-map phase.
        "mapPackReady": False,
        "mapPackTileCount": 0,
    }


def _trip_payload(trip_id: str, payload: Any, route: list[dict[str, float]], distance_m: float, duration_min: int, elevation_gain: float, source: str, departure_at: str | None):
    return {
        "id": trip_id, "name": payload.name,
        "startLabel": payload.start, "endLabel": f"Loop via {payload.end}" if getattr(payload, "loop", False) else payload.end,
        "activity": payload.activity, "difficulty": payload.difficulty, "route": route,
        "distanceMeters": round(distance_m), "durationMinutes": duration_min, "elevationGainM": round(elevation_gain),
        "createdAt": int(__import__("time").time() * 1000), "updatedAt": int(__import__("time").time() * 1000),
        "isDemo": False, "readyForOffline": False, "routeSource": source, "departureAt": departure_at,
    }


@app.post("/api/trips/compile", dependencies=[Depends(require_app_check)])
async def compile_trip(payload: TripCompileRequest) -> dict[str, Any]:
    trip_id = str(uuid4())
    async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=8.0)) as client:
        compiled = await _request_route(client, payload)
        route, elevation_gain, elevation_profile = await _fetch_elevation(client, compiled["route"])
        landmarks, trail_matches, conditions, sources, places_query = await _enrich_trip(client, route, trip_id, payload.departure_at, compiled.get("encodedPolyline"))
    trip = _trip_payload(trip_id, payload, route, compiled["distanceMeters"], _estimated_duration_minutes(compiled["distanceMeters"], payload.activity, payload.difficulty), elevation_gain, "google-routes", payload.departure_at)
    trip["elevationProfile"] = elevation_profile
    trip["officialTrailMatches"] = trail_matches
    trip["conditions"] = conditions
    trip["dataSources"] = sources
    trip["offlineSnapshot"] = _offline_snapshot(route, landmarks, trail_matches, conditions, sources, places_query)
    return {
        "trip": trip, "landmarks": landmarks,
        "provider": "google-maps-platform+regional-trail-data+open-meteo",
        "notice": "Google route geometry is a route suggestion, not a certified hiking trail. Official trail matches are shown separately and do not automatically validate the entire route.",
    }


@app.post("/api/trips/compile-gpx", dependencies=[Depends(require_app_check)])
async def compile_gpx_trip(payload: GpxImportRequest) -> dict[str, Any]:
    trip_id = str(uuid4())
    try:
        imported = parse_gpx(payload.gpx_xml, trip_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    route = imported["route"]
    distance_m = imported["distanceMeters"]
    duration_min = _estimated_duration_minutes(distance_m, payload.activity, payload.difficulty)
    if not payload.start or payload.start == "Imported GPX start":
        payload.start = f"GPX start · {route[0]['lat']:.5f}, {route[0]['lng']:.5f}"
    if not payload.end or payload.end == "Imported GPX finish":
        payload.end = f"GPX finish · {route[-1]['lat']:.5f}, {route[-1]['lng']:.5f}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=8.0)) as client:
        landmarks, trail_matches, conditions, sources, places_query = await _enrich_trip(client, route, trip_id, payload.departure_at)
    # GPX-authored waypoints are kept even when provider POI discovery has no results.
    imported_waypoints = imported["landmarks"]
    for landmark in imported_waypoints:
        landmark["tripId"] = trip_id
        landmark["distanceFromRouteM"] = round(_route_distance(landmark["position"], route))
    landmarks = imported_waypoints + [item for item in landmarks if item["id"] not in {p["id"] for p in imported_waypoints}]
    trip = {
        "id": trip_id, "name": payload.name, "startLabel": payload.start, "endLabel": payload.end,
        "activity": payload.activity, "difficulty": payload.difficulty, "route": route,
        "distanceMeters": distance_m, "durationMinutes": duration_min, "elevationGainM": imported["elevationGainM"],
        "createdAt": int(__import__("time").time() * 1000), "updatedAt": int(__import__("time").time() * 1000),
        "isDemo": False, "readyForOffline": False, "routeSource": "gpx-import", "gpxFilename": payload.filename,
        "gpxTrackName": imported["name"], "gpxPointCount": imported["pointCount"], "departureAt": payload.departure_at,
        "officialTrailMatches": trail_matches, "conditions": conditions, "dataSources": sources + [{
            "id": "gpx-import", "name": f"User-imported GPX · {payload.filename}", "publisher": "User supplied",
            "url": "https://www.topografix.com/gpx/1/1/", "license": "User-supplied data; verify original licensing and usage permissions",
            "licenseUrl": "https://www.topografix.com/gpx/1/1/", "coverage": "Imported WGS84 GPX route", "checkedAt": datetime.now(timezone.utc).isoformat(),
        }],
        "elevationProfile": _elevation_profile_from_route(route),
        "offlineSnapshot": _offline_snapshot(route, landmarks, trail_matches, conditions, sources + [{"id": "gpx-import"}], places_query),
    }
    return {
        "trip": trip, "landmarks": landmarks, "provider": "gpx+regional-trail-data+open-meteo",
        "notice": "GPX route imported. OTN or configured authority matches indicate nearby mapped trail segments only; confirm alignment, permissions and current conditions with the managing organization.",
        "gpx": {"trackName": imported["name"], "pointCount": imported["pointCount"], "distanceMeters": distance_m},
    }


@app.get("/api/trails/sources")
async def trail_sources() -> dict[str, Any]:
    sources = [{
        "id": "ontario-trail-network", "name": "Ontario Trail Network (OTN)", "publisher": "Ontario Ministry of Natural Resources / Geospatial Ontario",
        "url": "https://data.ontario.ca/dataset/ontario-trail-network", "license": "Open Government Licence – Ontario",
        "licenseUrl": "https://www.ontario.ca/page/open-government-licence-ontario", "coverage": "Ontario, Canada", "configured": True,
    }, {
        "id": "open-meteo", "name": "Open-Meteo", "publisher": "Open-Meteo", "url": "https://open-meteo.com/en/docs",
        "license": "CC BY 4.0 data attribution; commercial subscription confirmed" if OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED else "CC BY 4.0 data attribution; free endpoint is non-commercial only", "licenseUrl": "https://open-meteo.com/en/terms", "coverage": "Forecast and daylight metadata", "configured": True, "commercialLicenseConfigured": OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED,
    }, {
        "id": "gpx-1.1", "name": "GPX 1.1", "publisher": "Topografix", "url": "https://www.topografix.com/gpx/1/1/",
        "license": "User-provided source route", "licenseUrl": "https://www.topografix.com/gpx/1/1/", "coverage": "User import", "configured": True,
    }]
    sources.extend([{
        "id": "nps-public-trails", "name": "National Park Service Public Trails", "publisher": "U.S. National Park Service",
        "url": "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
        "license": "See National Park Service data terms", "licenseUrl": "https://www.nps.gov/aboutus/disclaimer.htm", "coverage": "United States National Park System", "configured": True,
    }, {
        "id": "usfs-national-forest-trails", "name": "National Forest System Trails", "publisher": "USDA Forest Service",
        "url": "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublishWithDataStatus_01/MapServer/0",
        "license": "See USDA Forest Service data terms", "licenseUrl": "https://data.fs.usda.gov/geodata/edw/datasets.php", "coverage": "United States National Forest System", "configured": True,
    }])
    if TRAIL_AUTHORITY_LAYER_URL:
        sources.append({"id": "regional-authority", "name": TRAIL_AUTHORITY_SOURCE_NAME, "publisher": TRAIL_AUTHORITY_SOURCE_NAME, "url": TRAIL_AUTHORITY_LAYER_URL, "license": TRAIL_AUTHORITY_LICENSE_NAME, "licenseUrl": TRAIL_AUTHORITY_LICENSE_URL, "coverage": "Configured service", "configured": True})
    return {"sources": sources}


@app.post("/api/trips/guide-context", dependencies=[Depends(require_app_check)])
async def guide_context(payload: GuideContextRequest) -> dict[str, Any]:
    """Prepare a compact, validated guide context for Firebase AI Logic in the browser."""
    trip = payload.trip
    route = trip.get("route") or []
    route_sample = _sample_route(route, 12) if route else []
    safe_landmarks = []
    for place in payload.landmarks[:40]:
        position = place.get("position") or {}
        if not place.get("name") or not isinstance(position.get("lat"), (int, float)) or not isinstance(position.get("lng"), (int, float)):
            continue
        safe_landmarks.append({
            "name": str(place["name"])[:160],
            "category": str(place.get("category", "landmark"))[:32],
            "description": str(place.get("description", ""))[:500],
            "position": {"lat": float(position["lat"]), "lng": float(position["lng"])},
        })
    return {
        "season": payload.season,
        "routeSample": route_sample,
        "landmarks": safe_landmarks,
        "officialTrailMatches": trip.get("officialTrailMatches", [])[:40],
        "conditions": trip.get("conditions", {}),
        "dataSources": trip.get("dataSources", [])[:12],
        "trip": {key: trip.get(key) for key in ("name", "startLabel", "endLabel", "activity", "difficulty", "distanceMeters", "elevationGainM", "departureAt", "routeSource")},
        "fieldGuideTargetWords": {"minimum": 2000, "recommended": 2600, "maximum": 3200},
        "constraints": [
            "Do not invent live weather, trail closures, facilities, species presence, or water availability.",
            "Differentiate verified points of interest from general regional guidance.",
            "State uncertainty and include conservative outdoor safety advice.",
        ],
    }


# Trail is a conventional Python web application. Templates and static assets live
# inside the FastAPI package; there is no separate frontend application directory.
APP_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"

app.mount("/js", StaticFiles(directory=STATIC_DIR / "js"), name="trail-js")
app.mount("/css", StaticFiles(directory=STATIC_DIR / "css"), name="trail-css")
app.mount("/icons", StaticFiles(directory=STATIC_DIR / "icons"), name="trail-icons")


@app.get("/manifest.webmanifest", include_in_schema=False)
async def web_app_manifest():
    return FileResponse(
        STATIC_DIR / "manifest.webmanifest",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/service-worker.js", include_in_schema=False)
async def service_worker():
    # A root-scoped worker must be served from the root URL with an explicit scope.
    return FileResponse(
        STATIC_DIR / "service-worker.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@app.get("/offline.html", include_in_schema=False)
async def offline_fallback():
    return FileResponse(TEMPLATES_DIR / "offline.html", media_type="text/html")


@app.get("/index.html", include_in_schema=False)
async def index_document():
    return FileResponse(TEMPLATES_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
async def home_document():
    return FileResponse(TEMPLATES_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_pwa_routes(full_path: str):
    # Unknown API paths must stay JSON 404s, never the PWA HTML fallback.
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    # This is a small client-routed PWA. Unknown browser navigation paths return
    # the application shell; real static files are served by the mounts above.
    if "." in Path(full_path).name:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return FileResponse(TEMPLATES_DIR / "index.html", media_type="text/html")
