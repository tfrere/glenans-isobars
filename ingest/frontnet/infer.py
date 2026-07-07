"""ERA5 fetch + DWD FrontDetection CNN inference -> vectorised fronts.

Heavy, offline path used only by the ingestion pipeline (GitHub Action / local
backfill), never by the Space runtime. Data is ARCO-ERA5 (analysis-ready,
pressure levels) read anonymously from Google Cloud Storage; the model is the
pre-trained DWD network from Niebler et al. (2022, github.com/stnie/FrontDetection,
MIT). Because ARCO exposes pressure levels rather than the model's native L137
model levels, each model level is approximated by its nearest standard pressure
level - a documented approximation that stays synoptically coherent.
"""

from __future__ import annotations

import os
import threading

import numpy as np
import torch
import xarray as xr

from .fdu3d import FDU2DNetLargeEmbedCombineModular
from .l137 import L137Calculator
from .vectorize import vectorize

ARCO = "gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"

# Inference box: larger than the app display BBOX (34..70N, -25..40E) so the
# 5-deg CNN border artefact can be cropped while still covering the whole map.
LAT_N, LAT_S = 76.0, 28.0
LON_W, LON_E = -33.0, 47.0

MODEL_LEVELS = [105, 109, 113, 117, 121, 125, 129, 133, 137]
VARS = ["t", "q", "u", "v", "w"]
ARCO_VAR = {
    "t": "temperature", "q": "specific_humidity",
    "u": "u_component_of_wind", "v": "v_component_of_wind",
    "w": "vertical_velocity",
}
# Fixed NormType=1 (mean, var) used at training time, inlined from the upstream
# era5dataset reader so we do not depend on netCDF4/skimage at fetch time.
_MEANVAR = {
    "t": (2.75355461e02, 3.20404803e02), "q": (5.57926815e-03, 2.72627785e-05),
    "u": (1.27024432, 6.74232481e01), "v": (1.0213897e-01, 4.36244384e01),
    "w": (5.87718196e-03, 4.77972548e-02), "sp": (8.65211548e04, 1.49460630e08),
    "kmPerLon": (0.64, 0.09),
}

# Weights: local file (FRONTNET_WEIGHTS) or pulled from the HF dataset.
WEIGHTS_REPO = os.environ.get("FRONTNET_WEIGHTS_REPO", "tfrere/glenans-isobars-archive")
WEIGHTS_FILE = os.environ.get("FRONTNET_WEIGHTS_FILE", "models/PreTrainedNetwork.pth")

_MODEL = None
_DS = None
_MODEL_LOCK = threading.Lock()
_DS_LOCK = threading.Lock()


def _km_per_lon(lat_deg, lon_res=0.25):
    r = (6365831.0 * np.cos(lat_deg / 180 * np.pi)) / 1000.0
    return r * 2 * np.pi * lon_res / 360


def _nearest_pressure_levels(ar_levels):
    lc, sp = L137Calculator(), 101325.0
    return [min(ar_levels, key=lambda x: abs(x - (lc.a[l] + sp * lc.b[l]) / 100))
            for l in MODEL_LEVELS]


def _build_input(arr, plevels):
    lat = arr.latitude.values
    H, W = arr.sizes["latitude"], arr.sizes["longitude"]
    chans = []
    for var in VARS:
        da = arr[ARCO_VAR[var]]
        m, v = _MEANVAR[var]
        inv = 1.0 / np.sqrt(v)
        for lv in plevels:
            chans.append((da.sel(level=lv).values.astype(np.float32) - m) * inv)
    m, v = _MEANVAR["sp"]
    inv = 1.0 / np.sqrt(v)
    for lv in plevels:
        chans.append((np.full((H, W), lv * 100.0, np.float32) - m) * inv)
    m, v = _MEANVAR["kmPerLon"]
    kmpl = (np.clip(_km_per_lon(np.abs(lat)), 0.1, 30) / 27.7762 - m) / np.sqrt(v)
    chans.append(np.broadcast_to(kmpl[:, None], (H, W)).astype(np.float32).copy())
    return torch.from_numpy(np.stack(chans, 0).astype(np.float32)).unsqueeze(0)


def _weights_path() -> str:
    local = os.environ.get("FRONTNET_WEIGHTS")
    if local and os.path.isfile(local):
        return local
    from huggingface_hub import hf_hub_download

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    return hf_hub_download(WEIGHTS_REPO, WEIGHTS_FILE, repo_type="dataset", token=token)


def load_model():
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is None:
            m = FDU2DNetLargeEmbedCombineModular(
                in_channel=55, out_channel=5, kernel_size=5, sub_blocks=(3, 3, 3),
                embedding_factor=6)
            m.load_state_dict(torch.load(_weights_path(), map_location="cpu"))
            _MODEL = m.eval()
    return _MODEL


def _open():
    global _DS
    with _DS_LOCK:
        if _DS is None:
            ds = xr.open_zarr(ARCO, chunks=None, storage_options={"token": "anon"})
            _DS = ds.assign_coords(
                longitude=(((ds.longitude + 180) % 360) - 180)).sortby("longitude")
    return _DS


def _infer_raw(date: str):
    """(prob[5,H,W], t850[H,W], lat[H], lon[W]) for a UTC datetime string."""
    ds = _open()
    plevels = _nearest_pressure_levels(ds.level.values.tolist())
    need = sorted(set(plevels))
    box = ds.sel(time=date).sel(
        latitude=slice(LAT_N, LAT_S), longitude=slice(LON_W, LON_E))
    arr = box[[ARCO_VAR[v] for v in VARS]].sel(level=need).load()
    if arr.sizes["latitude"] == 0 or arr.sizes["longitude"] == 0:
        raise ValueError(f"ARCO-ERA5 has no grid for {date}")
    # The ARCO time axis spans 1900..2050 but recent/future days are all-NaN
    # until the reanalysis catches up: treat those as "not available yet".
    if bool(np.isnan(arr[ARCO_VAR["t"]].values).all()):
        raise ValueError(f"ARCO-ERA5 has no data for {date} yet (reanalysis lag)")
    x = _build_input(arr, plevels)
    H, W = x.shape[-2], x.shape[-1]
    H8, W8 = H - (H % 8), W - (W % 8)  # U-Net pools 3x -> dims must divide by 8
    x = x[..., :H8, :W8]
    arr = arr.isel(latitude=slice(0, H8), longitude=slice(0, W8))
    with torch.no_grad():
        prob = torch.softmax(load_model()(x), dim=1)[0].numpy()
    t850 = arr[ARCO_VAR["t"]].sel(level=850).values - 273.15
    return prob, t850, arr.latitude.values, arr.longitude.values


def fronts_for_date(date_iso: str) -> list[dict]:
    """Vectorised CNN fronts for a YYYY-MM-DD day (12:00 UTC analysis).

    Returns a list of {type, points, warm}; raises ValueError if ERA5 has no
    data for that date yet (reanalysis lag).
    """
    prob, t850, lat, lon = _infer_raw(f"{date_iso}T12:00:00")
    return vectorize(prob, t850, lat, lon)
