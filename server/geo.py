"""Shared geographic configuration for live and historical grids."""

from __future__ import annotations

GLENANS = {"name": "Archipel des Glénans", "lat": 47.7186, "lon": -3.9886}

# Wide synoptic window: North Atlantic + Western Europe (UK, France, Iberia).
BBOX = {"latMin": 40.0, "latMax": 56.0, "lonMin": -20.0, "lonMax": 8.0}

ISOBAR_STEP = 4  # hPa


def lon_at(i: int, nx: int) -> float:
    return BBOX["lonMin"] + (i / (nx - 1)) * (BBOX["lonMax"] - BBOX["lonMin"])


def lat_at(j: int, ny: int) -> float:
    # Row 0 = northernmost latitude (top of the SVG), increasing j goes south.
    return BBOX["latMax"] - (j / (ny - 1)) * (BBOX["latMax"] - BBOX["latMin"])


def build_grid_points(nx: int, ny: int) -> tuple[list[float], list[float]]:
    lats: list[float] = []
    lons: list[float] = []
    for j in range(ny):
        for i in range(nx):
            lats.append(round(lat_at(j, ny), 4))
            lons.append(round(lon_at(i, nx), 4))
    return lats, lons
