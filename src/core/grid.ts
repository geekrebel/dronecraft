import { XY, closedRingOpen, dist } from './projection';

export interface Line {
  start: XY;
  end: XY;
  /** Planned waypoints along the line (t 0..1, altitude above takeoff). Set once altitudes are planned. */
  wps?: { t: number; alt: number }[];
}

const DEG = Math.PI / 180;

function rotate([x, y]: XY, angleRad: number): XY {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [x * c - y * s, x * s + y * c];
}

/** Angle in degrees (0..180) of the polygon's longest edge, measured from the +x (east) axis. */
export function longestEdgeAngle(ring: XY[]): number {
  const pts = closedRingOpen(ring);
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = dist(a, b);
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
    }
  }
  return ((best % 180) + 180) % 180;
}

/**
 * Generate serpentine flight lines covering a polygon (local metric coords).
 * `angleDeg` is the direction lines run in, from +x (east), counter-clockwise.
 * Lines are inset by half a spacing from the polygon's extent and extended by `bufferM` at each end.
 * Concave polygons can produce several segments per scanline; each becomes its own line.
 */
export function generateLines(ring: XY[], spacingM: number, angleDeg: number, bufferM: number): Line[] {
  if (spacingM <= 0) throw new Error('spacing must be positive');
  const pts = closedRingOpen(ring);
  if (pts.length < 3) return [];
  const a = angleDeg * DEG;
  // Rotate polygon so flight lines run along +x.
  const rot = pts.map((p) => rotate(p, -a));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of rot) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const height = maxY - minY;
  // Epsilon guards against rotation round-off adding a spurious extra line.
  const n = Math.max(1, Math.ceil(height / spacingM - 1e-6));
  // Centre the set of lines within the polygon's extent.
  const firstY = minY + (height - (n - 1) * spacingM) / 2;

  const lines: Line[] = [];
  let forward = true;
  for (let k = 0; k < n; k++) {
    const y = firstY + k * spacingM;
    const xs: number[] = [];
    for (let i = 0; i < rot.length; i++) {
      const [x1, y1] = rot[i];
      const [x2, y2] = rot[(i + 1) % rot.length];
      // Half-open interval avoids double-counting shared vertices.
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    const segs: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i] - bufferM, xs[i + 1] + bufferM]);
    if (!forward) segs.reverse();
    for (const [x0, x1] of segs) {
      const s: XY = forward ? [x0, y] : [x1, y];
      const e: XY = forward ? [x1, y] : [x0, y];
      lines.push({ start: rotate(s, a), end: rotate(e, a) });
    }
    if (segs.length) forward = !forward;
  }
  return lines;
}

export function lineLength(l: Line): number {
  return dist(l.start, l.end);
}
