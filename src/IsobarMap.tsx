import { useMemo } from "react";
import { contours } from "d3-contour";
import { range } from "d3-array";
import { geoMercator, geoPath } from "d3-geo";
import type { GeoPermissibleObjects } from "d3-geo";
import type { IsobarGrid } from "./api";
import { windBarb } from "./windBarb";
import { useCoastline } from "./useCoastline";

const WIDTH = 1000;
// Show one wind barb every STRIDE grid nodes (in both directions) to avoid clutter.
const WIND_STRIDE = 2;

// Diverging color around the standard 1013 hPa: low = cool blue, high = warm red.
const COLOR_STOPS: Array<[number, [number, number, number]]> = [
  [988, [49, 54, 149]],
  [1000, [69, 117, 180]],
  [1008, [171, 217, 233]],
  [1013, [245, 245, 245]],
  [1018, [253, 207, 145]],
  [1026, [244, 109, 67]],
  [1038, [165, 0, 38]],
];

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

export function pressureColor(p: number): string {
  if (p <= COLOR_STOPS[0][0]) return rgb(COLOR_STOPS[0][1]);
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  if (p >= last[0]) return rgb(last[1]);
  for (let k = 0; k < COLOR_STOPS.length - 1; k++) {
    const [p0, c0] = COLOR_STOPS[k];
    const [p1, c1] = COLOR_STOPS[k + 1];
    if (p >= p0 && p <= p1) {
      const t = (p - p0) / (p1 - p0);
      return rgb([
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ]);
    }
  }
  return rgb(last[1]);
}

type Ring = [number, number][];
type Polygon = Ring[];

// Area-weighted centroid of a polygon ring (shoelace formula).
function ringCentroid(ring: Ring): { cx: number; cy: number; area: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return { cx: ring[0][0], cy: ring[0][1], area: 0 };
  return { cx: cx / (6 * a), cy: cy / (6 * a), area: Math.abs(a) };
}

interface Props {
  grid: IsobarGrid;
  showWind?: boolean;
}

export default function IsobarMap({ grid, showWind = true }: Props) {
  const { bbox, nx, ny, step, glenans } = grid;
  const land = useCoastline();

  // One shared Mercator projection fitted to the bbox. Everything (isobars,
  // coastline, wind, graticule, marker) is projected through it so it aligns.
  const { projection, height } = useMemo(() => {
    const poly = {
      type: "Polygon" as const,
      coordinates: [
        [
          [bbox.lonMin, bbox.latMax],
          [bbox.lonMax, bbox.latMax],
          [bbox.lonMax, bbox.latMin],
          [bbox.lonMin, bbox.latMin],
          [bbox.lonMin, bbox.latMax],
        ],
      ],
    };
    const proj = geoMercator().fitWidth(WIDTH, poly);
    const b = geoPath(proj).bounds(poly);
    const h = Math.ceil(b[1][1] - b[0][1]);
    const [tx, ty] = proj.translate();
    proj.translate([tx - b[0][0], ty - b[0][1]]);
    proj.clipExtent([
      [0, 0],
      [WIDTH, h],
    ]);
    return { projection: proj, height: h };
  }, [bbox.lonMin, bbox.lonMax, bbox.latMin, bbox.latMax]);

  const project = (lon: number, lat: number): [number, number] =>
    projection([lon, lat]) as [number, number];
  const lonToX = (lon: number) => project(lon, (bbox.latMin + bbox.latMax) / 2)[0];
  const latToY = (lat: number) => project((bbox.lonMin + bbox.lonMax) / 2, lat)[1];
  const lonOfIndex = (gi: number) =>
    bbox.lonMin + (gi / (nx - 1)) * (bbox.lonMax - bbox.lonMin);
  const latOfIndex = (gj: number) =>
    bbox.latMax - (gj / (ny - 1)) * (bbox.latMax - bbox.latMin);

  const bands = useMemo(() => {
    const toXY = (pt: [number, number]) =>
      project(lonOfIndex(pt[0]), latOfIndex(pt[1]));
    const ringToPath = (ring: Ring): string =>
      ring
        .map((pt, idx) => {
          const [x, y] = toXY(pt);
          return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join("") + "Z";
    const polygonsToPath = (polys: Polygon[]): string =>
      polys.map((poly) => poly.map(ringToPath).join("")).join("");

    // Start one step below the minimum so the lowest band fills the whole map
    // (otherwise sub-threshold corners reveal the dark SVG background).
    const lo = Math.floor(grid.min / step) * step;
    const hi = Math.floor(grid.max / step) * step;
    const thresholds = range(lo, hi + step, step);

    const generator = contours().size([nx, ny]).thresholds(thresholds);
    return generator(grid.values).map((c) => {
      const polys = c.coordinates as unknown as Polygon[];
      // Label position = centroid of the largest polygon's outer ring.
      let best: { cx: number; cy: number; area: number } | null = null;
      for (const poly of polys) {
        const cen = ringCentroid(poly[0]);
        if (!best || cen.area > best.area) best = cen;
      }
      let label: { x: number; y: number } | null = null;
      if (best && best.area > 0) {
        const [x, y] = project(lonOfIndex(best.cx), latOfIndex(best.cy));
        if (x >= 8 && x <= WIDTH - 8 && y >= 10 && y <= height - 10) {
          label = { x, y };
        }
      }
      return {
        value: c.value,
        d: polygonsToPath(polys),
        label,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.values, grid.min, grid.max, nx, ny, step, projection, height]);

  const coastPath = useMemo(
    () => (land ? geoPath(projection)(land as GeoPermissibleObjects) : null),
    [land, projection],
  );

  const winds = useMemo(() => {
    if (!showWind) return [];
    const out: ReturnType<typeof windBarb>[] = [];
    const offset = Math.floor(WIND_STRIDE / 2);
    for (let j = offset; j < ny; j += WIND_STRIDE) {
      for (let i = offset; i < nx; i += WIND_STRIDE) {
        const idx = j * nx + i;
        const [x, y] = project(lonOfIndex(i), latOfIndex(j));
        out.push(
          windBarb(x, y, grid.windSpeed[idx], grid.windDirection[idx]),
        );
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWind, nx, ny, grid.windSpeed, grid.windDirection, projection]);

  const [glenansX, glenansY] = project(glenans.lon, glenans.lat);
  const tickStep = bbox.lonMax - bbox.lonMin > 16 ? 5 : 2;
  const lonTicks = range(
    Math.ceil(bbox.lonMin / tickStep) * tickStep,
    bbox.lonMax + 1,
    tickStep,
  );
  const latTicks = range(
    Math.ceil(bbox.latMin / tickStep) * tickStep,
    bbox.latMax + 1,
    tickStep,
  );

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      width="100%"
      style={{ display: "block", borderRadius: 12, background: "#0b1020" }}
      role="img"
      aria-label="Carte des isobares autour de l'archipel des Glénans"
    >
      <defs>
        <clipPath id="map-clip">
          <rect x={0} y={0} width={WIDTH} height={height} />
        </clipPath>
      </defs>

      {/* Base layer so any area below the lowest contour gets a sensible color. */}
      <rect
        x={0}
        y={0}
        width={WIDTH}
        height={height}
        fill={pressureColor(grid.min)}
        fillOpacity={0.85}
      />

      <g clipPath="url(#map-clip)">
        {bands.map((b, i) => (
          <path
            key={`band-${i}`}
            d={b.d}
            fill={pressureColor(b.value)}
            fillOpacity={0.85}
          />
        ))}
      </g>

      <g
        clipPath="url(#map-clip)"
        fill="none"
        stroke="#0b1020"
        strokeOpacity={0.55}
        strokeWidth={1}
      >
        {bands.map((b, i) => (
          <path key={`line-${i}`} d={b.d} />
        ))}
      </g>

      {/* Coastline / land outline (Natural Earth 50m), same projection as the grid */}
      {coastPath && (
        <path
          d={coastPath}
          fill="#0b1020"
          fillOpacity={0.28}
          stroke="#ffffff"
          strokeOpacity={0.75}
          strokeWidth={1.1}
          strokeLinejoin="round"
        />
      )}

      <g
        clipPath="url(#map-clip)"
        stroke="#ffffff"
        strokeOpacity={0.12}
        strokeWidth={0.75}
        fill="#cbd5e1"
        fontSize={11}
        fontFamily="ui-monospace, monospace"
      >
        {lonTicks.map((lon) => (
          <g key={`lon-${lon}`}>
            <line x1={lonToX(lon)} y1={0} x2={lonToX(lon)} y2={height} />
            <text
              x={lonToX(lon) + 3}
              y={height - 6}
              stroke="none"
              fillOpacity={0.6}
            >
              {lon}°
            </text>
          </g>
        ))}
        {latTicks.map((lat) => (
          <g key={`lat-${lat}`}>
            <line x1={0} y1={latToY(lat)} x2={WIDTH} y2={latToY(lat)} />
            <text x={4} y={latToY(lat) - 4} stroke="none" fillOpacity={0.6}>
              {lat}°
            </text>
          </g>
        ))}
      </g>

      {/* Wind barbs (knots): half = 5, full = 10, pennant = 50 kt.
          Drawn twice: a white halo for contrast, then the dark barb on top. */}
      {showWind &&
        ([
          { stroke: "#f8fafc", width: 3.4, fill: "#f8fafc", op: 0.7 },
          { stroke: "#0b1020", width: 1.6, fill: "#0b1020", op: 1 },
        ] as const).map((layer, li) => (
          <g
            key={`windlayer-${li}`}
            clipPath="url(#map-clip)"
            stroke={layer.stroke}
            strokeWidth={layer.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={layer.fill}
            opacity={layer.op}
          >
            {winds.map((w, i) => (
              <g key={`wind-${i}`}>
                {w.calm ? (
                  <circle
                    cx={w.staff ? w.staff[0] : 0}
                    cy={w.staff ? w.staff[1] : 0}
                    r={2.5}
                    fill="none"
                  />
                ) : (
                  <>
                    <line
                      x1={w.staff![0]}
                      y1={w.staff![1]}
                      x2={w.staff![2]}
                      y2={w.staff![3]}
                    />
                    {w.barbs.map((b, k) => (
                      <line key={k} x1={b[0]} y1={b[1]} x2={b[2]} y2={b[3]} />
                    ))}
                    {w.pennants.map((p, k) => (
                      <polygon key={k} points={p} />
                    ))}
                  </>
                )}
              </g>
            ))}
          </g>
        ))}

      {/* Pressure value labels centered in each isobar zone */}
      <g
        clipPath="url(#map-clip)"
        fontFamily="ui-monospace, monospace"
        fontSize={13}
        fontWeight={700}
        textAnchor="middle"
        style={{ paintOrder: "stroke" }}
      >
        {bands.map((b, i) =>
          b.label ? (
            <text
              key={`lbl-${i}`}
              x={b.label.x}
              y={b.label.y}
              fill="#ffffff"
              stroke="#0b1020"
              strokeWidth={3.2}
              strokeLinejoin="round"
              dominantBaseline="central"
            >
              {b.value}
            </text>
          ) : null,
        )}
      </g>

      <g>
        <circle
          cx={glenansX}
          cy={glenansY}
          r={7}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2}
        />
        <circle cx={glenansX} cy={glenansY} r={2.5} fill="#ffffff" />
        <text
          x={glenansX + 12}
          y={glenansY + 4}
          fill="#ffffff"
          fontSize={14}
          fontWeight={600}
          fontFamily="system-ui, sans-serif"
          style={{ paintOrder: "stroke", stroke: "#0b1020", strokeWidth: 3 }}
        >
          Glénans
        </text>
      </g>
    </svg>
  );
}
