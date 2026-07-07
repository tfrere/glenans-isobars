"""CNN front-class probability map -> ordered lon/lat polylines.

argmax + confidence gate + border crop -> per-class binary mask -> skeletonize
-> trace ordered pixel paths (junctions split lines) -> pixel->lon/lat ->
Ramer-Douglas-Peucker simplify -> warm-side unit vector from the 850 hPa
thermal gradient. Output matches the app front schema:
    {"type", "points": [[lon, lat], ...], "warm": [dlon, dlat]}
"""

from __future__ import annotations

import numpy as np
from skimage.morphology import skeletonize

CLASS_NAMES = {1: "warm", 2: "cold", 3: "occluded", 4: "stationary"}


def _neighbors(p, coords):
    r, c = p
    return [
        (r + dr, c + dc)
        for dr in (-1, 0, 1)
        for dc in (-1, 0, 1)
        if (dr, dc) != (0, 0) and (r + dr, c + dc) in coords
    ]


def _trace(mask, min_px):
    """Ordered pixel paths from a binary mask (junctions split the lines)."""
    sk = skeletonize(mask)
    coords = set(map(tuple, np.argwhere(sk)))
    junctions = {p for p in coords if len(_neighbors(p, coords)) >= 3}
    coords -= junctions
    visited: set = set()
    paths = []
    endpoints = [p for p in coords if len(_neighbors(p, coords)) == 1]
    for s in endpoints + list(coords):  # endpoints first, then leftover loops
        if s in visited:
            continue
        path, cur, prev = [s], s, None
        visited.add(s)
        while True:
            nbrs = [n for n in _neighbors(cur, coords) if n not in visited]
            if not nbrs:
                break
            if prev is not None:
                d0 = (cur[0] - prev[0], cur[1] - prev[1])
                nbrs.sort(key=lambda n: -((n[0] - cur[0]) * d0[0] + (n[1] - cur[1]) * d0[1]))
            nxt = nbrs[0]
            path.append(nxt)
            visited.add(nxt)
            prev, cur = cur, nxt
        if len(path) >= min_px:
            paths.append(path)
    return paths


def _rdp(pts, eps):
    """Ramer-Douglas-Peucker on a list of (x, y)."""
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    nrm = np.hypot(*ab) or 1.0
    dmax, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        ap = np.array(pts[i]) - a
        d = abs(ab[0] * ap[1] - ab[1] * ap[0]) / nrm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return _rdp(pts[: idx + 1], eps)[:-1] + _rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def vectorize(prob, t850, lat, lon, *, conf=0.5, border_px=20, min_px=10,
              simplify_deg=0.25):
    cls = prob.argmax(0)
    cls = np.where(prob.max(0) > conf, cls, 0)
    cls[:border_px] = 0
    cls[-border_px:] = 0
    cls[:, :border_px] = 0
    cls[:, -border_px:] = 0

    dlat = float(lat[1] - lat[0])  # negative (north first)
    dlon = float(lon[1] - lon[0])
    gy, gx = np.gradient(t850)

    fronts: list[dict] = []
    for c in (1, 2, 3, 4):
        mask = cls == c
        if not mask.any():
            continue
        for path in _trace(mask, min_px):
            lonlat = [(float(lon[cc]), float(lat[r])) for r, cc in path]
            simp = _rdp(lonlat, simplify_deg)
            if len(simp) < 2:
                continue
            rows = [p[0] for p in path]
            cols = [p[1] for p in path]
            gxm = float(np.mean(gx[rows, cols])) / dlon
            gym = float(np.mean(gy[rows, cols])) / dlat
            n = float(np.hypot(gxm, gym)) or 1.0
            fronts.append({
                "type": CLASS_NAMES[c],
                "points": [[round(float(x), 3), round(float(y), 3)] for x, y in simp],
                "warm": [round(gxm / n, 4), round(gym / n, 4)],
            })
    return fronts
