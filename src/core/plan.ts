import { AIR_2S, Camera, footprint, gsd, lineSpacing, overlapForSpacing, photoSpacing } from './camera';
import { Line, generateLines, longestEdgeAngle } from './grid';
import { DEFAULT_FLIGHT, FlightSettings, Mission, budgetS, splitMissions } from './missions';
import { LngLat, Projection, XY, centroid, dist, makeProjection } from './projection';
import { PathPt, at, maxAlong, maxVerticalSpeed, pathStats, profileLine } from './profile';
import type { Terrain } from './terrain';

export interface PlanInput {
  polygon: LngLat[];
  home: LngLat;
  camera?: Camera;
  /** Height above the treetops (ground elevation + canopyM). On flat ground with canopyM 0 this is height above takeoff. */
  altitudeM: number;
  /** Tree height allowance added to ground elevation. */
  canopyM: number;
  /** Minimum allowed clearance above the treetops anywhere on the path. */
  minClearanceM: number;
  frontOverlap: number; // 0..1
  sideOverlap: number; // 0..1
  speedMs: number;
  gridAngleDeg: number | 'auto';
  bufferM: number;
  gimbalPitch: number;
  trigger: 'distance' | 'time';
  batteryMin: number;
  reservePct: number;
  maxRangeM: number;
  maxAltitudeM: number;
  geoZoneChecked: boolean;
}

export const DEFAULT_INPUT: Omit<PlanInput, 'polygon' | 'home'> = {
  altitudeM: 80,
  canopyM: 0,
  minClearanceM: 30,
  frontOverlap: 0.8,
  sideOverlap: 0.8,
  speedMs: 5,
  gridAngleDeg: 'auto',
  bufferM: 15,
  gimbalPitch: -90,
  trigger: 'distance',
  batteryMin: 27,
  reservePct: 0.3,
  maxRangeM: 1000,
  maxAltitudeM: 120,
  geoZoneChecked: false,
};

/** Terrain following tolerance and sampling. */
export const TERRAIN_TOL_M = 5;
export const TERRAIN_STEP_M = 10;

export interface TerrainSummary {
  source: string;
  homeElevM: number;
  minGroundM: number;
  maxGroundM: number;
  /** Recommended DJI RTH altitude above takeoff. */
  rthAltM: number;
}

export type CheckStatus = 'pass' | 'caution' | 'fail';
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface Plan {
  input: PlanInput;
  camera: Camera;
  proj: Projection;
  angleDeg: number;
  gsdCm: number;
  footprint: { across: number; along: number };
  lineSpacingM: number;
  photoSpacingM: number;
  photoIntervalS: number;
  worstCaseFrontOverlap: number;
  missions: Mission[];
  photoCount: number;
  totalTimeS: number;
  checks: Check[];
  exportBlocked: boolean;
  /** Present when elevation data covered the whole plan. */
  terrain: TerrainSummary | null;
  /** 'none' = no data given; 'incomplete' = data given but did not cover the plan. */
  terrainStatus: 'loaded' | 'none' | 'incomplete';
  /** Lowest clearance above trees anywhere, including the climb-out leg. */
  minClearanceM: number;
  /** Lowest clearance above trees on the mapping lines and turns. */
  minLineClearanceM: number;
  maxAboveGroundM: number;
  maxVerticalMs: number;
  homeXY: XY;
}

class MissingElevation extends Error {}

export function buildPlan(input: PlanInput, terrain?: Terrain | null): Plan {
  if (terrain) {
    try {
      return build(input, terrain);
    } catch (e) {
      if (!(e instanceof MissingElevation)) throw e;
      return { ...build(input, null), terrainStatus: 'incomplete' };
    }
  }
  return build(input, null);
}

function build(input: PlanInput, terrain: Terrain | null): Plan {
  const camera = input.camera ?? AIR_2S;
  const proj = makeProjection(centroid(input.polygon));
  const ring = input.polygon.map((p) => proj.toLocal(p));
  const home = proj.toLocal(input.home);
  const angleDeg = input.gridAngleDeg === 'auto' ? longestEdgeAngle(ring) : input.gridAngleDeg;

  // Surfaces in absolute metres. Without terrain, ground is flat at 0 and takeoff is at 0.
  const ground = (xy: XY): number => {
    if (!terrain) return 0;
    const h = terrain.elevation(proj.toLngLat(xy));
    if (h === null) throw new MissingElevation();
    return h;
  };
  const surface = (xy: XY) => ground(xy) + input.canopyM;
  const homeElev = ground(home);
  const target = (xy: XY) => surface(xy) + input.altitudeM - homeElev;

  const ls = lineSpacing(camera, input.altitudeM, input.sideOverlap);
  const ps = photoSpacing(camera, input.altitudeM, input.frontOverlap);
  const interval = ps / input.speedMs;
  // In time mode a 20% faster ground speed stretches photo spacing by 20%.
  const worst =
    input.trigger === 'time' ? overlapForSpacing(camera, input.altitudeM, ps * 1.2) : input.frontOverlap;

  const profile = (l: Line) => profileLine(l, target, TERRAIN_TOL_M, TERRAIN_STEP_M);
  const lines = generateLines(ring, ls, angleDeg, input.bufferM).map((l) => ({ ...l, wps: profile(l) }));
  const maxAlt = Math.max(input.altitudeM + input.canopyM, ...lines.flatMap((l) => l.wps!.map((w) => w.alt)));
  const flight: FlightSettings = {
    ...DEFAULT_FLIGHT,
    altitudeM: maxAlt,
    speedMs: input.speedMs,
    batteryMin: input.batteryMin,
    reservePct: input.reservePct,
  };
  const extraWp = terrain ? 1 : 0; // climb above takeoff before heading out
  const missions = splitMissions(lines, home, flight, {
    wpCount: (l) => (l.wps ?? profile(l)).length,
    extraWp,
  });

  // Lines cut to fit a battery lose their profile; re-plan them. Then add the climb waypoint and measure.
  let minClear = Infinity;
  let minLineClear = Infinity;
  let maxAgl = -Infinity;
  let maxVert = 0;
  let rthNeed = -Infinity;
  const need = (xy: XY) => surface(xy) + input.minClearanceM - homeElev;
  for (const m of missions) {
    m.lines = m.lines.map((l) => (l.wps ? l : { ...l, wps: profile(l) }));
    const linePts: PathPt[] = m.lines.flatMap((l) => l.wps!.map((w) => ({ xy: at(l, w.t), alt: w.alt })));
    if (terrain) {
      // Climb straight up at takeoff only as high as needed to clear the trees all the way to the first
      // waypoint; the drone then rises or descends along that leg. Both ends of the leg are at or above
      // the highest requirement on it, so the straight leg between them is too.
      const first = linePts[0];
      m.climbAltM = maxAlong(home, first.xy, need, TERRAIN_STEP_M);
    }
    const path: PathPt[] = m.climbAltM !== undefined ? [{ xy: home, alt: m.climbAltM }, ...linePts] : linePts;
    const st = pathStats(path, surface, ground, homeElev, TERRAIN_STEP_M);
    minClear = Math.min(minClear, st.minClearance);
    minLineClear = Math.min(minLineClear, pathStats(linePts, surface, ground, homeElev, TERRAIN_STEP_M).minClearance);
    maxAgl = Math.max(maxAgl, st.maxAboveGround);
    maxVert = Math.max(maxVert, maxVerticalSpeed(linePts, input.speedMs));
    if (terrain) {
      // RTH can start anywhere: it must clear the ground on a straight line home from every waypoint.
      for (const p of linePts) rthNeed = Math.max(rthNeed, p.alt, maxAlong(p.xy, home, need, 20));
    }
    m.waypointCount = linePts.length + (m.climbAltM !== undefined ? 1 : 0);
  }

  let terrainSummary: TerrainSummary | null = null;
  if (terrain) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of missions)
      for (const l of m.lines)
        for (let k = 0; k <= 20; k++) {
          const g = ground(at(l, k / 20));
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
    terrainSummary = {
      source: terrain.source,
      homeElevM: homeElev,
      minGroundM: lo,
      maxGroundM: hi,
      rthAltM: Math.ceil(rthNeed / 5) * 5,
    };
  }

  const photoCount = missions.reduce((n, m) => n + Math.ceil(m.lineDistanceM / ps) + m.lines.length, 0);
  const totalTimeS = missions.reduce((t, m) => t + m.timeS, 0);
  if (!missions.length) {
    minClear = minLineClear = input.altitudeM;
    maxAgl = input.altitudeM + input.canopyM;
  }

  const checks = runChecks({
    input,
    camera,
    missions,
    interval,
    worst,
    budget: budgetS(flight),
    homeToPolygonM: minDistToRing(home, ring),
    minClear,
    minLineClear,
    maxAgl: Math.round(maxAgl * 10) / 10,
    maxVert,
    terrain: terrainSummary,
  });

  return {
    input,
    camera,
    proj,
    angleDeg,
    gsdCm: gsd(camera, input.altitudeM) * 100,
    footprint: footprint(camera, input.altitudeM),
    lineSpacingM: ls,
    photoSpacingM: ps,
    photoIntervalS: interval,
    worstCaseFrontOverlap: worst,
    missions,
    photoCount,
    totalTimeS,
    checks,
    exportBlocked: checks.some((c) => c.status === 'fail'),
    terrain: terrainSummary,
    terrainStatus: terrain ? 'loaded' : 'none',
    minClearanceM: minClear,
    minLineClearanceM: minLineClear,
    maxAboveGroundM: maxAgl,
    maxVerticalMs: maxVert,
    homeXY: home,
  };
}

function minDistToRing(p: [number, number], ring: [number, number][]): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, dist(p, [a[0] + t * dx, a[1] + t * dy]));
  }
  return best;
}

function pointInRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Status for a value where larger is worse. */
export function grade(value: number, cautionAt: number, failAt: number): CheckStatus {
  if (value > failAt) return 'fail';
  if (value > cautionAt) return 'caution';
  return 'pass';
}

const fmt = (n: number, d = 0) => n.toFixed(d);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function runChecks(a: {
  input: PlanInput;
  camera: Camera;
  missions: Mission[];
  interval: number;
  worst: number;
  budget: number;
  homeToPolygonM: number;
  minClear: number;
  minLineClear: number;
  maxAgl: number;
  maxVert: number;
  terrain: TerrainSummary | null;
}): Check[] {
  const { input, camera, missions, interval, worst, budget } = a;
  const out: Check[] = [];

  const maxWp = Math.max(0, ...missions.map((m) => m.waypointCount));
  out.push({
    id: 'waypoints',
    label: 'Waypoints per mission',
    status: maxWp > 99 ? 'fail' : 'pass',
    detail: `Largest mission has ${maxWp} waypoints (limit 99).`,
  });

  const minI = camera.minIntervalS;
  out.push({
    id: 'interval',
    label: 'Photo interval',
    status: interval < minI ? 'fail' : interval < minI * 1.25 ? 'caution' : 'pass',
    detail: `${fmt(interval, 2)} s between photos at ${input.speedMs} m/s. The Air 2S needs at least ${minI} s. Fly slower or lower the overlap if this is red.`,
  });

  const maxT = Math.max(0, ...missions.map((m) => m.timeS));
  out.push({
    id: 'battery',
    label: 'Battery per mission',
    status: grade(maxT, budget * 0.9, budget),
    detail: `Longest mission ${mmss(maxT)}, budget ${mmss(budget)} (${input.batteryMin} min less ${fmt(input.reservePct * 100)}% reserve).`,
  });

  const maxD = Math.max(0, ...missions.map((m) => m.maxDistFromHomeM));
  out.push({
    id: 'range',
    label: 'Distance from takeoff',
    status: grade(maxD, input.maxRangeM * 0.8, input.maxRangeM),
    detail: `Farthest point ${fmt(maxD)} m from takeoff (your limit ${input.maxRangeM} m). Virtual stick stops the mission if the link drops.`,
  });

  out.push({
    id: 'height',
    label: 'Height above ground',
    status: grade(a.maxAgl, input.maxAltitudeM * 0.9, input.maxAltitudeM),
    detail: a.terrain
      ? `Highest point ${fmt(a.maxAgl)} m above the ground below it (limit ${input.maxAltitudeM} m). That is ${input.altitudeM} m above the trees plus ${input.canopyM} m tree height, more where lines cross dips.`
      : `${fmt(a.maxAgl)} m above takeoff (limit ${input.maxAltitudeM} m), assuming flat ground.`,
  });

  out.push({
    id: 'clearance',
    label: 'Clearance above trees',
    status:
      a.minClear < input.minClearanceM - 0.05 ? 'fail' : a.minLineClear < input.minClearanceM * 1.5 ? 'caution' : 'pass',
    detail: a.terrain
      ? `Mapping lines stay at least ${fmt(a.minLineClear)} m above the estimated treetops (ground + ${input.canopyM} m). The climb-out from takeoff keeps at least ${fmt(a.minClear)} m. Your minimum is ${input.minClearanceM} m. Checked every ${TERRAIN_STEP_M} m along every leg.`
      : `${fmt(a.minClear)} m above the trees, assuming flat ground at takeoff height and ${input.canopyM} m trees.`,
  });

  if (a.terrain) {
    out.push({
      id: 'climb',
      label: 'Climb and descent rate',
      status: a.maxVert > 4 ? 'fail' : a.maxVert > 3 ? 'caution' : 'pass',
      detail: `Steepest leg needs ${a.maxVert.toFixed(1)} m/s vertical at ${input.speedMs} m/s. Above 3 m/s the drone may not hold the profile; fly slower or lay lines along the contours.`,
    });
    out.push({
      id: 'rth',
      label: 'Return-to-home altitude',
      status: 'pass',
      detail: `Set RTH altitude in DJI Fly to at least ${a.terrain.rthAltM} m. That clears the treetops by ${input.minClearanceM} m on a straight line home from any waypoint.`,
    });
  }

  if (input.trigger === 'time') {
    const pct = worst * 100;
    out.push({
      id: 'overlap',
      label: 'Worst-case forward overlap',
      status: pct < 60 ? 'fail' : worst < input.frontOverlap - 0.001 ? 'caution' : 'pass',
      detail: `${fmt(pct)}% if ground speed runs 20% fast (target ${fmt(input.frontOverlap * 100)}%). Distance triggering avoids this drift.`,
    });
  }

  out.push({
    id: 'takeoff',
    label: 'Takeoff point',
    status: grade(a.homeToPolygonM, input.maxRangeM * 0.25, input.maxRangeM * 0.5),
    detail:
      a.homeToPolygonM === 0
        ? 'Takeoff is inside the area.'
        : `Takeoff is ${fmt(a.homeToPolygonM)} m outside the area.`,
  });

  if (missions.some((m) => m.splitLine)) {
    out.push({
      id: 'splitline',
      label: 'Long flight lines',
      status: 'caution',
      detail: 'At least one line was cut to fit a battery. Consider rotating the grid or moving takeoff.',
    });
  }

  out.push({
    id: 'terrain',
    label: 'Terrain data',
    status: a.terrain ? 'pass' : 'caution',
    detail: a.terrain
      ? `${a.terrain.source}. Ground under the lines ${fmt(a.terrain.minGroundM)} to ${fmt(a.terrain.maxGroundM)} m, takeoff ${fmt(a.terrain.homeElevM)} m. Altitudes follow the terrain.`
      : 'No elevation data. Altitude is constant above takeoff, so on sloped ground the drone will be closer to the trees uphill. Only fly this on flat sites.',
  });

  out.push({
    id: 'geozone',
    label: 'DJI GEO zones',
    status: input.geoZoneChecked ? 'pass' : 'caution',
    detail: input.geoZoneChecked
      ? 'You confirmed the area is checked on DJI FlySafe.'
      : 'Check the area on the DJI FlySafe map before you travel. Restricted zones block takeoff and custom unlocks take days.',
  });

  if (!missions.length) {
    out.push({ id: 'empty', label: 'Coverage', status: 'fail', detail: 'No flight lines. Draw a larger area.' });
  }
  return out;
}
