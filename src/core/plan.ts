import { AIR_2S, Camera, footprint, gsd, lineSpacing, overlapForSpacing, photoSpacing } from './camera';
import { generateLines, longestEdgeAngle } from './grid';
import { DEFAULT_FLIGHT, FlightSettings, Mission, budgetS, splitMissions } from './missions';
import { LngLat, Projection, centroid, dist, makeProjection } from './projection';

export interface PlanInput {
  polygon: LngLat[];
  home: LngLat;
  camera?: Camera;
  altitudeM: number;
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
  hasElevationData: boolean;
}

export const DEFAULT_INPUT: Omit<PlanInput, 'polygon' | 'home'> = {
  altitudeM: 80,
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
  hasElevationData: false,
};

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
}

export function buildPlan(input: PlanInput): Plan {
  const camera = input.camera ?? AIR_2S;
  const proj = makeProjection(centroid(input.polygon));
  const ring = input.polygon.map((p) => proj.toLocal(p));
  const home = proj.toLocal(input.home);
  const angleDeg = input.gridAngleDeg === 'auto' ? longestEdgeAngle(ring) : input.gridAngleDeg;

  const ls = lineSpacing(camera, input.altitudeM, input.sideOverlap);
  const ps = photoSpacing(camera, input.altitudeM, input.frontOverlap);
  const interval = ps / input.speedMs;
  // In time mode a 20% faster ground speed stretches photo spacing by 20%.
  const worst =
    input.trigger === 'time' ? overlapForSpacing(camera, input.altitudeM, ps * 1.2) : input.frontOverlap;

  const lines = generateLines(ring, ls, angleDeg, input.bufferM);
  const flight: FlightSettings = {
    ...DEFAULT_FLIGHT,
    altitudeM: input.altitudeM,
    speedMs: input.speedMs,
    batteryMin: input.batteryMin,
    reservePct: input.reservePct,
  };
  const missions = splitMissions(lines, home, flight);
  const photoCount = missions.reduce((n, m) => n + Math.ceil(m.lineDistanceM / ps) + m.lines.length, 0);
  const totalTimeS = missions.reduce((t, m) => t + m.timeS, 0);

  const checks = runChecks({
    input,
    camera,
    missions,
    interval,
    worst,
    budget: budgetS(flight),
    homeToPolygonM: minDistToRing(home, ring),
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
    id: 'altitude',
    label: 'Altitude above takeoff',
    status: grade(input.altitudeM, input.maxAltitudeM * 0.9, input.maxAltitudeM),
    detail: `${input.altitudeM} m planned, limit ${input.maxAltitudeM} m.`,
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
    status: input.hasElevationData ? 'pass' : 'caution',
    detail: input.hasElevationData
      ? 'Elevation data loaded.'
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
