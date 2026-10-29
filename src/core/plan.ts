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
import { PlanError, checkTakeoffDistance } from './limits';
import { staleMeasurements } from './measurements';
import { Air2sReturns } from './rth';
export { PlanError } from './limits';

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
  /** Geometry for which this relative height was measured and confirmed. */
  obstacleMeasuredFor: string;
  /**
   * How far the tallest rock formation rises above the ground around it, metres. Added to the
   * elevation data everywhere (the data cannot say where narrow formations are). 0 = not set.
   */
  formationM: number;
  /** Surveyed area for which formation height was measured and confirmed. */
  formationMeasuredFor: string;
  /** Survey of all flight/return corridors and a clear landing area at least 5 m around home. */
  siteSurveyedFor: string;
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
  obstacleMeasuredFor: '',
  formationM: 0,
  formationMeasuredFor: '',
  siteSurveyedFor: '',
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

export const MAX_AREA_HA = 2000;
export const MAX_LINES = 2000;

/** Litchi limits the plan must respect (flylitchi.com/help#waypoint, legacy Hub importer). */
export const LITCHI_MAX_ALT_M = 500;
export const LITCHI_MIN_ALT_M = -200;
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
  /** Lower takeoff reference used to design clearance, not to reconstruct actual flight height. */
  clearanceHomeElevM: number;
  minGroundM: number;
  maxGroundM: number;
  /** Recommended DJI RTH altitude above takeoff. */
  rthAltM: number;
  /** Steepest elevation-data slope near the plan (rise per metre). */
  maxSlope: number;
  /** Where it is. */
  maxSlopeAt: LngLat;
  /** Clearance shortfall on near-home returns or the signal-loss retrace. */
  returnShortfallM: number;
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
  /** Air 2S Straight Line RTH setting, also available for confirmed flat-ground plans. */
  rthAltM: number;
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
  const homeToPolygonM = checkTakeoffDistance(home, ring, input.maxRangeM);

  // Surfaces in absolute metres. Without terrain, ground is flat at 0 and takeoff is at 0.
  const ground = (xy: XY): number => {
    if (!terrain) return 0;
    const h = terrain.elevation(proj.toLngLat(xy));
    if (h === null) throw new MissingElevation();
    if (!Number.isFinite(h)) throw new PlanError('Elevation data contains an invalid height. Reload the terrain before exporting.');
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
  const clearanceHomeElev = safe ? safe.lowest(home) : 0;
  // CSV altitudes are measured from the actual launch location. Use its DEM elevation for
  // maximum AGL and KML; the lower clearance datum must not hide the extra commanded height.
  const homeElev = ground(home);
  // Field-measured highest obstacle (absolute), when given. It sets a minimum for the whole flight
  // and RTH (obstacle + minimum clearance); mapping height still follows the terrain where higher.
  const floorAbs = input.obstacleFloorM > 0 ? clearanceHomeElev + input.obstacleFloorM : -Infinity;
  const treetops = (xy: XY) => obstacle(xy) + input.formationM + input.canopyM;
  const surface = (xy: XY) => Math.max(treetops(xy), floorAbs);
  const target = (xy: XY) => Math.max(treetops(xy) + input.altitudeM, floorAbs + input.minClearanceM) - clearanceHomeElev;

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
  const need = (xy: XY) => surface(xy) + input.minClearanceM - clearanceHomeElev;

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
  const returns = new Air2sReturns(home, need, ground);
  const toPts = (w: ItinWp[]): PathPt[] => w.map((p) => ({ xy: p.xy, alt: p.alt }));
  for (const m of missions) {
    const it = itineraryFor(m.lines);
    m.lines = it.lines;
    m.climbAltM = it.climbAltM;
    m.itinerary = it.wps;
    m.waypointCount = it.wps.length;
    const st = pathStats(toPts(it.wps), surface, ground, clearanceHomeElev, TERRAIN_STEP_M);
    minClear = Math.min(minClear, st.minClearance);
    const firstLine = it.wps.findIndex((w) => w.kind === 'line');
    minLineClear = Math.min(minLineClear, pathStats(toPts(it.wps.slice(firstLine)), surface, ground, clearanceHomeElev, TERRAIN_STEP_M).minClearance);
    maxAgl = Math.max(maxAgl, st.maxAboveGround + homeElev - clearanceHomeElev);
    maxVert = Math.max(maxVert, itineraryMaxVertical(it.wps));
    const ext = legExtremes(it.wps);
    shortestLeg = Math.min(shortestLeg, ext.shortest || Infinity);
    longestLeg = Math.max(longestLeg, ext.longest);
    for (const w of it.wps) {
      maxAlt = Math.max(maxAlt, w.alt);
      minAlt = Math.min(minAlt, w.alt);
    }
    returns.add(it.wps);
    rthNeed = returns.settingM;
  }
  if (rthNeed > -Infinity) {
    // Re-time each mission with the RTH climb included.
    const rthAltM = Math.ceil(rthNeed / 5) * 5;
    // RTH stays at the current altitude when it is already above the setting. The minimum ground
    // on each sampled return also covers the vertical climb at its origin and arrival over home.
    maxAgl = Math.max(maxAgl, returns.maxAgl(homeElev, rthAltM));
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
      clearanceHomeElevM: clearanceHomeElev,
      minGroundM: lo,
      maxGroundM: hi,
      rthAltM: Math.ceil(rthNeed / 5) * 5,
      maxSlope: safe!.maxSlope,
      maxSlopeAt: proj.toLngLat(safe!.maxSlopeAt),
      returnShortfallM: returns.shortfallM,
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
    homeToPolygonM,
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
    returnShortfall: returns.shortfallM,
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
    rthAltM: Math.ceil(rthNeed / 5) * 5,
  };
}

/** Status for a value where larger is worse. */
export function grade(value: number, cautionAt: number, failAt: number): CheckStatus {
  if (!Number.isFinite(value)) return 'fail';
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
  returnShortfall?: number;
}): Check[] {
  const { input, camera, missions, interval, worst, budget } = a;
  const out: Check[] = [];
  const finite = [interval, worst, budget, a.homeToPolygonM, a.minClear, a.minLineClear, a.maxAgl, a.maxVert, a.shortestLeg, a.longestLeg, a.maxAlt, a.minAlt, a.photoSpacing, a.returnShortfall ?? 0,
    ...(a.terrain ? [a.terrain.homeElevM, a.terrain.rthAltM, a.terrain.minGroundM, a.terrain.maxGroundM] : []),
    ...missions.flatMap((m) => [m.timeS, ...m.itinerary?.flatMap((w) => [...w.xy, w.alt, w.speed, w.heading]) ?? []])].every(Number.isFinite);
  out.push({ id: 'numbers', label: 'Valid flight numbers', status: finite ? 'pass' : 'fail', detail: finite ? 'Flight coordinates, heights and timing are finite.' : 'The plan contains an invalid flight number. Regenerate it before export.' });

  const stale = staleMeasurements(input, input.polygon, input.home);
  out.push({
    id: 'survey', label: 'Site and landing survey',
    status: input.siteSurveyedFor === JSON.stringify([input.polygon, input.home]) ? 'pass' : 'fail',
    detail: 'Survey the full flight area, climb-out and return corridors for narrow rocks, trees and wires; enter measured height allowances in Settings. Confirm a clear landing area at least 5 m around takeoff. Elevation data and gentle slopes cannot prove a site is clear.',
  });
  out.push({
    id: 'return-clearance', label: 'Air 2S near-home and signal-loss return',
    status: (a.returnShortfall ?? 0) > 0.05 ? 'fail' : 'pass',
    detail: (a.returnShortfall ?? 0) > 0.05
      ? `The near-home return or 50 m signal-loss retrace lacks ${fmt(a.returnShortfall!)} m of clearance. Raising the RTH setting cannot fix it. Move takeoff or increase the planned clearance and regenerate.`
      : 'Sampled Air 2S Straight Line RTH: current altitude at 5–50 m from home, climb when farther away, and up to 50 m of signal-loss retracing. Within 5 m the aircraft may land immediately; the landing area must be surveyed clear. Decline Power Saving RTH; other aircraft and return modes are not covered.',
  });
  if (input.obstacleFloorM > 0 || input.formationM > 0) {
    out.push({
      id: 'measurements',
      label: 'Field measurements',
      status: stale.length ? 'fail' : 'pass',
      detail: stale.length
        ? `${stale.join(' and ')} must be measured and confirmed for this area and takeoff. Go to Settings to confirm new measurements; old heights cannot authorize export after moving the site.`
        : 'The field measurements were confirmed for the current area and takeoff.',
    });
  }

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
      ? `Highest point ${fmt(a.maxAgl)} m above the ground below it, including straight returns from anywhere on the flight (limit ${input.maxAltitudeM} m). This includes the extra height allowed for uncertainty around takeoff and terrain dips.`
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
      status: a.terrain.rthAltM > input.maxAltitudeM ? 'fail' : 'pass',
      detail: `Set Air 2S Straight Line RTH altitude in DJI Fly to ${a.terrain.rthAltM} m. This covers returns starting farther than 50 m from home, including sampled signal-loss retraces. Near-home clearance is checked separately because the aircraft does not climb to this setting at 5–50 m. Return terrain is sampled every 5 m.${a.terrain.rthAltM > input.maxAltitudeM ? ` This exceeds your ${input.maxAltitudeM} m height limit over takeoff.` : ''}`,
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
      a.minAlt < LITCHI_MIN_ALT_M ||
      a.maxAlt > LITCHI_MAX_ALT_M ||
      a.photoSpacing > LITCHI_MAX_INTERVAL ||
      (input.trigger === 'time' && interval > LITCHI_MAX_INTERVAL)
        ? 'fail'
        : a.minAlt < 0
          ? 'caution'
          : 'pass',
    detail:
      `Legs ${a.shortestLeg.toFixed(1)} to ${a.longestLeg.toFixed(0)} m (Litchi accepts ${LITCHI_MIN_LEG_M} to ${LITCHI_MAX_LEG_M} m). ` +
      `Altitudes ${a.minAlt.toFixed(0)} to ${a.maxAlt.toFixed(0)} m above takeoff (Hub import limits ${LITCHI_MIN_ALT_M} to ${LITCHI_MAX_ALT_M} m). ` +
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
