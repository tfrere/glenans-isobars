export interface BBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

// A server-detected synoptic feature (objective theta-e / Hewson TFP method for
// fronts; cyclonic-curvature axes for troughs).
export interface Front {
  type: "cold" | "warm" | "occluded" | "stationary" | "trough";
  points: [number, number][]; // [lon, lat] polyline
  warm?: [number, number]; // unit vector (lon/lat) toward the warm air (fronts only)
}

export interface IsobarGrid {
  bbox: BBox;
  nx: number;
  ny: number;
  step: number; // isobar spacing in hPa
  glenans: { name: string; lat: number; lon: number };
  model: string;
  values: number[]; // pressure_msl in hPa, row-major (north -> south, west -> east)
  windSpeed: number[]; // knots, same layout as values
  windDirection: number[]; // degrees, direction the wind comes FROM
  fronts?: Front[]; // objective cold/warm fronts computed server-side
  min: number;
  max: number;
  updatedAt: string;
}

// Backend lives on the same origin (FastAPI serves both API and static front).
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function fetchIsobarGrid(
  signal?: AbortSignal,
): Promise<IsobarGrid> {
  const res = await fetch(`${API_BASE}/api/isobars`, { signal });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as IsobarGrid;
}
