import { useEffect, useMemo, useRef, useState } from "react";
import { contours } from "d3-contour";
import { range } from "d3-array";
import { geoStereographic, geoPath, geoGraticule } from "d3-geo";
import type { GeoPermissibleObjects } from "d3-geo";
import type { IsobarGrid } from "./api";
import { useCoastline } from "./useCoastline";

// Bicubic upsampling factor applied to the pressure grid before contouring,
// so isobars come out as smooth curves instead of coarse polygons.
const SMOOTH_FACTOR = 6;

// Monochrome palette matching the Met Office "Black and White" surface
// pressure charts: white background, near-black ink for isobars / fronts /
// pressure centres, light grey for coastline and graticule.
const INK = "#111111";
const COAST = "#9aa0a6";
const GRATICULE = "#d2d2d2";
const PAPER = "#ffffff";
// Isobars that are multiples of this many hPa are drawn slightly bolder, like
// the reference charts (every 20 hPa: 1000, 1020, ...).
const BOLD_EVERY = 20;

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

// Catmull-Rom cubic through p1..p2 (t in [0,1]), tangents from p0 and p3.
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

// Bicubic sample of a grid (nx x ny) at fractional coordinates, edges clamped.
function sampleBicubic(
  v: number[],
  nx: number,
  ny: number,
  x: number,
  y: number,
): number {
  const x1 = Math.floor(x);
  const y1 = Math.floor(y);
  const tx = x - x1;
  const ty = y - y1;
  const cx = (i: number) => Math.max(0, Math.min(nx - 1, i));
  const cy = (j: number) => Math.max(0, Math.min(ny - 1, j));
  const col: number[] = [];
  for (let m = -1; m <= 2; m++) {
    const yy = cy(y1 + m);
    col.push(
      catmull(
        v[yy * nx + cx(x1 - 1)],
        v[yy * nx + cx(x1)],
        v[yy * nx + cx(x1 + 1)],
        v[yy * nx + cx(x1 + 2)],
        tx,
      ),
    );
  }
  return catmull(col[0], col[1], col[2], col[3], ty);
}

// Upsample a grid by an integer factor using bicubic interpolation.
function upsampleGrid(
  v: number[],
  nx: number,
  ny: number,
  f: number,
): { data: number[]; nx2: number; ny2: number } {
  const nx2 = (nx - 1) * f + 1;
  const ny2 = (ny - 1) * f + 1;
  const data = new Array<number>(nx2 * ny2);
  for (let j = 0; j < ny2; j++) {
    const sy = j / f;
    for (let i = 0; i < nx2; i++) {
      data[j * nx2 + i] = sampleBicubic(v, nx, ny, i / f, sy);
    }
  }
  return { data, nx2, ny2 };
}

// On the black-and-white chart both front types are drawn in black; they are
// told apart by their symbols (triangles = cold, semicircles = warm).
const FRONT_INK = INK;

// Catmull-Rom resampling: turn a coarse polyline into a dense, smooth one so
// the front line reads as a clean curve and local tangents are stable (which
// is what makes the pips/bumps sit cleanly perpendicular to the line).
function smoothPolyline(
  pts: [number, number][],
  samplesPerSeg = 10,
): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Cold-front triangle: base on the line, apex offset toward `side`.
function coldSymbol(
  px: number,
  py: number,
  tgx: number,
  tgy: number,
  side: [number, number],
  size: number,
): string {
  const hb = size * 0.85;
  const b1x = px - tgx * hb;
  const b1y = py - tgy * hb;
  const b2x = px + tgx * hb;
  const b2y = py + tgy * hb;
  const ax = px + side[0] * size * 1.6;
  const ay = py + side[1] * size * 1.6;
  return `M${b1x.toFixed(1)},${b1y.toFixed(1)}L${b2x.toFixed(1)},${b2y.toFixed(1)}L${ax.toFixed(1)},${ay.toFixed(1)}Z`;
}

// Warm-front semicircle: flat side on the line, bulging toward `side`.
function warmSymbol(
  px: number,
  py: number,
  tgx: number,
  tgy: number,
  side: [number, number],
  size: number,
): string {
  const steps = 10;
  let d = "";
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = px + tgx * size * ca + side[0] * size * sa;
    const y = py + tgy * size * ca + side[1] * size * sa;
    d += `${k === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d + "Z";
}

interface Props {
  grid: IsobarGrid;
  showWind?: boolean;
  showFronts?: boolean;
}

export default function IsobarMap({
  grid,
  showWind = true,
  showFronts = true,
}: Props) {
  const { bbox, nx, ny, step, glenans } = grid;
  const land = useCoastline();

  // The map fills its container; we measure the actual pixel size and fit the
  // projection to *cover* it (no letterboxing), so it works as a full-screen
  // backdrop at any aspect ratio.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      // Round to limit recomputes during continuous resize.
      const w = Math.max(1, Math.round(el.clientWidth / 2) * 2);
      const h = Math.max(1, Math.round(el.clientHeight / 2) * 2);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const WIDTH = size.w;
  const height = size.h;

  // Polar-stereographic projection, like the Met Office surface pressure
  // charts: the central meridian points straight up toward the pole, meridians
  // fan out and parallels curve. Everything (isobars, coastline, wind,
  // graticule, marker) is projected through it so it stays aligned. Fitted to
  // *cover* the viewport (scale = max of the two axes).
  const projection = useMemo(() => {
    const lon0 = (bbox.lonMin + bbox.lonMax) / 2;
    // Dense bbox outline so fit / clip are accurate on a curved projection.
    const n = 48;
    const ring: [number, number][] = [];
    for (let i = 0; i <= n; i++)
      ring.push([bbox.lonMin + ((bbox.lonMax - bbox.lonMin) * i) / n, bbox.latMax]);
    for (let i = 0; i <= n; i++)
      ring.push([bbox.lonMax, bbox.latMax - ((bbox.latMax - bbox.latMin) * i) / n]);
    for (let i = 0; i <= n; i++)
      ring.push([bbox.lonMax - ((bbox.lonMax - bbox.lonMin) * i) / n, bbox.latMin]);
    for (let i = 0; i <= n; i++)
      ring.push([bbox.lonMin, bbox.latMin + ((bbox.latMax - bbox.latMin) * i) / n]);
    const outline = { type: "Polygon" as const, coordinates: [ring] };

    const proj = geoStereographic().rotate([-lon0, -90]).precision(0.1);
    proj.scale(1).translate([0, 0]);
    const b = geoPath(proj).bounds(outline);
    const bw = b[1][0] - b[0][0];
    const bh = b[1][1] - b[0][1];
    // Cover the viewport, then overscan a little so the curved bbox edges (and
    // the graticule frame) sit just outside the screen instead of leaving white
    // margins in the corners.
    const OVERSCAN = 2;
    const s = Math.max(WIDTH / bw, height / bh) * OVERSCAN;
    proj.scale(s).translate([
      (WIDTH - s * (b[1][0] + b[0][0])) / 2,
      (height - s * (b[1][1] + b[0][1])) / 2,
    ]);
    proj.clipExtent([
      [0, 0],
      [WIDTH, height],
    ]);
    return proj;
  }, [bbox.lonMin, bbox.lonMax, bbox.latMin, bbox.latMax, WIDTH, height]);

  const project = (lon: number, lat: number): [number, number] =>
    projection([lon, lat]) as [number, number];
  const lonOfIndex = (gi: number) =>
    bbox.lonMin + (gi / (nx - 1)) * (bbox.lonMax - bbox.lonMin);
  const latOfIndex = (gj: number) =>
    bbox.latMax - (gj / (ny - 1)) * (bbox.latMax - bbox.latMin);

  const bands = useMemo(() => {
    // Upsample the coarse grid so the marching-squares contours come out smooth.
    const { data, nx2, ny2 } = upsampleGrid(grid.values, nx, ny, SMOOTH_FACTOR);
    // Fine grid index -> geographic coordinate (fractional positions match the
    // original grid because (nx2 - 1) = (nx - 1) * factor).
    const lonOfFine = (gi: number) =>
      bbox.lonMin + (gi / (nx2 - 1)) * (bbox.lonMax - bbox.lonMin);
    const latOfFine = (gj: number) =>
      bbox.latMax - (gj / (ny2 - 1)) * (bbox.latMax - bbox.latMin);

    const ringToPath = (ring: Ring): string =>
      ring
        .map((pt, idx) => {
          const [x, y] = project(lonOfFine(pt[0]), latOfFine(pt[1]));
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

    // Place the isobar value ON its contour line (like synoptic charts): pick
    // the most interior vertex of the largest ring and rotate to the local
    // tangent so the number reads along the isobar.
    const labelOnRing = (
      ring: Ring,
    ): { x: number; y: number; angle: number } | null => {
      const m = 46;
      const pts = ring.map((pt) => project(lonOfFine(pt[0]), latOfFine(pt[1])));
      const n = pts.length;
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < n; i++) {
        const [x, y] = pts[i];
        if (x < m || x > WIDTH - m || y < 16 || y > height - 16) continue;
        const dEdge = Math.min(x, WIDTH - x, y, height - y);
        if (dEdge > bestScore) {
          bestScore = dEdge;
          best = i;
        }
      }
      if (best < 0) return null;
      const [x, y] = pts[best];
      const a = pts[(best - 2 + n) % n];
      const b = pts[(best + 2) % n];
      let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      return { x, y, angle };
    };

    const generator = contours().size([nx2, ny2]).thresholds(thresholds);
    return generator(data).map((c) => {
      const polys = c.coordinates as unknown as Polygon[];
      // Find the largest polygon's outer ring and label along it.
      let bestArea = 0;
      let bestRing: Ring | null = null;
      for (const poly of polys) {
        const cen = ringCentroid(poly[0]);
        if (cen.area > bestArea) {
          bestArea = cen.area;
          bestRing = poly[0];
        }
      }
      const label = bestRing && bestArea > 0 ? labelOnRing(bestRing) : null;
      return {
        value: c.value,
        d: polygonsToPath(polys),
        label,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.values, grid.min, grid.max, nx, ny, step, projection, height]);

  // Pressure centres: regional minima (lows / "D") and maxima (highs / "A").
  // A point qualifies only if it is the strict extremum within a wide window
  // (Chebyshev radius R) and stands out from that window by PROMINENCE hPa.
  // This keeps only the few synoptically significant centres, not grid noise.
  const centers = useMemo(() => {
    const R = 3;
    const PROMINENCE = 1.0; // hPa above/below the window mean
    const v = grid.values;
    const out: Array<{ type: "L" | "H"; x: number; y: number; p: number }> = [];
    for (let j = R; j < ny - R; j++) {
      for (let i = R; i < nx - R; i++) {
        const c = v[j * nx + i];
        let isMin = true;
        let isMax = true;
        let sum = 0;
        let count = 0;
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            if (!di && !dj) continue;
            const nb = v[(j + dj) * nx + (i + di)];
            if (nb <= c) isMin = false;
            if (nb >= c) isMax = false;
            sum += nb;
            count++;
          }
        }
        if (!isMin && !isMax) continue;
        const avg = sum / count;
        const [x, y] = project(lonOfIndex(i), latOfIndex(j));
        if (x < 16 || x > WIDTH - 16 || y < 18 || y > height - 18) continue;
        if (isMin && avg - c >= PROMINENCE) out.push({ type: "L", x, y, p: Math.round(c) });
        else if (isMax && c - avg >= PROMINENCE) out.push({ type: "H", x, y, p: Math.round(c) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.values, nx, ny, projection, height]);

  // Objective synoptic features computed server-side: cold (triangles), warm
  // (semicircles), occluded (alternating triangle/semicircle) and dashed
  // pressure troughs. Project the polylines to screen space and pre-build the
  // symbol paths.
  type FrontDraw = {
    type: "cold" | "warm" | "occluded" | "trough";
    line: string;
    symbols: string[];
  };
  const fronts = useMemo<FrontDraw[]>(() => {
    if (!showFronts) return [];
    const SPACING = 30;
    const SIZE = 7;
    return (grid.fronts ?? [])
      .map((f): FrontDraw | null => {
        const raw = f.points.map(([lon, lat]) => project(lon, lat));
        if (raw.length < 2) return null;
        // Smooth the projected polyline so the line is a clean curve and the
        // per-point tangents (hence the symbol orientation) are stable.
        const pts = smoothPolyline(raw, 12);
        const line = pts
          .map((p, idx) => `${idx ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
          .join("");

        // Troughs are a bare dashed axis, no symbols.
        if (f.type === "trough" || !f.warm) {
          return { type: "trough", line, symbols: [] };
        }

        // Warm-air direction in screen space (from the geographic warm vector),
        // sampled at the middle of the front. Used only to pick which side of
        // the line the symbols go on; the exact orientation comes from the
        // local curve normal so pips stay perpendicular along the whole curve.
        const mid = f.points[Math.floor(f.points.length / 2)];
        const [mx, my] = project(mid[0], mid[1]);
        const [wx, wy] = project(mid[0] + f.warm[0] * 0.6, mid[1] + f.warm[1] * 0.6);
        const wlen = Math.hypot(wx - mx, wy - my) || 1;
        const warmS: [number, number] = [(wx - mx) / wlen, (wy - my) / wlen];
        // Cold + occluded symbols sit on the warm side; warm-front bumps on the
        // cold side.
        const want: [number, number] =
          f.type === "warm" ? [-warmS[0], -warmS[1]] : warmS;

        const symbols: string[] = [];
        let acc = 0;
        let nextAt = SPACING * 0.6;
        let symIdx = 0;
        for (let s = 1; s < pts.length; s++) {
          const [x0, y0] = pts[s - 1];
          const [x1, y1] = pts[s];
          const segLen = Math.hypot(x1 - x0, y1 - y0);
          if (segLen < 1e-6) continue;
          const tgx = (x1 - x0) / segLen;
          const tgy = (y1 - y0) / segLen;
          // Local normal, flipped so it points to the desired (warm/cold) side.
          let nx = -tgy;
          let ny = tgx;
          if (nx * want[0] + ny * want[1] < 0) {
            nx = -nx;
            ny = -ny;
          }
          while (acc + segLen >= nextAt) {
            const tloc = nextAt - acc;
            const px = x0 + tgx * tloc;
            const py = y0 + tgy * tloc;
            // Occluded fronts alternate a triangle then a semicircle.
            const cold =
              f.type === "cold" || (f.type === "occluded" && symIdx % 2 === 0);
            symbols.push(
              cold
                ? coldSymbol(px, py, tgx, tgy, [nx, ny], SIZE)
                : warmSymbol(px, py, tgx, tgy, [nx, ny], SIZE),
            );
            symIdx += 1;
            nextAt += SPACING;
          }
          acc += segLen;
        }
        return { type: f.type, line, symbols };
      })
      .filter((f): f is FrontDraw => f !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFronts, grid, projection]);

  const coastPath = useMemo(
    () => (land ? geoPath(projection)(land as GeoPermissibleObjects) : null),
    [land, projection],
  );

  // Windy-style animated wind field on a canvas layer below the SVG. Particles
  // follow the interpolated flow and leave fading trails; the canvas also
  // paints the white "paper" so the SVG above it can stay transparent.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const setup = () => {
      const cssW = container.clientWidth || WIDTH;
      const cssH = container.clientHeight || height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      // Draw in logical coordinates (0..WIDTH, 0..height); scale to device px.
      ctx.setTransform((cssW * dpr) / WIDTH, 0, 0, (cssH * dpr) / height, 0, 0);
    };
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(container);

    const paintPaper = () => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    };

    if (!showWind) {
      paintPaper();
      return () => ro.disconnect();
    }

    // Blowing-to wind components (knots) at each grid node.
    const U = new Float32Array(nx * ny);
    const V = new Float32Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) {
      const r = (grid.windDirection[k] * Math.PI) / 180;
      U[k] = -grid.windSpeed[k] * Math.sin(r);
      V[k] = -grid.windSpeed[k] * Math.cos(r);
    }
    const sampleNode = (arr: Float32Array, fi: number, fj: number) => {
      const i0 = Math.max(0, Math.min(nx - 2, Math.floor(fi)));
      const j0 = Math.max(0, Math.min(ny - 2, Math.floor(fj)));
      const tx = Math.max(0, Math.min(1, fi - i0));
      const ty = Math.max(0, Math.min(1, fj - j0));
      const a = arr[j0 * nx + i0];
      const b = arr[j0 * nx + i0 + 1];
      const c = arr[(j0 + 1) * nx + i0];
      const d = arr[(j0 + 1) * nx + i0 + 1];
      return (
        a * (1 - tx) * (1 - ty) +
        b * tx * (1 - ty) +
        c * (1 - tx) * ty +
        d * tx * ty
      );
    };

    // Pre-compute a screen-space velocity field on a coarse lattice so each
    // particle step is a cheap bilinear lookup (no per-particle reprojection).
    const STEP = 14;
    const cols = Math.floor(WIDTH / STEP) + 2;
    const rows = Math.floor(height / STEP) + 2;
    const FVX = new Float32Array(cols * rows);
    const FVY = new Float32Array(cols * rows);
    const FMAG = new Float32Array(cols * rows); // < 0 means outside the data
    const EPS = 0.6; // deg step for the finite-difference reprojection
    const invert = projection.invert;
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        const x = cc * STEP;
        const y = rr * STEP;
        const idx = rr * cols + cc;
        const ll = invert ? invert([x, y]) : null;
        if (!ll) {
          FMAG[idx] = -1;
          continue;
        }
        const [lon, lat] = ll;
        const fi = ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * (nx - 1);
        const fj = ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * (ny - 1);
        if (fi < 0 || fi > nx - 1 || fj < 0 || fj > ny - 1) {
          FMAG[idx] = -1;
          continue;
        }
        const ue = sampleNode(U, fi, fj);
        const vn = sampleNode(V, fi, fj);
        const dlon = (ue / (111 * Math.cos((lat * Math.PI) / 180))) * EPS;
        const dlat = (vn / 111) * EPS;
        const p2 = projection([lon + dlon, lat + dlat]) as
          | [number, number]
          | null;
        if (!p2) {
          FMAG[idx] = -1;
          continue;
        }
        FVX[idx] = p2[0] - x;
        FVY[idx] = p2[1] - y;
        FMAG[idx] = Math.hypot(ue, vn);
      }
    }
    const sampleField = (x: number, y: number) => {
      const c0 = Math.max(0, Math.min(cols - 1, Math.round(x / STEP)));
      const r0 = Math.max(0, Math.min(rows - 1, Math.round(y / STEP)));
      const idx = r0 * cols + c0;
      return { vx: FVX[idx], vy: FVY[idx], mag: FMAG[idx] };
    };

    type P = { x: number; y: number; age: number };
    const COUNT = Math.round((WIDTH * height) / 280);
    const MAX_AGE = 90;
    const SPEED = 1.0;
    // `seed` spreads the initial ages so particles don't pulse in unison; a
    // normal respawn starts at full life so it can fade in smoothly from zero.
    const spawn = (p: P, seed = false) => {
      p.x = Math.random() * WIDTH;
      p.y = Math.random() * height;
      p.age = seed ? Math.random() * MAX_AGE : MAX_AGE;
    };
    const parts: P[] = [];
    for (let i = 0; i < COUNT; i++) {
      const p = { x: 0, y: 0, age: 0 };
      spawn(p, true);
      parts.push(p);
    }

    paintPaper();
    let raf = 0;
    const tick = () => {
      // Fade toward the paper colour to leave short trails (higher alpha =
      // shorter, subtler trails).
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(0, 0, WIDTH, height);
      ctx.lineWidth = 1.0;
      ctx.lineCap = "round";
      for (const p of parts) {
        const f = sampleField(p.x, p.y);
        if (f.mag < 0) {
          spawn(p);
          continue;
        }
        const x2 = p.x + f.vx * SPEED;
        const y2 = p.y + f.vy * SPEED;
        // Smoothly fade each particle in at birth and out near death so they
        // never pop; combined with a lower base opacity the field stays
        // discreet over the chart.
        const ageFrac = p.age / MAX_AGE;
        const env = Math.max(
          0,
          Math.min(1, (1 - ageFrac) / 0.15, ageFrac / 0.15),
        );
        const alpha = Math.min(0.4, 0.06 + f.mag / 85) * env;
        ctx.strokeStyle = `rgba(38,60,92,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        p.x = x2;
        p.y = y2;
        p.age -= 1;
        if (p.age <= 0 || x2 < 0 || x2 > WIDTH || y2 < 0 || y2 > height) {
          spawn(p);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.updatedAt, showWind, projection, height]);

  const [glenansX, glenansY] = project(glenans.lon, glenans.lat);
  const lonSpan = bbox.lonMax - bbox.lonMin;
  const tickStep = lonSpan > 40 ? 10 : lonSpan > 16 ? 5 : 2;
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

  // Curved graticule (meridians + parallels) matching the polar projection.
  // The extent is padded well beyond the data bbox so the outermost grid lines
  // fall outside the (clipped) viewport instead of forming a visible frame.
  const graticulePath = useMemo(() => {
    const g = geoGraticule()
      .stepMinor([tickStep, tickStep])
      .extentMinor([
        [bbox.lonMin - 30, bbox.latMin - 16],
        [bbox.lonMax + 30, bbox.latMax + 16],
      ]);
    return geoPath(projection)(g());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, tickStep, bbox.lonMin, bbox.lonMax, bbox.latMin, bbox.latMax]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: PAPER,
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ display: "block", position: "absolute", inset: 0, background: "transparent" }}
        role="img"
        aria-label="Carte des isobares autour de l'archipel des Glénans"
      >
        <defs>
          <clipPath id="map-clip">
            <rect x={0} y={0} width={WIDTH} height={height} />
          </clipPath>
        </defs>

      {/* Coastline / land outline (Natural Earth 50m), same projection as grid. */}
      {coastPath && (
        <path
          d={coastPath}
          fill="none"
          stroke={COAST}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      )}

      {/* Curved graticule (meridians + parallels) for the polar projection. */}
      <g clipPath="url(#map-clip)">
        {graticulePath && (
          <path
            d={graticulePath}
            fill="none"
            stroke={GRATICULE}
            strokeWidth={0.8}
          />
        )}
        <g
          fill={COAST}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          stroke="none"
        >
          {lonTicks.map((lon) => {
            const [x, y] = project(lon, bbox.latMin);
            return (
              <text key={`lon-${lon}`} x={x} y={Math.min(y, height) - 5} textAnchor="middle">
                {lon}°
              </text>
            );
          })}
          {latTicks.map((lat) => {
            const [x, y] = project(bbox.lonMin, lat);
            return (
              <text key={`lat-${lat}`} x={Math.max(x, 0) + 4} y={y - 4}>
                {lat}°
              </text>
            );
          })}
        </g>
      </g>

      {/* Isobars: thin black lines (no colour fill), bolder every 20 hPa. */}
      <g clipPath="url(#map-clip)" fill="none" stroke={INK} strokeLinejoin="round">
        {bands.map((b, i) => (
          <path
            key={`line-${i}`}
            d={b.d}
            strokeWidth={b.value % BOLD_EVERY === 0 ? 1.6 : 0.9}
          />
        ))}
      </g>

      {/* Objective features: cold (triangles), warm (semicircles), occluded
          (alternating) and dashed pressure troughs, all black. A thin white
          halo keeps solid front lines readable where they cross isobars. */}
      {showFronts && fronts.length > 0 && (
        <g clipPath="url(#map-clip)">
          {fronts.map((f, i) =>
            f.type === "trough" ? null : (
              <path
                key={`front-halo-${i}`}
                d={f.line}
                fill="none"
                stroke={PAPER}
                strokeWidth={4.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
          )}
          {fronts.map((f, i) => (
            <path
              key={`front-line-${i}`}
              d={f.line}
              fill="none"
              stroke={FRONT_INK}
              strokeWidth={f.type === "trough" ? 1.6 : 2.4}
              strokeDasharray={f.type === "trough" ? "2 6" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {fronts.map((f, i) => (
            <g key={`front-sym-${i}`} fill={FRONT_INK} stroke="none">
              {f.symbols.map((d, k) => (
                <path key={k} d={d} />
              ))}
            </g>
          ))}
        </g>
      )}

      {/* Pressure value labels sitting on each isobar line, rotated to follow
          it; the white halo opens a gap in the line like on synoptic charts. */}
      <g
        clipPath="url(#map-clip)"
        fontFamily="ui-monospace, monospace"
        fontSize={12}
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
              transform={`rotate(${b.label.angle} ${b.label.x} ${b.label.y})`}
              fill={INK}
              stroke={PAPER}
              strokeWidth={3.2}
              strokeLinejoin="round"
              dominantBaseline="central"
            >
              {b.value}
            </text>
          ) : null,
        )}
      </g>

      {/* Pressure centres: H = high (anticyclone), L = low (depression), black. */}
      <g
        clipPath="url(#map-clip)"
        fontFamily="system-ui, 'Segoe UI', Roboto, sans-serif"
        textAnchor="middle"
        style={{ paintOrder: "stroke" }}
      >
        {centers.map((c, i) => (
          <g key={`center-${i}`}>
            <text
              x={c.x}
              y={c.y}
              fontSize={34}
              fontWeight={700}
              fill={INK}
              stroke={PAPER}
              strokeWidth={4.5}
              strokeLinejoin="round"
              dominantBaseline="central"
            >
              {c.type === "L" ? "L" : "H"}
            </text>
            <text
              x={c.x}
              y={c.y + 22}
              fontSize={12}
              fontWeight={700}
              fill={INK}
              stroke={PAPER}
              strokeWidth={3}
              strokeLinejoin="round"
              dominantBaseline="central"
            >
              {c.p}
            </text>
          </g>
        ))}
      </g>

      <g>
        <circle
          cx={glenansX}
          cy={glenansY}
          r={6}
          fill="none"
          stroke={INK}
          strokeWidth={1.5}
          style={{ paintOrder: "stroke", stroke: PAPER }}
        />
        <circle
          cx={glenansX}
          cy={glenansY}
          r={5}
          fill="none"
          stroke={INK}
          strokeWidth={1.5}
        />
        <circle cx={glenansX} cy={glenansY} r={2} fill={INK} />
        <text
          x={glenansX + 11}
          y={glenansY + 4}
          fill={INK}
          fontSize={14}
          fontWeight={600}
          fontFamily="system-ui, sans-serif"
          style={{ paintOrder: "stroke", stroke: PAPER, strokeWidth: 3.5 }}
        >
          Glénans
        </text>
      </g>
      </svg>
    </div>
  );
}
