"""One-shot daily ingestion for the glénans historical archive.

Run by a GitHub Action once a day. Pulls the unbounded archive from the HF
dataset (seeding it from the committed pre-built file on the very first run),
fetches any days missing up to today, appends them (the archive is **never**
trimmed - it keeps all history), recomputes the objective fronts, and pushes
the archive back to the dataset.

Requires ``HF_TOKEN`` with write access to the dataset.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os

import httpx

import archive_store
import history


def _seed_from_committed() -> dict | None:
    ex = history._existing_dataset()
    if ex is None:
        return None
    data = json.loads(ex.read_text())
    # Troughs are recomputed at load, so keep only cold/warm/occluded fronts.
    for fr in data.get("frames", []):
        fr["fronts"] = [x for x in fr.get("fronts", []) if x.get("type") != "trough"]
    return data


async def run() -> dict:
    data = await asyncio.to_thread(archive_store.pull_archive)
    seeded = False
    if data is None:
        data = _seed_from_committed()
        if data is None:
            raise RuntimeError("no dataset archive and no committed seed file")
        seeded = True

    frames_by_date: dict[str, dict] = dict(
        zip(data.get("dates", []), data.get("frames", []))
    )
    today = dt.date.today()
    if frames_by_date:
        last = max(frames_by_date)
        fetch_from = dt.date.fromisoformat(last) + dt.timedelta(days=1)
    else:
        fetch_from = today - dt.timedelta(days=history.HISTORY_DAYS - 1)

    added: list[str] = []
    if fetch_from <= today:
        async with httpx.AsyncClient() as client:
            for c0, c1 in history._month_chunks(fetch_from, today):
                res = await history._fetch_chunk(client, c0, c1)
                for d, f in res.items():
                    if d not in frames_by_date:
                        frames_by_date[d] = history._frame_from_fetch(f)
                        added.append(d)

    if added or seeded:
        dates = sorted(frames_by_date)
        data.update(
            {
                "bbox": history.BBOX,
                "nx": history.HNX,
                "ny": history.HNY,
                "step": history.ISOBAR_STEP,
                "glenans": history.GLENANS,
                "source": data.get(
                    "source", "Open-Meteo Historical Forecast (ECMWF IFS)"
                ),
                "dates": dates,
                "frames": [frames_by_date[d] for d in dates],
            }
        )
        if added:
            span = added[0] if len(added) == 1 else f"{min(added)}..{max(added)}"
            msg = f"add {span} ({len(added)} day(s)); archive={len(dates)} frames"
        else:
            msg = f"seed archive from committed file ({len(dates)} frames)"
        await asyncio.to_thread(archive_store.push_archive, data, msg)

    return {"added": added, "seeded": seeded, "total": len(data.get("dates", []))}


if __name__ == "__main__":
    if not (os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")):
        raise SystemExit("HF_TOKEN is required for ingestion")
    out = asyncio.run(run())
    action = "seeded" if out["seeded"] else "updated"
    print(
        f"[ingest] {action}: +{len(out['added'])} day(s); "
        f"archive now holds {out['total']} frames"
    )
