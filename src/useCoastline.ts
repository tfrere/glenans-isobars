import { useEffect, useState } from "react";
import { feature } from "topojson-client";
import type { Feature, MultiPolygon } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";

export type LandFeature = Feature<MultiPolygon>;

// Natural Earth land outline (50m), served as a static asset by the backend.
// Loaded once and cached across mounts.
let cache: Promise<LandFeature> | null = null;

function loadCoastline(): Promise<LandFeature> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}land-50m.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`coastline ${r.status}`);
        return r.json() as Promise<Topology<{ land: GeometryCollection }>>;
      })
      .then(
        (topo) => feature(topo, topo.objects.land) as unknown as LandFeature,
      );
  }
  return cache;
}

export function useCoastline(): LandFeature | null {
  const [land, setLand] = useState<LandFeature | null>(null);
  useEffect(() => {
    let alive = true;
    loadCoastline()
      .then((f) => {
        if (alive) setLand(f);
      })
      .catch(() => {
        /* non-fatal: map simply renders without coastline */
      });
    return () => {
      alive = false;
    };
  }, []);
  return land;
}
