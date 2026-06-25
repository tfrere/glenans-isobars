// Wind barb geometry generator (meteorological convention).
// Given a position and wind (knots + direction the wind comes FROM),
// returns SVG primitives in pixel space: a staff line, barb segments
// (half = 5 kt, full = 10 kt) and pennants (filled triangles = 50 kt).

export interface WindBarb {
  calm: boolean; // < 5 kt -> draw an open circle instead of a staff
  staff: [number, number, number, number] | null;
  barbs: Array<[number, number, number, number]>;
  pennants: string[]; // polygon "x,y x,y x,y" point lists
}

const STAFF_LEN = 30;
const BARB_FULL = 13;
const BARB_HALF = 7.5;
const STEP = 5; // spacing between consecutive barbs along the staff
const PENNANT_W = 8; // width a pennant occupies along the staff
const BARB_ANGLE = (120 * Math.PI) / 180;

function rotate(
  vx: number,
  vy: number,
  a: number,
): [number, number] {
  return [vx * Math.cos(a) - vy * Math.sin(a), vx * Math.sin(a) + vy * Math.cos(a)];
}

export function windBarb(
  x: number,
  y: number,
  speedKn: number,
  dirDeg: number,
): WindBarb {
  // Round to nearest 5 kt as barbs are quantized.
  const total = Math.round(speedKn / 5) * 5;

  if (total < 5) {
    return { calm: true, staff: null, barbs: [], pennants: [] };
  }

  const dir = (dirDeg * Math.PI) / 180;
  // Staff points toward the direction the wind comes FROM (north = up).
  const ux = Math.sin(dir);
  const uy = -Math.cos(dir);
  // Direction along the staff, from tip back toward the station dot.
  const ax = -ux;
  const ay = -uy;
  // Barb direction (slants back from the staff).
  const [bx, by] = rotate(ux, uy, BARB_ANGLE);

  const tipX = x + STAFF_LEN * ux;
  const tipY = y + STAFF_LEN * uy;

  const barbs: Array<[number, number, number, number]> = [];
  const pennants: string[] = [];

  let pennantCount = Math.floor(total / 50);
  let rem = total % 50;
  let fullCount = Math.floor(rem / 10);
  let halfCount = Math.floor((rem % 10) / 5);

  let px = tipX;
  let py = tipY;

  for (let k = 0; k < pennantCount; k++) {
    const baseX = px;
    const baseY = py;
    const apexX = px + BARB_FULL * bx;
    const apexY = py + BARB_FULL * by;
    const endX = px + PENNANT_W * ax;
    const endY = py + PENNANT_W * ay;
    pennants.push(`${baseX},${baseY} ${apexX},${apexY} ${endX},${endY}`);
    px = endX;
    py = endY;
  }

  // Small gap after pennants before the first barb.
  if (pennantCount > 0) {
    px += STEP * 0.4 * ax;
    py += STEP * 0.4 * ay;
  }

  for (let k = 0; k < fullCount; k++) {
    barbs.push([px, py, px + BARB_FULL * bx, py + BARB_FULL * by]);
    px += STEP * ax;
    py += STEP * ay;
  }

  for (let k = 0; k < halfCount; k++) {
    // A lone half barb sits slightly inboard of the tip, by convention.
    if (fullCount === 0 && pennantCount === 0) {
      px += STEP * ax;
      py += STEP * ay;
    }
    barbs.push([px, py, px + BARB_HALF * bx, py + BARB_HALF * by]);
    px += STEP * ax;
    py += STEP * ay;
  }

  return {
    calm: false,
    staff: [x, y, tipX, tipY],
    barbs,
    pennants,
  };
}
