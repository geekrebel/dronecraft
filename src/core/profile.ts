/**
 * Terrain following: choose waypoint altitudes along a flight line so the drone stays close to
 * a target height above a surface, and measure clearance along the resulting straight segments.
 */
import type { Line } from './grid';
import { XY, dist } from './projection';

/** A waypoint along a line: `t` is 0..1 from line start to end, `alt` is metres above takeoff. */
export interface LineWp {
  t: number;
  alt: number;
}

export const at = (l: Line, t: number): XY => [l.start[0] + (l.end[0] - l.start[0]) * t, l.start[1] + (l.end[1] - l.start[1]) * t];

/**
 * Waypoints along `l` whose straight-line altitude interpolation stays within `tolM` of
 * `target(xy)` at every sample (every `stepM`). Always includes both ends.
 * Greedy split at the worst sample (Douglas-Peucker on the altitude profile).
 */
export function profileLine(l: Line, target: (xy: XY) => number, tolM = 5, stepM = 10): LineWp[] {
  const len = dist(l.start, l.end);
  const n = Math.max(1, Math.ceil(len / stepM));
  const ts = Array.from({ length: n + 1 }, (_, i) => i / n);
  const zs = ts.map((t) => target(at(l, t)));
  const keep = new Set([0, n]);
  const split = (a: number, b: number) => {
    let worst = -1;
    let worstDev = tolM;
    for (let i = a + 1; i < b; i++) {
      const interp = zs[a] + ((zs[b] - zs[a]) * (ts[i] - ts[a])) / (ts[b] - ts[a]);
      const dev = Math.abs(zs[i] - interp);
      if (dev > worstDev) {
        worstDev = dev;
        worst = i;
      }
    }
    if (worst < 0) return;
    keep.add(worst);
    split(a, worst);
    split(worst, b);
  };
  split(0, n);
  return [...keep].sort((a, b) => a - b).map((i) => ({ t: ts[i], alt: zs[i] }));
}

/** A 3D polyline vertex: local position and altitude above takeoff. */
export interface PathPt {
  xy: XY;
  alt: number;
}

export interface PathStats {
  /** Smallest (drone altitude − surface) along the path, metres. */
  minClearance: number;
  /** Where the smallest clearance occurs. */
  minClearanceAt: XY | null;
  /** Largest (drone altitude − bare ground), metres. */
  maxAboveGround: number;
}

/**
 * Sample straight segments between consecutive vertices every `stepM` and compare with the
 * surface (treetops) and the bare ground. Altitudes are above takeoff; `homeElev` converts.
 */
export function pathStats(
  path: PathPt[],
  surface: (xy: XY) => number,
  ground: (xy: XY) => number,
  homeElev: number,
  stepM = 10,
): PathStats {
  let minC = Infinity;
  let minAt: XY | null = null;
  let maxG = -Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const n = Math.max(1, Math.ceil(dist(a.xy, b.xy) / stepM));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const xy: XY = [a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t];
      const abs = homeElev + a.alt + (b.alt - a.alt) * t;
      const c = abs - surface(xy);
      if (c < minC) {
        minC = c;
        minAt = xy;
      }
      maxG = Math.max(maxG, abs - ground(xy));
    }
  }
  if (path.length === 1) {
    const abs = homeElev + path[0].alt;
    minC = abs - surface(path[0].xy);
    minAt = path[0].xy;
    maxG = abs - ground(path[0].xy);
  }
  return { minClearance: minC, minClearanceAt: minAt, maxAboveGround: maxG };
}

/** Largest vertical speed (m/s) needed between consecutive vertices at horizontal speed `speedMs`. */
export function maxVerticalSpeed(path: PathPt[], speedMs: number): number {
  let v = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const h = dist(path[i].xy, path[i + 1].xy);
    const dz = Math.abs(path[i + 1].alt - path[i].alt);
    if (h < 1e-6) continue; // pure vertical moves (climb above takeoff) use the drone's own climb rate
    v = Math.max(v, (dz * speedMs) / h);
  }
  return v;
}

/** Highest value of `need(xy)` along the straight segment a→b, sampled every `stepM`. */
export function maxAlong(a: XY, b: XY, need: (xy: XY) => number, stepM = 10): number {
  const n = Math.max(1, Math.ceil(dist(a, b) / stepM));
  let m = -Infinity;
  for (let k = 0; k <= n; k++) m = Math.max(m, need([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
  return m;
}
