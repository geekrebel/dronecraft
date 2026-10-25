/**
 * The exported flight, waypoint by waypoint. Timing, safety checks, Litchi CSV and KML are all
 * derived from this one sequence so they cannot disagree.
 *
 * Litchi semantics used here (flylitchi.com/help#waypoint):
 * - a waypoint's speed applies on the leg from that waypoint to the next;
 * - a waypoint's photo interval applies on the leg from that waypoint to the next;
 * - consecutive waypoints must be 0.6 m to 1999 m apart (3D);
 * - altitudes are relative to the takeoff point.
 */
import type { Line } from './grid';
import { at } from './profile';
import { XY, dist } from './projection';

export type WpKind = 'climb' | 'transit' | 'line' | 'lineEnd';

export interface ItinWp {
  xy: XY;
  /** Metres above takeoff. */
  alt: number;
  /** Speed on the leg from this waypoint to the next, m/s. */
  speed: number;
  /** Photos on the leg from this waypoint to the next. */
  photo: boolean;
  /** Direction of travel along the mapping line, compass degrees. */
  heading: number;
  kind: WpKind;
}

export interface ItinOptions {
  speedMs: number;
  transitSpeedMs: number;
  /** Altitude of the first waypoint straight above takeoff. */
  climbAltM: number;
  /** Longest leg allowed before inserting intermediate waypoints. Below Litchi's 1999 m. */
  maxLegM?: number;
}

export const MAX_LEG_M = 1500;
export const LITCHI_MIN_LEG_M = 0.6;
export const LITCHI_MAX_LEG_M = 1999;

export function headingDeg(dx: number, dy: number): number {
  const h = (Math.atan2(dx, dy) * 180) / Math.PI;
  return Math.round(((h % 360) + 360) % 360);
}

export const leg3d = (a: ItinWp, b: ItinWp) => Math.hypot(dist(a.xy, b.xy), b.alt - a.alt);

/** Lines must already carry their planned waypoints (`wps`). */
export function buildItinerary(lines: Line[], home: XY, o: ItinOptions): ItinWp[] {
  const maxLeg = o.maxLegM ?? MAX_LEG_M;
  const out: ItinWp[] = [];
  if (!lines.length) return out;
  const first = lines[0];
  const firstAlt = first.wps?.[0]?.alt ?? o.climbAltM;
  // Climb straight up over takeoff, then fly out at transit speed with photos off.
  const climb: ItinWp = {
    xy: home,
    alt: o.climbAltM,
    speed: o.transitSpeedMs,
    photo: false,
    heading: headingDeg(first.start[0] - home[0], first.start[1] - home[1]),
    kind: 'climb',
  };
  if (Math.hypot(dist(home, first.start), firstAlt - o.climbAltM) >= 1) out.push(climb);

  for (const l of lines) {
    const h = headingDeg(l.end[0] - l.start[0], l.end[1] - l.start[1]);
    const wps = l.wps ?? [
      { t: 0, alt: firstAlt },
      { t: 1, alt: firstAlt },
    ];
    wps.forEach((w, i) => {
      const last = i === wps.length - 1;
      out.push({ xy: at(l, w.t), alt: w.alt, speed: o.speedMs, photo: !last, heading: h, kind: last ? 'lineEnd' : 'line' });
    });
  }
  return subdivide(out, maxLeg);
}

/** Insert evenly spaced waypoints on any leg longer than `maxLeg`; they inherit the leg's speed and photo setting. */
export function subdivide(wps: ItinWp[], maxLeg: number): ItinWp[] {
  const out: ItinWp[] = [];
  for (let i = 0; i < wps.length; i++) {
    const a = wps[i];
    out.push(a);
    const b = wps[i + 1];
    if (!b) break;
    const n = Math.ceil(leg3d(a, b) / maxLeg);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push({
        ...a,
        xy: [a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t],
        alt: a.alt + (b.alt - a.alt) * t,
        kind: a.kind === 'climb' ? 'transit' : a.kind === 'lineEnd' ? 'lineEnd' : a.kind,
      });
    }
  }
  return out;
}

export interface TimingOptions {
  climbMs: number;
  descentMs: number;
  /** Litchi "Straight lines" path mode stops at every waypoint. */
  perWaypointS: number;
  /** Speed of the automatic return home after the last waypoint. */
  returnSpeedMs: number;
  /** RTH climbs to this altitude above takeoff first if it is lower. */
  rthAltM?: number;
}

/**
 * Flight time for the itinerary from takeoff to landing at home, including the vertical climb,
 * each leg at its own speed (slowed if the altitude change needs more than the climb or descent rate),
 * a stop at each waypoint, and the return home.
 */
export function itineraryTime(wps: ItinWp[], home: XY, t: TimingOptions): number {
  if (!wps.length) return 0;
  let s = Math.max(0, wps[0].alt) / t.climbMs + dist(home, wps[0].xy) / t.returnSpeedMs;
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    const h = dist(a.xy, b.xy);
    const dz = b.alt - a.alt;
    const vRate = dz > 0 ? t.climbMs : t.descentMs;
    s += Math.max(h / a.speed, Math.abs(dz) / vRate);
  }
  s += wps.length * t.perWaypointS;
  const last = wps[wps.length - 1];
  const rth = Math.max(last.alt, t.rthAltM ?? -Infinity);
  s += Math.max(0, rth - last.alt) / t.climbMs + dist(last.xy, home) / t.returnSpeedMs + Math.max(0, rth) / t.descentMs;
  return s;
}

/** Largest vertical speed the itinerary asks for, m/s, using each leg's own speed. */
export function itineraryMaxVertical(wps: ItinWp[]): number {
  let v = 0;
  for (let i = 0; i + 1 < wps.length; i++) {
    const h = dist(wps[i].xy, wps[i + 1].xy);
    const dz = Math.abs(wps[i + 1].alt - wps[i].alt);
    if (h < 1e-6) {
      if (dz > 1e-6) return Infinity;
      continue;
    }
    v = Math.max(v, (dz * wps[i].speed) / h);
  }
  return v;
}

export function legExtremes(wps: ItinWp[]): { shortest: number; longest: number } {
  let shortest = Infinity;
  let longest = 0;
  for (let i = 0; i + 1 < wps.length; i++) {
    const d = leg3d(wps[i], wps[i + 1]);
    shortest = Math.min(shortest, d);
    longest = Math.max(longest, d);
  }
  return { shortest: wps.length > 1 ? shortest : 0, longest };
}
