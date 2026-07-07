"""Glénans isobars - minimal FastAPI backend.

Fetches mean-sea-level pressure (MSLP) on a regular grid around the Glénans
archipelago from Open-Meteo (ECMWF IFS model), caches it, and serves it as a
compact JSON payload. Also serves the built Vite frontend as static files.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from geo import BBOX, GLENANS, ISOBAR_STEP, build_grid_points
from fronts_detect import detect_fronts, detect_troughs
import history as history_module

# --- Live grid configuration ---

NX = 35  # columns (west -> east)
NY = 20  # rows (north -> south)

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
MODEL = "ecmwf_ifs025"
CACHE_TTL_SECONDS = 30 * 60  # refresh at most every 30 minutes
# Open-Meteo takes coordinate lists in the URL; too many points overflow the
# server's URI limit (HTTP 414), so we split the grid into batches.
CHUNK_POINTS = 300

_LATS, _LONS = build_grid_points(NX, NY)

# --- Simple in-memory cache ---

_cache: dict | None = None
_cache_ts: float = 0.0


async def _fetch_points(
    client: httpx.AsyncClient,
    lats: list[float],
    lons: list[float],
) -> list[dict]:
    params = {
        "latitude": ",".join(str(v) for v in lats),
        "longitude": ",".join(str(v) for v in lons),
        # 850 hPa temperature + relative humidity feed the objective frontal
        # analysis (theta-e / Hewson TFP); the 10 m wind gives the advection sign.
        "current": (
            "pressure_msl,wind_speed_10m,wind_direction_10m,"
            "temperature_850hPa,relative_humidity_850hPa"
        ),
        "wind_speed_unit": "kn",  # knots, the meteorological standard for barbs
        "models": MODEL,
        "cell_selection": "nearest",
    }
    # Retry with exponential backoff on rate limiting (HTTP 429).
    for attempt in range(4):
        resp = await client.get(OPEN_METEO_URL, params=params)
        if resp.status_code == 429:
            await asyncio.sleep(2**attempt)
            continue
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else [data]
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else [data]


async def fetch_grid() -> dict:
    total = NX * NY
    spans = [(s, min(s + CHUNK_POINTS, total)) for s in range(0, total, CHUNK_POINTS)]
    async with httpx.AsyncClient(timeout=30) as client:
        results = await asyncio.gather(
            *(_fetch_points(client, _LATS[a:b], _LONS[a:b]) for a, b in spans)
        )
    # Concatenate batches back in grid order.
    points: list[dict] = [p for chunk in results for p in chunk]

    values: list[float] = []
    wind_speed: list[float] = []
    wind_dir: list[float] = []
    temp850: list[float] = []
    rh850: list[float] = []
    updated_at = ""

    def _num(x: object, default: float = 0.0) -> float:
        return float(x) if isinstance(x, (int, float)) else default

    for p in points:
        current = p.get("current") or {}
        v = current.get("pressure_msl")
        if not isinstance(v, (int, float)):
            raise ValueError("Missing pressure_msl in Open-Meteo response")
        values.append(float(v))
        wind_speed.append(_num(current.get("wind_speed_10m")))
        wind_dir.append(_num(current.get("wind_direction_10m")))
        temp850.append(_num(current.get("temperature_850hPa")))
        rh850.append(_num(current.get("relative_humidity_850hPa"), 50.0))
        if not updated_at and current.get("time"):
            updated_at = current["time"]

    if len(values) != NX * NY:
        raise ValueError(f"Expected {NX * NY} grid points, got {len(values)}")

    # Objective fronts (theta-e + Hewson TFP) + dashed pressure troughs,
    # computed server-side so the frontend only renders the resulting geometry.
    fronts = detect_fronts(temp850, rh850, wind_speed, wind_dir, BBOX, NX, NY)
    fronts += detect_troughs(values, BBOX, NX, NY)

    return {
        "bbox": BBOX,
        "nx": NX,
        "ny": NY,
        "step": ISOBAR_STEP,
        "glenans": GLENANS,
        "model": MODEL,
        "values": values,
        "windSpeed": wind_speed,  # knots
        "windDirection": wind_dir,  # degrees, direction the wind comes FROM
        "fronts": fronts,  # objective cold/warm front polylines
        "min": min(values),
        "max": max(values),
        "updatedAt": updated_at,
    }


async def get_grid() -> dict:
    global _cache, _cache_ts
    now = time.time()
    if _cache is not None and (now - _cache_ts) < CACHE_TTL_SECONDS:
        return _cache
    try:
        _cache = await fetch_grid()
        _cache_ts = now
        return _cache
    except Exception as exc:  # noqa: BLE001
        if _cache is not None:
            return _cache  # serve stale data rather than failing
        raise HTTPException(status_code=502, detail=str(exc)) from exc


app = FastAPI(title="Glénans Isobars API", version="0.2.0")


@app.get("/api/isobars")
async def isobars() -> dict:
    return await get_grid()


@app.get("/api/history")
async def history() -> dict:
    return history_module.get_status_payload()


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.on_event("startup")
async def _startup() -> None:
    # Build the historical timeline in the background so the live view is
    # available immediately and history becomes ready a bit later.
    history_module.start_build()


# --- Static frontend (Vite build output) ---

_DIST = Path(__file__).parent / "static"
if _DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str) -> FileResponse:
        candidate = _DIST / path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "7860"))
    uvicorn.run(app, host="0.0.0.0", port=port)
