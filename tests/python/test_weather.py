from datetime import date

import pytest

from app import main as trail_api


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


class FakeWeatherClient:
    def __init__(self):
        self.calls = []

    async def get(self, url, params, timeout):
        self.calls.append((url, dict(params)))
        index = len(self.calls)
        day = "2026-11-15"
        return FakeResponse({
            "timezone": "America/Toronto",
            "daily": {
                "time": [day], "weather_code": [61],
                "temperature_2m_max": [8 + index], "temperature_2m_min": [1 - index],
                "apparent_temperature_max": [5], "precipitation_probability_max": [40 + index * 10],
                "precipitation_sum": [2 * index], "snowfall_sum": [0],
                "wind_gusts_10m_max": [25 + index * 10], "uv_index_max": [2],
                "sunrise": [f"{day}T07:30"], "sunset": [f"{day}T17:00"], "daylight_duration": [34200],
            },
            "hourly": {
                "time": [f"{day}T08:00"], "temperature_2m": [4 + index],
                "apparent_temperature": [2], "precipitation_probability": [30],
                "precipitation": [0], "wind_speed_10m": [12], "wind_gusts_10m": [20 + index],
                "visibility": [10000], "uv_index": [1],
            },
        })


@pytest.mark.asyncio
async def test_route_weather_samples_start_midpoint_finish_and_aggregates(monkeypatch):
    monkeypatch.setattr(trail_api, "OPEN_METEO_API_KEY", "paid-license-key")
    monkeypatch.setattr(trail_api, "OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED", True)
    monkeypatch.setattr(trail_api, "OPEN_METEO_API_BASE_URL", "https://customer-api.open-meteo.com/v1/forecast")
    client = FakeWeatherClient()
    route = [
        {"lat": 43.60, "lng": -79.40},
        {"lat": 43.65, "lng": -79.35},
        {"lat": 43.70, "lng": -79.30},
    ]
    result = await trail_api._fetch_weather(client, route, "2026-11-15T08:00")
    assert len(client.calls) == 3
    assert all(url.startswith("https://customer-api.open-meteo.com/") for url, _ in client.calls)
    assert all(params["apikey"] == "paid-license-key" for _, params in client.calls)
    assert [sample["label"] for sample in result["routeSamples"]] == ["Start", "Mid-route", "Finish"]
    assert result["routeCoverage"] == "start, midpoint and finish"
    assert result["commercialLicenseConfigured"] is True
    assert result["precipitationProbabilityMax"] == 70
    assert result["windGustMaxKmh"] == 55
    assert result["forecastAvailable"] is True
    assert result["sunrise"].endswith("-05:00")


@pytest.mark.asyncio
async def test_weather_free_endpoint_is_marked_noncommercial(monkeypatch):
    monkeypatch.setattr(trail_api, "OPEN_METEO_API_KEY", "")
    monkeypatch.setattr(trail_api, "OPEN_METEO_COMMERCIAL_LICENSE_CONFIRMED", False)
    monkeypatch.setattr(trail_api, "OPEN_METEO_API_BASE_URL", "https://api.open-meteo.com/v1/forecast")
    result = await trail_api._fetch_weather(FakeWeatherClient(), [
        {"lat": 43.60, "lng": -79.40},
        {"lat": 43.65, "lng": -79.35},
        {"lat": 43.70, "lng": -79.30},
    ], "2026-11-15T08:00")
    assert result["commercialLicenseConfigured"] is False


@pytest.mark.asyncio
async def test_aware_departure_is_converted_to_forecast_location_timezone():
    client = FakeWeatherClient()
    result = await trail_api._fetch_weather_at(
        client,
        {"lat": 43.65, "lng": -79.38},
        "2026-11-15T13:00:00+00:00",
    )
    assert result["timezone"] == "America/Toronto"
    assert result["departureLocalTime"] == "08:00"
    assert result["sunrise"].endswith("-05:00")
