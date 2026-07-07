"""One-off backfill: recompute every archived frame's fronts with the CNN.

Pulls the unbounded archive from the HF dataset, replaces the objective fronts
of each day with DWD FrontDetection (ERA5) fronts, and pushes it back. Safe to
interrupt and re-run: frames already carrying ``frontsBackend == "cnn"`` are
skipped, the archive is pushed every ``PUSH_EVERY`` newly processed days, and a
soft time budget (``BACKFILL_MAX_SECONDS``) lets a CI run stop cleanly before a
job timeout - the next dispatch resumes where it left off.

Fetching ERA5 from GCS dominates the runtime (~2 min/day), so days are fetched
in a **process** pool: each worker owns its own fsspec/gcsfs event loop and
torch model, which parallelises the network I/O without the thread-safety
pitfalls of sharing one zarr store across threads.

Env:
    HF_TOKEN              write access to the dataset (push)
    FRONTNET_WEIGHTS      local .pth (skip the dataset download)
    SSL_CERT_FILE         certifi bundle (macOS gcsfs TLS)
    BACKFILL_WORKERS      concurrent ERA5 fetches (default 4)
    BACKFILL_LIMIT        process at most N days (smoke test; default all)
    BACKFILL_MAX_SECONDS  stop submitting new days after this budget (default 0 = no cap)
"""

from __future__ import annotations

import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
sys.path.insert(0, os.path.dirname(__file__))

import archive_store

WORKERS = int(os.environ.get("BACKFILL_WORKERS", "4"))
LIMIT = int(os.environ.get("BACKFILL_LIMIT", "0")) or None
MAX_SECONDS = int(os.environ.get("BACKFILL_MAX_SECONDS", "0")) or None
PUSH_EVERY = 15


def _work(d: str):
    """Runs in a worker process: compute CNN fronts for one day."""
    from frontnet import fronts_for_date

    return d, fronts_for_date(d)


def main() -> None:
    if not (os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")):
        print("[backfill] warning: no HF_TOKEN in env; relying on cached login")

    data = archive_store.pull_archive()
    if data is None:
        raise SystemExit("no archive on the dataset to backfill")

    dates = data.get("dates", [])
    by_date = dict(zip(dates, data.get("frames", [])))

    todo = sorted(d for d, f in by_date.items() if f.get("frontsBackend") != "cnn")
    if LIMIT:
        todo = todo[:LIMIT]
    print(f"[backfill] {len(todo)}/{len(dates)} days need CNN fronts "
          f"({WORKERS} workers, budget={MAX_SECONDS or 'none'}s)", flush=True)
    if not todo:
        return

    def flush(msg: str) -> None:
        data["frames"] = [by_date[d] for d in dates]
        archive_store.push_archive(data, msg)

    started = time.time()
    done = 0
    since_push = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(_work, d): d for d in todo}
        for fut in as_completed(futs):
            d = futs[fut]
            try:
                _, fronts = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"[backfill] skip {d}: {exc}", flush=True)
                continue
            by_date[d]["fronts"] = fronts
            by_date[d]["frontsBackend"] = "cnn"
            done += 1
            since_push += 1
            cnt: dict[str, int] = {}
            for fr in fronts:
                cnt[fr["type"]] = cnt.get(fr["type"], 0) + 1
            print(f"[backfill] {done}/{len(todo)} {d}: {len(fronts)} fronts {cnt}",
                  flush=True)
            if since_push >= PUSH_EVERY:
                flush(f"backfill CNN fronts ({done}/{len(todo)} done)")
                since_push = 0
            if MAX_SECONDS and time.time() - started > MAX_SECONDS:
                print(f"[backfill] time budget reached after {done} days; "
                      "flushing and exiting (resume on next run)", flush=True)
                if since_push:
                    flush(f"backfill CNN fronts (budget stop, {done} this run)")
                for f in futs:
                    f.cancel()
                return

    flush(f"backfill CNN fronts complete ({done} days this run)")
    print(f"[backfill] done: {done} days upgraded to CNN fronts", flush=True)


if __name__ == "__main__":
    main()
