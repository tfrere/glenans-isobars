"""Objective synoptic front detection (theta-e + Hewson thermal front parameter).

Fronts are located as the zero line of the TFP inside the baroclinic zone (where
the 850 hPa equivalent-potential-temperature gradient exceeds a threshold), and
each segment is classified cold/warm from the sign of theta_e advection by the
wind. This is a physically grounded objective method (Hewson 1998 lineage), a
clear step up from a raw temperature-gradient ridge.

`detect_fronts` returns a list of:
    {"type": "cold"|"warm"|"occluded", "points": [[lon, lat], ...], "warm": [dlon, dlat]}
where `warm` is a unit vector (lon/lat space) pointing toward the warm air, used
by the renderer to place the pips/bumps on the correct side of the line. A
segment is flagged "occluded" when the thermal contrast is strong but the wind
blows nearly along the front (weak cross-front advection), the typical signature
of an occlusion / quasi-stationary front.

`detect_troughs` returns dashed pressure-trough axes:
    {"type": "trough", "points": [[lon, lat], ...]}
located along lines of cyclonic curvature in the MSLP field (away from fronts).
"""
from __future__ import annotations

import math

import numpy as np
from contourpy import contour_generator
from scipy.ndimage import gaussian_filter, zoom

KM_PER_DEG = 111.0

# Bolton (1980) constants, matching MetPy's implementation so the front
# thresholds tuned against MetPy stay valid. Reimplemented in pure NumPy to
# avoid pulling the full MetPy stack (matplotlib, pandas, pyproj, xarray, ...)
# into the runtime image.
_SAT_P0 = 6.112  # saturation vapor pressure at 0 degC, hPa
_EPSILON = 0.6219800858985514  # Rd / Rv (molecular weight ratio)
_KAPPA = 0.2854  # Rd / Cp_d (Poisson exponent)
_P_LEVEL = 850.0  # hPa


def _theta_e(t_c: np.ndarray, rh: np.ndarray) -> np.ndarray:
    """850 hPa equivalent potential temperature (K) from temperature (degC)
    and relative humidity (%), via the Bolton (1980) formulation."""
    t_c = np.asarray(t_c, dtype=float)
    rh_frac = np.clip(np.asarray(rh, dtype=float), 1.0, 100.0) / 100.0
    t_k = t_c + 273.15

    # Saturation vapor pressure at T, then actual vapor pressure e = RH * es(T).
    es_t = _SAT_P0 * np.exp(17.67 * t_c / (t_c + 243.5))
    e = rh_frac * es_t

    # Dewpoint (K) inverted from the actual vapor pressure (Bolton).
    val = np.log(e / _SAT_P0)
    td_k = 273.15 + 243.5 * val / (17.67 - val)

    # es(Td) == e by construction of the dewpoint, so reuse e directly.
    r = _EPSILON * e / (_P_LEVEL - e)
    t_l = 56.0 + 1.0 / (1.0 / (td_k - 56.0) + np.log(t_k / td_k) / 800.0)
    th_l = t_k * (1000.0 / (_P_LEVEL - e)) ** _KAPPA * (t_k / t_l) ** (0.28 * r)
    return th_l * np.exp((3036.0 / t_l - 1.78) * r * (1.0 + 0.448 * r))


def detect_fronts(
    t_c,
    rh,
    ws,
    wd_deg,
    bbox: dict,
    nx: int,
    ny: int,
    *,
    upsample: int = 6,
    smooth: float = 1.2,
    min_grad: float = 0.012,
    min_len_deg: float = 4.0,
    occ_align: float = 0.32,
) -> list[dict]:
    """Detect classified front polylines from coarse 850 hPa fields.

    Inputs are flat, row-major arrays (row 0 = north, west -> east), matching
    geo.build_grid_points. `ws`/`wd_deg` are the wind used only for the advection
    sign, so their unit is irrelevant.
    """
    t_arr = np.asarray(t_c, dtype=float)
    if t_arr.size != nx * ny or not np.any(np.isfinite(t_arr) & (t_arr != 0.0)):
        return []

    T = t_arr.reshape(ny, nx)
    RH = np.asarray(rh, dtype=float).reshape(ny, nx)
    WS = np.asarray(ws, dtype=float).reshape(ny, nx)
    WD = np.asarray(wd_deg, dtype=float).reshape(ny, nx)

    the = gaussian_filter(_theta_e(T, RH), smooth)
    latmean = (bbox["latMin"] + bbox["latMax"]) / 2
    dx = (bbox["lonMax"] - bbox["lonMin"]) / (nx - 1) * KM_PER_DEG * math.cos(math.radians(latmean))
    dy = (bbox["latMax"] - bbox["latMin"]) / (ny - 1) * KM_PER_DEG

    gy, gx = np.gradient(the, dy, dx)
    gyN = -gy  # north-positive gradient component
    mag = np.hypot(gx, gyN)
    mgy, mgx = np.gradient(mag, dy, dx)
    mgyN = -mgy
    eps = 1e-9
    tfp = -(mgx * gx / (mag + eps) + mgyN * gyN / (mag + eps))

    u = -WS * np.sin(np.radians(WD))
    v = -WS * np.cos(np.radians(WD))
    adv = -(u * gx + v * gyN)
    # |cos| of the angle between wind and the thermal gradient: ~1 for strong
    # cross-front advection (active cold/warm front), ~0 when the wind blows
    # along the front (occlusion / quasi-stationary).
    align = np.abs(adv) / (mag * WS + 1e-6)

    magU = zoom(mag, upsample, order=1)
    tfpU = zoom(tfp, upsample, order=1)
    advU = zoom(adv, upsample, order=1)
    alignU = zoom(align, upsample, order=1)
    gxU = zoom(gx, upsample, order=1)
    gyNU = zoom(gyN, upsample, order=1)
    nyU, nxU = magU.shape

    def to_lonlat(fx: float, fy: float) -> tuple[float, float]:
        return (
            bbox["lonMin"] + fx / (nxU - 1) * (bbox["lonMax"] - bbox["lonMin"]),
            bbox["latMax"] - fy / (nyU - 1) * (bbox["latMax"] - bbox["latMin"]),
        )

    def classify(r: int, c: int) -> str | None:
        if magU[r, c] < min_grad:
            return None
        if alignU[r, c] < occ_align:
            return "occluded"
        return "cold" if advU[r, c] < 0 else "warm"

    fronts: list[dict] = []

    def flush(pts, gxs, gyns, cls) -> None:
        if cls is None or len(pts) < 2:
            return
        length = sum(
            math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            for i in range(len(pts) - 1)
        )
        if length < min_len_deg:
            return
        wx, wy = float(np.mean(gxs)), float(np.mean(gyns))
        wn = math.hypot(wx, wy) or 1.0
        fronts.append({
            "type": cls,
            "points": [[round(p[0], 3), round(p[1], 3)] for p in pts],
            "warm": [round(wx / wn, 4), round(wy / wn, 4)],
        })

    for line in contour_generator(z=tfpU).lines(0.0):
        cols = np.clip(line[:, 0].round().astype(int), 0, nxU - 1)
        rows = np.clip(line[:, 1].round().astype(int), 0, nyU - 1)
        pts, gxs, gyns = [], [], []
        cls = None
        for k in range(len(line)):
            r, c = int(rows[k]), int(cols[k])
            kc = classify(r, c)
            if kc is not None and (cls is None or kc == cls):
                pts.append(to_lonlat(line[k, 0], line[k, 1]))
                gxs.append(gxU[r, c])
                gyns.append(gyNU[r, c])
                cls = kc
            else:
                flush(pts, gxs, gyns, cls)
                pts, gxs, gyns = [], [], []
                cls = None
                if kc is not None:
                    pts.append(to_lonlat(line[k, 0], line[k, 1]))
                    gxs.append(gxU[r, c])
                    gyns.append(gyNU[r, c])
                    cls = kc
        flush(pts, gxs, gyns, cls)

    return fronts


def detect_troughs(
    mslp,
    bbox: dict,
    nx: int,
    ny: int,
    *,
    upsample: int = 6,
    smooth: float = 1.6,
    min_lap: float = 1.8e-5,
    min_len_deg: float = 6.0,
    gap: int = 10,
) -> list[dict]:
    """Pressure-trough axes (dashed) from cyclonic curvature of the MSLP field.

    A trough is the zero line of the pressure-gradient TFP, restricted to regions
    where the Laplacian of pressure is strongly positive (cyclonic curvature, the
    signature of a trough/low). Ridges (anticyclonic) are excluded.
    """
    p_arr = np.asarray(mslp, dtype=float)
    if p_arr.size != nx * ny:
        return []
    P = gaussian_filter(p_arr.reshape(ny, nx), smooth)
    latmean = (bbox["latMin"] + bbox["latMax"]) / 2
    dx = (bbox["lonMax"] - bbox["lonMin"]) / (nx - 1) * KM_PER_DEG * math.cos(math.radians(latmean))
    dy = (bbox["latMax"] - bbox["latMin"]) / (ny - 1) * KM_PER_DEG

    gy, gx = np.gradient(P, dy, dx)
    gyN = -gy
    mag = np.hypot(gx, gyN)
    mgy, mgx = np.gradient(mag, dy, dx)
    mgyN = -mgy
    eps = 1e-9
    tfp = -(mgx * gx / (mag + eps) + mgyN * gyN / (mag + eps))
    # Laplacian (cyclonic / trough -> positive: pressure is a local minimum).
    pyy = np.gradient(gy, dy, axis=0)
    pxx = np.gradient(gx, dx, axis=1)
    lap = pxx + pyy

    tfpU = zoom(tfp, upsample, order=1)
    lapU = zoom(lap, upsample, order=1)
    nyU, nxU = tfpU.shape

    def to_lonlat(fx: float, fy: float) -> tuple[float, float]:
        return (
            bbox["lonMin"] + fx / (nxU - 1) * (bbox["lonMax"] - bbox["lonMin"]),
            bbox["latMax"] - fy / (nyU - 1) * (bbox["latMax"] - bbox["latMin"]),
        )

    troughs: list[dict] = []
    for line in contour_generator(z=tfpU).lines(0.0):
        cols = np.clip(line[:, 0].round().astype(int), 0, nxU - 1)
        rows = np.clip(line[:, 1].round().astype(int), 0, nyU - 1)
        pts: list[tuple[float, float]] = []

        def flush(run):
            if len(run) < 2:
                return
            length = sum(
                math.hypot(run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1])
                for i in range(len(run) - 1)
            )
            if length >= min_len_deg:
                troughs.append({
                    "type": "trough",
                    "points": [[round(p[0], 3), round(p[1], 3)] for p in run],
                })

        miss = 0
        for k in range(len(line)):
            r, c = int(rows[k]), int(cols[k])
            if lapU[r, c] >= min_lap:
                pts.append(to_lonlat(line[k, 0], line[k, 1]))
                miss = 0
            else:
                # Bridge short sub-threshold gaps so a trough axis stays one line.
                miss += 1
                if miss > gap:
                    flush(pts)
                    pts = []
                elif pts:
                    pts.append(to_lonlat(line[k, 0], line[k, 1]))
        flush(pts)

    return troughs
