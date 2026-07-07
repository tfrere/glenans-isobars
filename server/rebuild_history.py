"""Force a *full* rebuild of the rolling history (refetch every day).

Unlike the lazy/incremental build, this refetches the whole rolling window so
objective fronts -- including occluded -- are recomputed for every day, not just
the recently added ones.

It is resilient to the Open-Meteo 850 hPa endpoint being intermittently down:
each month is retried with backoff until it succeeds, and successful months are
cached on disk (`data/_chunks/`) so the job resumes where it left off. The new
dataset is written to a temp file and atomically swapped in at the very end, so
the currently served dataset stays intact until the rebuild fully completes.

    python server/rebuild_history.py
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os

import httpx

import history as h
from geo import BBOX, GLENANS, ISOBAR_STEP
from fronts_detect import detect_fronts


def _now() -> str:
    return dt.datetime.now().strftime("%H:%M:%S")


async def main() -> int:
    start, end = h._window()
    chunks = h._month_chunks(start, end)
    print(f"[{_now()}] Full rebuild {start} -> {end} ({len(chunks)} months)", flush=True)

    merged: dict[str, dict] = {}
    async with httpx.AsyncClient() as client:
        for i, (c0, c1) in enumerate(chunks, 1):
            attempt = 0
            while True:
                try:
                    res = await h._fetch_chunk_cached(client, c0, c1)
                    merged.update(res)
                    break
                except Exception as exc:  # noqa: BLE001
                    attempt += 1
                    wait = min(60 + attempt * 60, 600)
                    print(
                        f"[{_now()}] month {i}/{len(chunks)} {c0}..{c1} failed "
                        f"({exc}); retry #{attempt} in {wait}s",
                        flush=True,
                    )
                    await asyncio.sleep(wait)
            print(f"[{_now()}] month {i}/{len(chunks)} ok ({c0}..{c1})", flush=True)

    dates = sorted(d for d in merged if start.isoformat() <= d <= end.isoformat())
    frames = []
    for d in dates:
        f = merged[d]
        fronts = detect_fronts(
            f.get("temp850", []),
            f.get("rh850", []),
            f.get("windSpeed", []),
            f.get("windDirection", []),
            BBOX,
            h.HNX,
            h.HNY,
        )
        frames.append({
            "values": f["values"],
            "windSpeed": f["windSpeed"],
            "windDirection": f["windDirection"],
            "fronts": fronts,
        })

    data = {
        "bbox": BBOX,
        "nx": h.HNX,
        "ny": h.HNY,
        "step": ISOBAR_STEP,
        "glenans": GLENANS,
        "source": "Open-Meteo Historical Forecast (ECMWF IFS)",
        "dates": dates,
        "frames": frames,
    }

    target = h._dataset_path(start, end)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, target)  # atomic swap, served dataset untouched until now

    # Drop other windows + the per-month resume cache.
    for old in h._DATA_DIR.glob(f"history_*_{h.HNX}x{h.HNY}_fronts.json"):
        if old != target:
            old.unlink()
    if h._CHUNK_DIR.is_dir():
        for fp in h._CHUNK_DIR.glob("chunk_*.json"):
            fp.unlink()
        try:
            h._CHUNK_DIR.rmdir()
        except OSError:
            pass

    occ = sum(1 for fr in frames for x in fr["fronts"] if x["type"] == "occluded")
    occ_days = sum(
        1 for fr in frames if any(x["type"] == "occluded" for x in fr["fronts"])
    )
    print(
        f"[{_now()}] DONE: {len(frames)} frames "
        f"({dates[0]} -> {dates[-1]}), occluded on {occ_days} days "
        f"({occ} segments) -> {target}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
