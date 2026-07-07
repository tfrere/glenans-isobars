"""Historical isobar timeline.

One *rolling* year of daily (12:00 UTC) mean-sea-level pressure and 10 m wind
from the Open-Meteo Archive API (ERA5 reanalysis) on a coarse grid, served as
frames the frontend can scrub through. The window always ends on "today" and
spans the last `HISTORY_DAYS` days.

To stay cheap on the Open-Meteo rate limit, the dataset is refreshed
*incrementally*: an existing dataset is reused for the overlapping days and only
the missing recent days are fetched. A dataset whose last day is within
`ARCHIVE_LAG_DAYS` of today is considered fresh and served as-is (just trimmed to
the rolling window). The pre-built file lives in `server/data/`.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from pathlib import Path

import httpx

from geo import BBOX, GLENANS, ISOBAR_STEP, build_grid_points
from fronts_detect import detect_fronts, detect_troughs

# Mean-sea-level pressure and 10 m wind come from the ERA5 archive (fast,
# lenient rate limits). The 850 hPa temperature used for fronts is NOT exposed
# by the ERA5 archive, so it is fetched from the Historical Forecast API, which
# archives model runs including pressure-level variables.
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HFORECAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"

# Coarse grid: kept light so the one-off build stays within the free
# Open-Meteo rate limits over a full year of data.
HNX = 17  # columns
HNY = 10  # rows

# Rolling window: the last HISTORY_DAYS days, ending today.
HISTORY_DAYS = 365
# A dataset whose newest day is within this many days of today is "fresh enough"
# (the archive itself lags reality by a couple of days), so we serve it without
# hitting the API again.
ARCHIVE_LAG_DAYS = 5


def _window(today: dt.date | None = None) -> tuple[dt.date, dt.date]:
    """(start, end) of the rolling window ending today, inclusive."""
    end = today or dt.date.today()
    start = end - dt.timedelta(days=HISTORY_DAYS - 1)
    return start, end

# The historical-forecast endpoint is slow (~3 min) for a full month over the
# whole grid, so requests run concurrently (bounded) with a generous timeout.
REQUEST_TIMEOUT_S = 300.0
MAX_CONCURRENCY = 3
MAX_RETRIES = 6
# The 850 hPa pressure-level endpoint chokes (server-side streaming timeout) on
# the full 170-point grid, so its requests are split into point batches.
HF_POINT_BATCH = 40

# Pre-built dataset lives here and is committed to the repo / image.
_DATA_DIR = Path(__file__).parent / "data"
# Per-month cache so a build interrupted by a rate limit can resume.
_CHUNK_DIR = _DATA_DIR / "_chunks"
_HLATS, _HLONS = build_grid_points(HNX, HNY)

# Module state shared with the API layer.
_state: dict = {"status": "idle", "error": None, "progress": 0.0}
_data: dict | None = None
_build_task: asyncio.Task | None = None


def _dataset_path(start: dt.date, end: dt.date) -> Path:
    # Window + grid + variable set in the name so a config change (e.g. moving
    # to server-side objective fronts) produces a fresh file.
    return (
        _DATA_DIR
        / f"history_{start.isoformat()}_{end.isoformat()}_{HNX}x{HNY}_fronts.json"
    )


def _existing_dataset() -> Path | None:
    """Newest pre-built dataset for the current grid (ISO dates sort = newest last)."""
    cands = sorted(_DATA_DIR.glob(f"history_*_{HNX}x{HNY}_fronts.json"))
    return cands[-1] if cands else None


def _trim_to_window(data: dict, start: dt.date, end: dt.date) -> dict:
    """Keep only the frames whose date falls in [start, end]."""
    s, e = start.isoformat(), end.isoformat()
    meta = {k: v for k, v in data.items() if k not in ("dates", "frames", "status")}
    dates: list[str] = []
    frames: list[dict] = []
    for d, fr in zip(data.get("dates", []), data.get("frames", [])):
        if s <= d <= e:
            dates.append(d)
            frames.append(fr)
    return {**meta, "dates": dates, "frames": frames}


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


async def _request_points(
    client: httpx.AsyncClient,
    url: str,
    params: dict,
) -> list[dict]:
    """GET with retry/backoff; return the list of points.

    Retries on transient failures: timeouts/transport errors, HTTP 429 (rate
    limit), HTTP 5xx (the historical-forecast endpoint intermittently returns
    500 "Something went wrong"), empty/non-JSON bodies, and 200 responses
    carrying an Open-Meteo ``{"error": true}`` payload.
    """
    payload = None
    for attempt in range(MAX_RETRIES):
        backoff = min(2 ** attempt * 3, 60)
        try:
            resp = await client.get(url, params=params, timeout=REQUEST_TIMEOUT_S)
        except (httpx.TimeoutException, httpx.TransportError):
            await asyncio.sleep(backoff)
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            await asyncio.sleep(backoff)
            continue
        if resp.status_code >= 400:
            resp.raise_for_status()
        try:
            data = resp.json()
        except (json.JSONDecodeError, ValueError):
            await asyncio.sleep(backoff)
            continue
        if isinstance(data, dict) and data.get("error"):
            await asyncio.sleep(backoff)
            continue
        payload = data
        break
    if payload is None:
        raise RuntimeError("Open-Meteo: giving up after retries (rate limit / 5xx)")
    return payload if isinstance(payload, list) else [payload]


def _noon_indices(points: list[dict]) -> tuple[list[int], list[str]]:
    """Indices of 12:00 samples and their dates (time axis is shared)."""
    times: list[str] = points[0].get("hourly", {}).get("time", [])
    idx = [k for k, t in enumerate(times) if t.endswith("12:00")]
    return idx, [times[k][:10] for k in idx]


async def _fetch_chunk(
    client: httpx.AsyncClient,
    start: dt.date,
    end: dt.date,
) -> dict[str, dict]:
    """Return {date_iso: {values, windSpeed, windDirection, temp850, rh850}} at noon."""
    common = {
        "latitude": ",".join(str(v) for v in _HLATS),
        "longitude": ",".join(str(v) for v in _HLONS),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "cell_selection": "nearest",
        "timezone": "UTC",
    }

    # --- MSLP + 10 m wind from the ERA5 archive -----------------------------
    pts = await _request_points(
        client,
        ARCHIVE_URL,
        {
            **common,
            "hourly": "pressure_msl,wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "kn",
        },
    )
    noon_idx, dates = _noon_indices(pts)
    frames: dict[str, dict] = {
        d: {"values": [], "windSpeed": [], "windDirection": [], "temp850": [], "rh850": []}
        for d in dates
    }
    for p in pts:
        h = p.get("hourly", {})
        msl = h.get("pressure_msl", [])
        ws = h.get("wind_speed_10m", [])
        wd = h.get("wind_direction_10m", [])
        for d, k in zip(dates, noon_idx):
            frames[d]["values"].append(round(float(msl[k] or 1013.0), 1))
            frames[d]["windSpeed"].append(round(float(ws[k] or 0.0), 1))
            frames[d]["windDirection"].append(round(float(wd[k] or 0.0)))

    # --- 850 hPa temperature + relative humidity from the Historical Forecast
    # API (the ERA5 archive does not serve pressure levels). Both feed the
    # theta-e used for objective front detection. Split into point batches so
    # each request stays light enough for the endpoint's streaming timeout;
    # batches keep coordinate order, so the concatenation matches the grid.
    tpts: list[dict] = []
    n_pts = len(_HLATS)
    for b in range(0, n_pts, HF_POINT_BATCH):
        sub = range(b, min(b + HF_POINT_BATCH, n_pts))
        part = await _request_points(
            client,
            HFORECAST_URL,
            {
                **common,
                "latitude": ",".join(str(_HLATS[i]) for i in sub),
                "longitude": ",".join(str(_HLONS[i]) for i in sub),
                "hourly": "temperature_850hPa,relative_humidity_850hPa",
            },
        )
        tpts.extend(part)
    tnoon, tdates = _noon_indices(tpts)
    tmap: dict[str, list[float]] = {d: [] for d in tdates}
    rmap: dict[str, list[float]] = {d: [] for d in tdates}
    for p in tpts:
        hh = p.get("hourly", {})
        t = hh.get("temperature_850hPa", [])
        rh = hh.get("relative_humidity_850hPa", [])
        for d, k in zip(tdates, tnoon):
            tval = t[k] if k < len(t) and t[k] is not None else 0.0
            rval = rh[k] if k < len(rh) and rh[k] is not None else 50.0
            tmap[d].append(round(float(tval), 1))
            rmap[d].append(round(float(rval), 1))
    for d in frames:
        frames[d]["temp850"] = tmap.get(d, [])
        frames[d]["rh850"] = rmap.get(d, [])

    return frames


def _chunk_cache_path(c0: dt.date, c1: dt.date) -> Path:
    return _CHUNK_DIR / f"chunk_{c0.isoformat()}_{c1.isoformat()}_{HNX}x{HNY}.json"


async def _fetch_chunk_cached(
    client: httpx.AsyncClient,
    c0: dt.date,
    c1: dt.date,
) -> dict[str, dict]:
    """Like _fetch_chunk but memoised on disk so builds are resumable."""
    cp = _chunk_cache_path(c0, c1)
    if cp.is_file():
        return json.loads(cp.read_text())
    res = await _fetch_chunk(client, c0, c1)
    _CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    cp.write_text(json.dumps(res, separators=(",", ":")))
    return res


def _augment_troughs(data: dict) -> None:
    """Add dashed pressure-trough axes to every frame from its stored MSLP.

    Computed at load time (not baked into the dataset) so the trough detection
    can be tuned without rebuilding the year-long archive.
    """
    nx, ny = data["nx"], data["ny"]
    for f in data["frames"]:
        base = [fr for fr in f.get("fronts", []) if fr.get("type") != "trough"]
        f["fronts"] = base + detect_troughs(f["values"], BBOX, nx, ny)


def _frame_from_fetch(f: dict) -> dict:
    """Turn a freshly fetched raw frame into a served frame (fronts precomputed)."""
    fronts = detect_fronts(
        f.get("temp850", []),
        f.get("rh850", []),
        f.get("windSpeed", []),
        f.get("windDirection", []),
        BBOX,
        HNX,
        HNY,
    )
    return {
        "values": f["values"],
        "windSpeed": f["windSpeed"],
        "windDirection": f["windDirection"],
        "fronts": fronts,
    }


async def _build() -> None:
    global _data
    start, end = _window()
    target = _dataset_path(start, end)

    # Source of truth is the persistent HF dataset archive (unbounded in time,
    # kept fresh daily by the ingest Action). Fall back to any pre-built file
    # committed in server/data/ when the dataset is unavailable (no token, etc.).
    existing_data: dict | None = None
    try:
        import archive_store

        existing_data = await asyncio.to_thread(archive_store.pull_archive)
    except Exception as exc:  # noqa: BLE001
        print(f"[history] dataset pull failed: {exc}")
    if existing_data is None:
        existing = _existing_dataset()
        if existing is not None:
            existing_data = json.loads(existing.read_text())

    # If it already reaches close to today and covers the window start, it is
    # fresh: just trim to the rolling window and serve (the archive itself keeps
    # everything; only the served slice is bounded).
    if existing_data is not None:
        ed = existing_data.get("dates", [])
        if ed and ed[-1] >= (end - dt.timedelta(days=ARCHIVE_LAG_DAYS)).isoformat() \
                and ed[0] <= start.isoformat():
            _data = _trim_to_window(existing_data, start, end)
            _augment_troughs(_data)
            _state.update(status="ready", progress=1.0)
            return

    # Otherwise (incrementally) fetch. Keep the overlapping frames we already
    # have and only request the days after the newest kept one.
    _state.update(status="building", error=None, progress=0.0)
    frames_by_date: dict[str, dict] = {}
    fetch_from = start
    if existing_data:
        for d, fr in zip(existing_data["dates"], existing_data["frames"]):
            if start.isoformat() <= d <= end.isoformat():
                frames_by_date[d] = {
                    "values": fr["values"],
                    "windSpeed": fr["windSpeed"],
                    "windDirection": fr["windDirection"],
                    "fronts": [x for x in fr.get("fronts", []) if x.get("type") != "trough"],
                }
        if frames_by_date:
            newest = max(frames_by_date)
            fetch_from = dt.date.fromisoformat(newest) + dt.timedelta(days=1)

    if fetch_from <= end:
        chunks = _month_chunks(fetch_from, end)
        sem = asyncio.Semaphore(MAX_CONCURRENCY)
        done = 0
        async with httpx.AsyncClient() as client:
            async def worker(c0: dt.date, c1: dt.date) -> dict[str, dict]:
                nonlocal done
                async with sem:
                    res = await _fetch_chunk_cached(client, c0, c1)
                done += 1
                _state["progress"] = round(done / len(chunks), 3)
                return res

            results = await asyncio.gather(*(worker(c0, c1) for c0, c1 in chunks))
        for res in results:
            for d, f in res.items():
                if start.isoformat() <= d <= end.isoformat():
                    frames_by_date[d] = _frame_from_fetch(f)

    dates = sorted(frames_by_date.keys())
    frames = [frames_by_date[d] for d in dates]

    _data = {
        "bbox": BBOX,
        "nx": HNX,
        "ny": HNY,
        "step": ISOBAR_STEP,
        "glenans": GLENANS,
        "source": "Open-Meteo Historical Forecast (ECMWF IFS)",
        "dates": dates,
        "frames": frames,
    }

    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(_data, separators=(",", ":")))
    _augment_troughs(_data)

    # Drop stale datasets (other windows) and the per-month resume cache.
    for old in _DATA_DIR.glob(f"history_*_{HNX}x{HNY}_fronts.json"):
        if old != target:
            old.unlink()
    if _CHUNK_DIR.is_dir():
        for f in _CHUNK_DIR.glob("chunk_*.json"):
            f.unlink()
        try:
            _CHUNK_DIR.rmdir()
        except OSError:
            pass

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
