"""Persistent history archive on a Hugging Face dataset.

The frontend only ever shows a rolling one-year window, but the *archive* is
deliberately **unbounded in time**: every day fetched is appended and kept
forever in a single growing JSON on a HF dataset. A daily GitHub Action appends
the new day (see ``ingest.py``); the Space pulls the archive at boot and trims
it to the rolling window for serving.

Persistence is best-effort: without an ``HF_TOKEN`` the Space simply falls back
to the pre-built file committed in ``server/data/``.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

DATASET_REPO = os.environ.get("GLENANS_DATASET", "tfrere/glenans-isobars-archive")
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
# Single unbounded archive file (all frames ever fetched, sorted by date). The
# grid size is in the name so a grid change starts a fresh archive.
ARCHIVE_NAME = "archive_17x10_fronts.json"


def _api():
    from huggingface_hub import HfApi

    return HfApi(token=HF_TOKEN)


def ensure_repo() -> None:
    _api().create_repo(
        DATASET_REPO, repo_type="dataset", exist_ok=True, private=False
    )


def pull_archive() -> dict | None:
    """Download the unbounded archive JSON from the dataset, or None if it is
    missing. The dataset is public, so this works anonymously (no token needed
    on the Space); a token is only required to *push*."""
    try:
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(
            DATASET_REPO,
            ARCHIVE_NAME,
            repo_type="dataset",
            token=HF_TOKEN,  # optional; anonymous read works for a public repo
        )
        return json.loads(Path(path).read_text())
    except Exception as exc:  # noqa: BLE001
        print(f"[archive_store] pull failed: {exc}")
        return None


def push_archive(data: dict, message: str) -> None:
    """Overwrite the archive JSON on the dataset with `data` (already contains
    all frames)."""
    from huggingface_hub import CommitOperationAdd

    ensure_repo()
    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    )
    try:
        json.dump(data, tmp, separators=(",", ":"))
        tmp.flush()
        tmp.close()
        _api().create_commit(
            repo_id=DATASET_REPO,
            repo_type="dataset",
            operations=[
                CommitOperationAdd(path_in_repo=ARCHIVE_NAME, path_or_fileobj=tmp.name)
            ],
            commit_message=message,
        )
    finally:
        os.unlink(tmp.name)
