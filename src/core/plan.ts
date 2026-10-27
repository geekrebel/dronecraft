import { AIR_2S, Camera, footprint, gsd, lineSpacing, overlapForSpacing, photoSpacing } from './camera';
import { Line, generateLines, longestEdgeAngle } from './grid';
import { DEFAULT_FLIGHT, FlightSettings, Mission, budgetS, splitMissions } from './missions';
import { LngLat, Projection, XY, centroid, dist, makeProjection } from './projection';
import { PathPt, at, maxAlong, pathStats, profileLine } from './profile';
import {
  ItinWp,
  LITCHI_MAX_LEG_M,
  LITCHI_MIN_LEG_M,
  buildItinerary,
  itineraryMaxVertical,
  itineraryTime,
  legExtremes,
} from './itinerary';
import type { Terrain } from './terrain';
import { SAFETY_RADIUS_M, STEEP_SLOPE, SafeTerrain } from './safety';

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
  /** The user confirms the site is flat, so planning without elevation data is acceptable. */
  flatGroundConfirmed: boolean;
  /** Which area the flat-ground confirmation was given for (set by the app). */
  flatConfirmedFor: string;
  /**
   * Highest rock or tree top in or near the area, metres above takeoff, measured in the field.
   * 0 = not set. When set, no part of the flight or RTH goes below this plus the minimum clearance.
   */
  obstacleFloorM: number;
  /**
   * How far the tallest rock formation rises above the ground around it, metres. Added to the
   * elevation data everywhere (the data cannot say where narrow formations are). 0 = not set.
   */
  formationM: number;
  /** Max altitude set in DJI Fly; the aircraft will not climb above it. */
  droneMaxAltM: number;
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
  flatGroundConfirmed: false,
  flatConfirmedFor: '',
  obstacleFloorM: 0,
  formationM: 0,
  droneMaxAltM: 120,
};

/** Vertical speed terrain following is designed for, m/s. Below the 3 m/s caution level. */
export const TERRAIN_VERTICAL_MS = 2.5;

/** Accepted range for each numeric setting. Imports outside these are rejected; the planner refuses them too. */
export const SETTING_RANGES: Record<string, [number, number]> = {
  altitudeM: [10, 500],
  canopyM: [0, 100],
  minClearanceM: [5, 100],
  frontOverlap: [0.5, 0.95],
  sideOverlap: [0.5, 0.95],
  speedMs: [1, 15],
  gridAngleDeg: [-360, 360],
  bufferM: [0, 100],
  gimbalPitch: [-90, 0],
  batteryMin: [5, 45],
  reservePct: [0.1, 0.6],
  maxRangeM: [100, 5000],
  maxAltitudeM: [30, 500],
  obstacleFloorM: [0, 500],
  formationM: [0, 300],
  droneMaxAltM: [20, 500],
};

/** Planning refuses inputs it cannot handle safely; the message is meant for the user. */
export class PlanError extends Error {}

export const MAX_AREA_HA = 2000;
export const MAX_LINES = 2000;

/** Litchi limits the plan must respect (flylitchi.com/help#waypoint, legacy Hub importer). */
export const LITCHI_MAX_ALT_M = 500;
export const LITCHI_MAX_INTERVAL = 100;
/** Vertical speed the climb-out leg is designed for, m/s. */
export const CLIMB_OUT_VERTICAL_MS = 2.5;
export const RETURN_SPEED_MS = 10;

const okLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) && p.length >= 2 && [p[0], p[1]].every((v) => typeof v === 'number' && Number.isFinite(v)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

export function validateInput(input: PlanInput) {
  if (!Array.isArray(input.polygon) || input.polygon.length < 3 || !input.polygon.every(okLngLat))
    throw new PlanError('The area needs at least 3 corners with valid coordinates.');
  if (!okLngLat(input.home)) throw new PlanError('The takeoff point has invalid coordinates.');
  for (const [k, [lo, hi]] of Object.entries(SETTING_RANGES)) {
    const v = (input as unknown as Record<string, unknown>)[k];
    if (k === 'gridAngleDeg' && v === 'auto') continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
      throw new PlanError(`Setting ${k} is ${String(v)}, outside the allowed ${lo} to ${hi}.`);
  }
  if (input.trigger !== 'distance' && input.trigger !== 'time') throw new PlanError('Photo trigger must be distance or time.');
}

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
  /** Steepest elevation-data slope near the plan (rise per metre). */
  maxSlope: number;
  /** Where it is. */
  maxSlopeAt: LngLat;
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
  validateInput(input);
  if (terrain) {
    try {
      return build(input, terrain);
    } catch (e) {
      if (!(e instanceof MissingElevation)) throw e;
      return build(input, null, 'incomplete');
    }
  }
  return build(input, null);
}

function build(input: PlanInput, terrain: Terrain | null, missing: 'none' | 'incomplete' = 'none'): Plan {
  const camera = input.camera ?? AIR_2S;
  const proj = makeProjection(centroid(input.polygon));
  const ring = input.polygon.map((p) => proj.toLocal(p));
  const home = proj.toLocal(input.home);
  const angleDeg = input.gridAngleDeg === 'auto' ? longestEdgeAngle(ring) : input.gridAngleDeg;
  const areaHa = ringArea(ring) / 10000;
  if (areaHa < 0.01) throw new PlanError('The area is too small or its corners are in a line.');
  if (areaHa > MAX_AREA_HA) throw new PlanError(`The area is ${areaHa.toFixed(0)} ha. DroneCraft plans up to ${MAX_AREA_HA} ha at a time; split it into smaller areas.`);

  // Surfaces in absolute metres. Without terrain, ground is flat at 0 and takeoff is at 0.
  const ground = (xy: XY): number => {
    if (!terrain) return 0;
    const h = terrain.elevation(proj.toLngLat(xy));
    if (h === null) throw new MissingElevation();
    return h;
  };
  // Conservative model (see safety.ts): highest ground within 30 m for obstacles, lowest within
  // 30 m for takeoff, so elevation-data errors push the drone up, not down.
  let safe: SafeTerrain | null = null;
  if (terrain) {
    const xs = [...ring.map((p) => p[0]), home[0]];
    const ys = [...ring.map((p) => p[1]), home[1]];
    const m = input.bufferM + SAFETY_RADIUS_M + 40;
    safe = new SafeTerrain(ground, { x0: Math.min(...xs) - m, y0: Math.min(...ys) - m, x1: Math.max(...xs) + m, y1: Math.max(...ys) + m });
  }
  const obstacle = (xy: XY) => (safe ? safe.obstacle(xy) : 0);
  const homeElev = safe ? safe.lowest(home) : 0;
  // Field-measured highest obstacle (absolute), when given. It sets a minimum for the whole flight
  // and RTH (obstacle + minimum clearance); mapping height still follows the terrain where higher.
  const floorAbs = input.obstacleFloorM > 0 ? homeElev + input.obstacleFloorM : -Infinity;
  const treetops = (xy: XY) => obstacle(xy) + input.formationM + input.canopyM;
  const surface = (xy: XY) => Math.max(treetops(xy), floorAbs);
  const target = (xy: XY) => Math.max(treetops(xy) + input.altitudeM, floorAbs + input.minClearanceM) - homeElev;

  const ls = lineSpacing(camera, input.altitudeM, input.sideOverlap);
  const ps = photoSpacing(camera, input.altitudeM, input.frontOverlap);
  const interval = ps / input.speedMs;
  // In time mode a 20% faster ground speed stretches photo spacing by 20%.
  const worst =
    input.trigger === 'time' ? overlapForSpacing(camera, input.altitudeM, ps * 1.2) : input.frontOverlap;

  const profile = (l: Line) => profileLine(l, target, TERRAIN_TOL_M, TERRAIN_STEP_M, TERRAIN_VERTICAL_MS / input.speedMs);
  const rawLines = generateLines(ring, ls, angleDeg, input.bufferM);
  if (rawLines.length > MAX_LINES) throw new PlanError(`This needs ${rawLines.length} flight lines. Reduce the area or raise the altitude.`);
  const lines = rawLines.map((l) => ({ ...l, wps: profile(l) }));
  const flight: FlightSettings = {
    ...DEFAULT_FLIGHT,
    speedMs: input.speedMs,
    batteryMin: input.batteryMin,
    reservePct: input.reservePct,
  };
  const need = (xy: XY) => surface(xy) + input.minClearanceM - homeElev;

  /** Climb straight up over takeoff high enough that the leg out clears the trees and needs at most 3 m/s vertical. */
  const climbAltFor = (oriented: Line[]) => {
    const l0 = oriented[0];
    const firstXY = at(l0, l0.wps![0].t);
    const firstAlt = l0.wps![0].alt;
    const h = dist(home, firstXY);
    const clear = maxAlong(home, firstXY, need, TERRAIN_STEP_M);
    return Math.max(clear, firstAlt - (CLIMB_OUT_VERTICAL_MS / flight.transitSpeedMs) * h);
  };
  const itineraryFor = (oriented: Line[]) => {
    const withWps = oriented.map((l) => (l.wps ? l : { ...l, wps: profile(l) }));
    const climbAltM = climbAltFor(withWps);
    return {
      lines: withWps,
      climbAltM,
      wps: buildItinerary(withWps, home, { speedMs: input.speedMs, transitSpeedMs: flight.transitSpeedMs, climbAltM }),
    };
  };
  const timing = { climbMs: flight.climbMs, descentMs: flight.descentMs, perWaypointS: flight.turnOverheadS, returnSpeedMs: RETURN_SPEED_MS };
  const missions = splitMissions(lines, home, flight, {
    measure: (oriented) => {
      const it = itineraryFor(oriented);
      return { waypoints: it.wps.length, timeS: itineraryTime(it.wps, home, timing) };
    },
  });

  let minClear = Infinity;
  let minLineClear = Infinity;
  let maxAgl = -Infinity;
  let maxVert = 0;
  let rthNeed = -Infinity;
  let shortestLeg = Infinity;
  let longestLeg = 0;
  let maxAlt = -Infinity;
  let minAlt = Infinity;
  const toPts = (w: ItinWp[]): PathPt[] => w.map((p) => ({ xy: p.xy, alt: p.alt }));
  for (const m of missions) {
    const it = itineraryFor(m.lines);
    m.lines = it.lines;
    m.climbAltM = it.climbAltM;
    m.itinerary = it.wps;
    m.waypointCount = it.wps.length;
    const st = pathStats(toPts(it.wps), surface, ground, homeElev, TERRAIN_STEP_M);
    minClear = Math.min(minClear, st.minClearance);
    const firstLine = it.wps.findIndex((w) => w.kind === 'line');
    minLineClear = Math.min(minLineClear, pathStats(toPts(it.wps.slice(firstLine)), surface, ground, homeElev, TERRAIN_STEP_M).minClearance);
    maxAgl = Math.max(maxAgl, st.maxAboveGround);
    maxVert = Math.max(maxVert, itineraryMaxVertical(it.wps));
    const ext = legExtremes(it.wps);
    shortestLeg = Math.min(shortestLeg, ext.shortest || Infinity);
    longestLeg = Math.max(longestLeg, ext.longest);
    for (const w of it.wps) {
      maxAlt = Math.max(maxAlt, w.alt);
      minAlt = Math.min(minAlt, w.alt);
    }
    if (terrain) {
      // RTH can start anywhere on the path, not just at waypoints. DJI RTH climbs to the RTH altitude
      // only if the drone is below it, then flies straight home; if it is already higher it returns at
      // its current altitude. So the RTH altitude only has to cover points where the drone's own
      // altitude would not clear the straight line home. Sample every 20 m along every leg.
      for (let i = 0; i + 1 < it.wps.length; i++) {
        const a = it.wps[i];
        const b = it.wps[i + 1];
        const n = Math.max(1, Math.ceil(dist(a.xy, b.xy) / 20));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const p: XY = [a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t];
          const alt = a.alt + (b.alt - a.alt) * t;
          const required = maxAlong(p, home, need, 20);
          if (alt < required) rthNeed = Math.max(rthNeed, required);
        }
      }
      // Never below what is needed directly over takeoff, nor below DJI's 20 m minimum.
      rthNeed = Math.max(rthNeed, need(home), 20);
    }
  }
  if (!terrain && input.obstacleFloorM > 0) rthNeed = input.obstacleFloorM + input.minClearanceM;
  if (terrain && rthNeed > -Infinity) {
    // Re-time each mission with the RTH climb included.
    const rthAltM = Math.ceil(rthNeed / 5) * 5;
    for (const m of missions) m.timeS = itineraryTime(m.itinerary!, home, { ...timing, rthAltM });
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
      maxSlope: safe!.maxSlope,
      maxSlopeAt: proj.toLngLat(safe!.maxSlopeAt),
    };
  }

  const photoCount = missions.reduce((n, m) => n + Math.ceil(m.lineDistanceM / ps) + m.lines.length, 0);
  const totalTimeS = missions.reduce((t, m) => t + m.timeS, 0);
  if (!missions.length) {
    minClear = minLineClear = input.altitudeM;
    maxAgl = input.altitudeM + input.canopyM;
    maxAlt = minAlt = 0;
    shortestLeg = LITCHI_MIN_LEG_M;
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
    terrainStatus: terrain ? 'loaded' : missing,
    shortestLeg,
    longestLeg,
    maxAlt,
    minAlt,
    photoSpacing: ps,
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
    terrainStatus: terrain ? 'loaded' : missing,
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
  terrainStatus: 'loaded' | 'none' | 'incomplete';
  shortestLeg: number;
  longestLeg: number;
  maxAlt: number;
  minAlt: number;
  photoSpacing: number;
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

  out.push({
    id: 'climb',
    label: 'Climb and descent rate',
    status: a.maxVert > 4 ? 'fail' : a.maxVert > 3 ? 'caution' : 'pass',
    detail: `Steepest leg, including the climb-out from takeoff, needs ${Number.isFinite(a.maxVert) ? a.maxVert.toFixed(1) : 'an unlimited'} m/s vertical at its planned speed. Above 3 m/s the drone may not hold the profile; fly slower or lay lines along the contours.`,
  });
  if (a.terrain) {
    out.push({
      id: 'rth',
      label: 'Return-to-home altitude',
      status: a.terrain.rthAltM > input.maxAltitudeM ? 'caution' : 'pass',
      detail: `Set RTH altitude in DJI Fly to ${a.terrain.rthAltM} m. With it, a return home from any point on the path clears the treetops by ${input.minClearanceM} m: where the drone is already higher it returns at its own altitude, elsewhere it climbs to this first. Checked every 20 m.${a.terrain.rthAltM > input.maxAltitudeM ? ` Arriving back over takeoff at that altitude puts the drone above your ${input.maxAltitudeM} m height limit there. Launching from higher ground lowers it.` : ''}`,
    });
  }

  if (a.terrain && a.terrain.maxSlope > STEEP_SLOPE) {
    const pct = Math.round(a.terrain.maxSlope * 100);
    out.push({
      id: 'steep',
      label: 'Steep rock formations',
      status: input.obstacleFloorM > 0 || input.formationM > 0 ? 'caution' : 'fail',
      detail:
        `The elevation data has slopes up to ${pct}% here, which usually means cliffs or rock towers. ` +
        'SRTM elevation is averaged over 30 m, so towers and spires narrower than about 60 m appear much lower than they are and terrain following cannot see them. ' +
        (input.obstacleFloorM > 0 || input.formationM > 0
          ? [
              input.formationM > 0 ? `Rock formations allowed for: ${input.formationM} m above the surrounding ground, added everywhere.` : '',
              input.obstacleFloorM > 0 ? `Highest obstacle: ${input.obstacleFloorM} m above takeoff, so nothing in the flight or RTH goes below ${input.obstacleFloorM + input.minClearanceM} m above takeoff.` : '',
              'This is only as safe as those measurements.',
            ].filter(Boolean).join(' ')
          : 'Export is blocked until you set "Rock formation height" or "Highest obstacle above takeoff" in Settings, measured on site.'),
    });
  }

  {
    const top = Math.max(a.maxAlt, a.terrain?.rthAltM ?? -Infinity, input.obstacleFloorM > 0 ? input.obstacleFloorM + input.minClearanceM : -Infinity);
    out.push({
      id: 'djilimit',
      label: 'DJI altitude limit',
      status: top > input.droneMaxAltM ? 'fail' : top > input.droneMaxAltM - 10 ? 'caution' : 'pass',
      detail:
        `Highest point the plan or RTH needs: ${top.toFixed(0)} m above takeoff. Your DJI Fly max altitude: ${input.droneMaxAltM} m. ` +
        (top > input.droneMaxAltM
          ? 'The drone will stop climbing at the DJI limit and fly level into anything taller. Raise the max altitude in DJI Fly (and Litchi) and update it in Settings, or launch from higher ground.'
          : 'The aircraft cannot climb above that limit, so keep it at least this high in DJI Fly and in Litchi.'),
    });
  }

  out.push({
    id: 'litchi',
    label: 'Litchi limits',
    status:
      a.longestLeg > LITCHI_MAX_LEG_M ||
      a.shortestLeg < LITCHI_MIN_LEG_M ||
      a.maxAlt > LITCHI_MAX_ALT_M ||
      a.photoSpacing > LITCHI_MAX_INTERVAL ||
      (input.trigger === 'time' && interval > LITCHI_MAX_INTERVAL)
        ? 'fail'
        : a.minAlt < 0
          ? 'caution'
          : 'pass',
    detail:
      `Legs ${a.shortestLeg.toFixed(1)} to ${a.longestLeg.toFixed(0)} m (Litchi accepts ${LITCHI_MIN_LEG_M} to ${LITCHI_MAX_LEG_M} m). ` +
      `Altitudes ${a.minAlt.toFixed(0)} to ${a.maxAlt.toFixed(0)} m above takeoff (Hub import limit ${LITCHI_MAX_ALT_M} m). ` +
      `Photo interval ${input.trigger === 'time' ? `${interval.toFixed(1)} s` : `${a.photoSpacing.toFixed(1)} m`} (limit ${LITCHI_MAX_INTERVAL}).` +
      (a.minAlt < 0 ? ' Some waypoints are below takeoff height; confirm Litchi Hub accepts them after import.' : ''),
  });

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
    status: a.terrain ? 'pass' : input.flatGroundConfirmed ? 'caution' : 'fail',
    detail: a.terrain
      ? `${a.terrain.source}. Ground under the lines ${fmt(a.terrain.minGroundM)} to ${fmt(a.terrain.maxGroundM)} m, takeoff ${fmt(a.terrain.homeElevM)} m. Altitudes follow the terrain.`
      : (a.terrainStatus === 'incomplete' ? 'Elevation data does not cover the whole plan. ' : 'No elevation data. ') +
        (input.flatGroundConfirmed
          ? 'You confirmed the site is flat, so altitudes are constant above takeoff.'
          : 'Export is blocked until elevation loads, or you confirm the site is flat. On a slope the drone would be closer to the trees uphill.'),
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

function ringArea(ring: XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
