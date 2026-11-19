from __future__ import annotations

import math
import re
from typing import Any
from defusedxml import ElementTree as SafeET

EARTH_RADIUS_M = 6_371_008.8


def haversine(a: dict[str, float], b: dict[str, float]) -> float:
    p1, p2 = math.radians(a["lat"]), math.radians(b["lat"])
    dp = math.radians(b["lat"] - a["lat"])
    dl = math.radians(b["lng"] - a["lng"])
    value = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(value))


def encode_polyline(points: list[dict[str, float]]) -> str:
    last_lat = last_lng = 0
    output: list[str] = []
    for point in points:
        lat = round(point["lat"] * 1e5)
        lng = round(point["lng"] * 1e5)
        for value in (lat - last_lat, lng - last_lng):
            value = ~(value << 1) if value < 0 else value << 1
            while value >= 0x20:
                output.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            output.append(chr(value + 63))
        last_lat, last_lng = lat, lng
    return "".join(output)


def _point_segment_distance_m(point: dict[str, float], start: dict[str, float], end: dict[str, float]) -> float:
    # Equirectangular projection around the query point is accurate enough for a 500 m corridor.
    lat_scale = 111_320.0
    lng_scale = max(0.01, math.cos(math.radians(point["lat"]))) * lat_scale
    ax, ay = (start["lng"] - point["lng"]) * lng_scale, (start["lat"] - point["lat"]) * lat_scale
    bx, by = (end["lng"] - point["lng"]) * lng_scale, (end["lat"] - point["lat"]) * lat_scale
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / denom))
    return math.hypot(ax + t * dx, ay + t * dy)


def distance_to_route(point: dict[str, float], route: list[dict[str, float]]) -> float:
    if not route:
        return float("inf")
    if len(route) == 1:
        return haversine(point, route[0])
    return min(_point_segment_distance_m(point, route[i - 1], route[i]) for i in range(1, len(route)))


def parse_gpx(xml_text: str, trip_id: str) -> dict[str, Any]:
    if len(xml_text) > 2_000_000:
        raise ValueError("GPX file exceeds the 2 MB import limit.")
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", xml_text, flags=re.IGNORECASE):
        raise ValueError("GPX files containing document types or entity declarations are not accepted.")
    try:
        root = SafeET.fromstring(xml_text)
    except Exception as exc:
        raise ValueError("The selected file is not valid GPX/XML.") from exc

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    if local(root.tag) != "gpx":
        raise ValueError("The uploaded file is not a GPX document.")
    version = root.attrib.get("version")
    if version not in ("1.0", "1.1"):
        raise ValueError("Only GPX 1.0 and GPX 1.1 files are supported.")

    def children_named(node, name: str):
        return [child for child in list(node) if local(child.tag) == name]

    def read_point(node) -> dict[str, float] | None:
        try:
            lat, lng = float(node.attrib["lat"]), float(node.attrib["lon"])
        except (KeyError, ValueError):
            return None
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return None
        point: dict[str, float] = {"lat": lat, "lng": lng}
        for child in list(node):
            if local(child.tag) == "ele":
                try:
                    point["altitude"] = float(child.text or "")
                except ValueError:
                    pass
        return point

    routes: list[tuple[str, list[dict[str, float]]]] = []
    for route in children_named(root, "rte"):
        points = [p for node in children_named(route, "rtept") if (p := read_point(node))]
        if len(points) >= 2:
            name = next((child.text for child in list(route) if local(child.tag) == "name" and child.text), "GPX route")
            routes.append((name, points))

    for track in children_named(root, "trk"):
        name = next((child.text for child in list(track) if local(child.tag) == "name" and child.text), "GPX track")
        segments = []
        for segment in children_named(track, "trkseg"):
            points = [p for node in children_named(segment, "trkpt") if (p := read_point(node))]
            if len(points) >= 2:
                segments.append(points)
        if segments:
            # A disconnected GPX track must not be silently bridged by a straight line.
            if len(segments) > 1:
                gaps = [haversine(segments[i - 1][-1], segments[i][0]) for i in range(1, len(segments))]
                if any(gap > 50 for gap in gaps):
                    raise ValueError("This GPX track contains disconnected segments. Export one continuous route/track or import each segment separately.")
            points = []
            for segment in segments:
                points.extend(segment if not points else segment[1:])
            routes.append((name, points))

    if not routes:
        raise ValueError("No usable GPX route or track with at least two valid coordinates was found.")
    name, route_points = max(routes, key=lambda item: len(item[1]))
    if len(route_points) > 100_000:
        raise ValueError("The GPX route contains more than 100,000 points. Simplify it before importing.")

    waypoints = []
    for index, node in enumerate(children_named(root, "wpt")):
        position = read_point(node)
        if not position:
            continue
        fields = {local(child.tag): (child.text or "").strip() for child in list(node)}
        waypoint_name = fields.get("name") or fields.get("sym") or f"GPX waypoint {index + 1}"
        waypoints.append({
            "id": f"{trip_id}-gpx-{index + 1}", "tripId": trip_id, "name": waypoint_name[:160],
            "category": "landmark", "description": (fields.get("desc") or fields.get("cmt") or "Waypoint imported from the supplied GPX file.")[:500],
            "position": position, "source": "gpx-import",
        })
    total_distance = sum(haversine(route_points[i - 1], route_points[i]) for i in range(1, len(route_points)))
    altitude_values = [point["altitude"] for point in route_points if "altitude" in point]
    elevation_gain = sum(max(0.0, altitude_values[i] - altitude_values[i - 1]) for i in range(1, len(altitude_values)))
    return {
        "name": name, "route": route_points, "landmarks": waypoints,
        "distanceMeters": round(total_distance), "elevationGainM": round(elevation_gain),
        "pointCount": len(route_points),
    }
