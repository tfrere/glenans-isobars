"""Glénans isobars - minimal FastAPI backend.

Fetches mean-sea-level pressure (MSLP) on a regular grid around the Glénans
archipelago from Open-Meteo (ECMWF IFS model), caches it, and serves it as a
compact JSON payload. Also serves the built Vite frontend as static files.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from geo import BBOX, GLENANS, ISOBAR_STEP, build_grid_points
import history as history_module

# --- Live grid configuration ---

NX = 29  # columns (west -> east)
NY = 17  # rows (north -> south)

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
MODEL = "ecmwf_ifs025"
CACHE_TTL_SECONDS = 30 * 60  # refresh at most every 30 minutes

_LATS, _LONS = build_grid_points(NX, NY)

# --- Simple in-memory cache ---

_cache: dict | None = None
_cache_ts: float = 0.0


async def fetch_grid() -> dict:
    params = {
        "latitude": ",".join(str(v) for v in _LATS),
        "longitude": ",".join(str(v) for v in _LONS),
        "current": "pressure_msl,wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "kn",  # knots, the meteorological standard for barbs
        "models": MODEL,
        "cell_selection": "nearest",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(OPEN_METEO_URL, params=params)
        resp.raise_for_status()
        data = resp.json()

    points = data if isinstance(data, list) else [data]
    values: list[float] = []
    wind_speed: list[float] = []
    wind_dir: list[float] = []
    updated_at = ""
    for p in points:
        current = p.get("current") or {}
        v = current.get("pressure_msl")
        ws = current.get("wind_speed_10m")
        wd = current.get("wind_direction_10m")
        if not isinstance(v, (int, float)):
            raise ValueError("Missing pressure_msl in Open-Meteo response")
        values.append(float(v))
        wind_speed.append(float(ws) if isinstance(ws, (int, float)) else 0.0)
        wind_dir.append(float(wd) if isinstance(wd, (int, float)) else 0.0)
        if not updated_at and current.get("time"):
            updated_at = current["time"]

    if len(values) != NX * NY:
        raise ValueError(f"Expected {NX * NY} grid points, got {len(values)}")

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


app = FastAPI(title="Glénans Isobars API", version="0.1.0")


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
