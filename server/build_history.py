"""Builder/refresher for the rolling historical timeline dataset.

Run this locally to (incrementally) refresh the rolling 12-month window ending
today from Open-Meteo and write it to ``server/data/``. Commit the resulting
JSON so the Space loads it instantly.

    python server/build_history.py

Safe to re-run: an existing dataset is reused for the overlapping days and only
the missing recent days are fetched.
"""

from __future__ import annotations

import asyncio
import sys

import history


async def _progress() -> None:
    while True:
        await asyncio.sleep(5)
        print(
            f"  ... {history._state['status']} "
            f"{round(history._state['progress'] * 100)}%",
            flush=True,
        )


async def main() -> int:
    start, end = history._window()
    print(
        f"Refreshing rolling history {start} -> {end} "
        f"on a {history.HNX}x{history.HNY} grid...",
        flush=True,
    )
    watcher = asyncio.create_task(_progress())
    try:
        await history._build()
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}", flush=True)
        return 1
    finally:
        watcher.cancel()

    path = history._dataset_path(start, end)
    data = history._data or {}
    dates = data.get("dates", [])
    frames = len(dates)
    size_kb = path.stat().st_size / 1024 if path.is_file() else 0
    span = f"{dates[0]} -> {dates[-1]}" if dates else "empty"
    print(f"OK: {frames} frames ({span}) -> {path} ({size_kb:.0f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
