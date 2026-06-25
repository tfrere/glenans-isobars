"""Historical isobar timeline.

Fetches ~1 year of daily (12:00 UTC) mean-sea-level pressure and 10 m wind
from the Open-Meteo Archive API (ERA5 reanalysis) on a coarse grid, then
serves it as a list of frames the frontend can scrub through.

The build runs once in the background on startup and is cached to disk, so a
warm container answers instantly.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
from pathlib import Path

import httpx

from geo import BBOX, GLENANS, ISOBAR_STEP, build_grid_points

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Coarser grid than the live view: kept light to stay within the free
# Open-Meteo rate limits over a full year of data.
HNX = 15  # columns
HNY = 10  # rows
ERA5_LATENCY_DAYS = 6  # reanalysis is not available for the very last days
CHUNK_DELAY_S = 2.0  # politeness delay between monthly requests
MAX_RETRIES = 5

_CACHE_DIR = Path(__file__).parent / "cache"
_HLATS, _HLONS = build_grid_points(HNX, HNY)

# Module state shared with the API layer.
_state: dict = {"status": "idle", "error": None, "progress": 0.0}
_data: dict | None = None
_build_task: asyncio.Task | None = None


def _date_range() -> tuple[dt.date, dt.date]:
    end = dt.date.today() - dt.timedelta(days=ERA5_LATENCY_DAYS)
    start = end - dt.timedelta(days=364)
    return start, end


def _cache_path(start: dt.date, end: dt.date) -> Path:
    return _CACHE_DIR / f"history_{start.isoformat()}_{end.isoformat()}.json"


def _month_chunks(start: dt.date, end: dt.date) -> list[tuple[dt.date, dt.date]]:
    chunks: list[tuple[dt.date, dt.date]] = []
    cur = start
    while cur <= end:
        if cur.month == 12:
            nxt = dt.date(cur.year + 1, 1, 1)
        else:
            nxt = dt.date(cur.year, cur.month + 1, 1)
        chunk_end = min(nxt - dt.timedelta(days=1), end)
        chunks.append((cur, chunk_end))
        cur = nxt
    return chunks


async def _fetch_chunk(
    client: httpx.AsyncClient,
    start: dt.date,
    end: dt.date,
) -> dict[str, dict]:
    """Return {date_iso: {values, windSpeed, windDirection}} for noon samples."""
    params = {
        "latitude": ",".join(str(v) for v in _HLATS),
        "longitude": ",".join(str(v) for v in _HLONS),
        "hourly": "pressure_msl,wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "kn",
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "cell_selection": "nearest",
        "timezone": "UTC",
    }
    # Retry with exponential backoff on rate limiting (429) or transient errors.
    payload = None
    for attempt in range(MAX_RETRIES):
        resp = await client.get(ARCHIVE_URL, params=params, timeout=120)
        if resp.status_code == 429:
            await asyncio.sleep(2 ** attempt * 3)
            continue
        resp.raise_for_status()
        payload = resp.json()
        break
    if payload is None:
        raise RuntimeError("Open-Meteo archive rate limit: giving up after retries")
    points = payload if isinstance(payload, list) else [payload]

    # Indices of the 12:00 samples (identical time axis across locations).
    times: list[str] = points[0].get("hourly", {}).get("time", [])
    noon_idx = [k for k, t in enumerate(times) if t.endswith("12:00")]
    dates = [times[k][:10] for k in noon_idx]

    frames: dict[str, dict] = {
        d: {"values": [], "windSpeed": [], "windDirection": []} for d in dates
    }
    for p in points:
        h = p.get("hourly", {})
        msl = h.get("pressure_msl", [])
        ws = h.get("wind_speed_10m", [])
        wd = h.get("wind_direction_10m", [])
        for d, k in zip(dates, noon_idx):
            frames[d]["values"].append(round(float(msl[k] or 1013.0), 1))
            frames[d]["windSpeed"].append(round(float(ws[k] or 0.0), 1))
            frames[d]["windDirection"].append(round(float(wd[k] or 0.0)))
    return frames


async def _build() -> None:
    global _data
    start, end = _date_range()
    path = _cache_path(start, end)

    if path.is_file():
        _data = json.loads(path.read_text())
        _state.update(status="ready", progress=1.0)
        return

    _state.update(status="building", error=None, progress=0.0)
    chunks = _month_chunks(start, end)
    merged: dict[str, dict] = {}

    # Sequential requests with a small delay to respect free-tier rate limits.
    async with httpx.AsyncClient() as client:
        for k, (c0, c1) in enumerate(chunks):
            merged.update(await _fetch_chunk(client, c0, c1))
            _state["progress"] = round((k + 1) / len(chunks), 3)
            if k < len(chunks) - 1:
                await asyncio.sleep(CHUNK_DELAY_S)

    dates = sorted(merged.keys())
    frames = [merged[d] for d in dates]

    _data = {
        "bbox": BBOX,
        "nx": HNX,
        "ny": HNY,
        "step": ISOBAR_STEP,
        "glenans": GLENANS,
        "source": "ERA5 (Open-Meteo Archive)",
        "dates": dates,
        "frames": frames,
    }

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_data, separators=(",", ":")))
    _state.update(status="ready", progress=1.0)


def start_build() -> None:
    global _build_task
    if _build_task is not None:
        return

    async def _runner() -> None:
        try:
            await _build()
        except Exception as exc:  # noqa: BLE001
            _state.update(status="error", error=str(exc))

    _build_task = asyncio.create_task(_runner())


def get_status_payload() -> dict:
    if _state["status"] == "ready" and _data is not None:
        return {"status": "ready", **_data}
    return {
        "status": _state["status"],
        "progress": _state["progress"],
        "error": _state["error"],
    }
