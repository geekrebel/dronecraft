/**
 * Regression tests for the code review in GitHub issue #1. Each block reproduces one finding.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT, LITCHI_MAX_ALT_M, buildPlan } from './plan';
import { LngLat, XY, dist, makeProjection } from './projection';
import { FunctionTerrain } from './terrain';
import { buildItinerary, itineraryMaxVertical, itineraryTime, leg3d } from './itinerary';
import { missionWaypoints, parseLitchiCsv, toLitchiCsv } from './litchi';

const C: LngLat = [98.12, 3.55];
const proj = makeProjection(C);
const ll = (xy: XY) => proj.toLngLat(xy);
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] => ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as XY[]).map(ll);
const base = { ...DEFAULT_INPUT, canopyM: 0, minClearanceM: 30, altitudeM: 80 };
const status = (p: ReturnType<typeof buildPlan>, id: string) => p.checks.find((c) => c.id === id)?.status;

describe('#1 RTH altitude covers returns from between waypoints', () => {
  // A 120 m hill sits on the straight line home from the middle of the lines, but not on the
  // lines home from their ends.
  const hill = new FunctionTerrain((p) => {
    const [x, y] = proj.toLocal(p);
    return Math.hypot(x, y + 150) < 25 ? 120 : 0;
  });
  const p = buildPlan({ ...base, polygon: rect(-200, -15, 200, 15), home: ll([0, -300]), gridAngleDeg: 0 }, hill);

  it('the hill is not under any leg of the flight itself', () => {
    expect(p.minClearanceM).toBeGreaterThanOrEqual(30 - 1e-6);
  });
  it('recommended RTH altitude clears the hill by the minimum clearance', () => {
    expect(p.terrain!.rthAltM).toBeGreaterThanOrEqual(120 + 30);
  });
});

describe('#2 climb rate includes the climb-out leg', () => {
  it('a hand-built steep climb-out is measured', () => {
    const wps = buildItinerary(
      [{ start: [1, 0], end: [101, 0], wps: [{ t: 0, alt: 80 }, { t: 1, alt: 80 }] }],
      [0, 0],
      { speedMs: 5, transitSpeedMs: 5, climbAltM: 30 },
    );
    expect(itineraryMaxVertical(wps)).toBeCloseTo(250, 6);
  });
  it('planned climb-outs need at most 3 m/s even when the first line starts at takeoff', () => {
    const slope = new FunctionTerrain((q) => 0.3 * proj.toLocal(q)[1]);
    const p = buildPlan({ ...base, polygon: rect(-100, 0, 100, 200), home: ll([-100, 0]) }, slope);
    for (const m of p.missions) expect(itineraryMaxVertical(m.itinerary!.slice(0, 2))).toBeLessThanOrEqual(3 + 1e-9);
    expect(p.maxVerticalMs).toBeGreaterThanOrEqual(itineraryMaxVertical(p.missions[0].itinerary!.slice(0, 2)));
  });
});

describe('#3 battery estimate uses the exported speeds', () => {
  // Reviewer's case: 1430 x 20 m block, takeoff 500 m west, 5 m/s, 15 min battery, 30% reserve.
  const p = buildPlan({
    ...base,
    flatGroundConfirmed: true,
    polygon: rect(0, 0, 1430, 20),
    home: ll([-500, 10]),
    speedMs: 5,
    batteryMin: 15,
    reservePct: 0.3,
    gridAngleDeg: 0,
  });

  it('mission time is the time of the exported itinerary', () => {
    for (const m of p.missions) expect(m.timeS).toBeCloseTo(itineraryTime(m.itinerary!, p.homeXY, { climbMs: 3, descentMs: 2.5, perWaypointS: 4, returnSpeedMs: 10 }), 6);
  });

  it('time recomputed independently from the CSV speeds matches', () => {
    for (const m of p.missions) {
      const rows = parseLitchiCsv(toLitchiCsv(missionWaypoints(m, p.proj, { altitudeM: 80, speedMs: 5, gimbalPitch: -90, trigger: 'distance', photoSpacingM: p.photoSpacingM, photoIntervalS: p.photoIntervalS }, p.homeXY)));
      const pts = rows.map((r) => ({ xy: p.proj.toLocal([r.lon, r.lat]), alt: r.alt, speed: r.speed }));
      let legs = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const h = dist(pts[i].xy, pts[i + 1].xy);
        const dz = pts[i + 1].alt - pts[i].alt;
        legs += Math.max(h / pts[i].speed, Math.abs(dz) / (dz > 0 ? 3 : 2.5));
      }
      const expected =
        Math.max(0, pts[0].alt) / 3 + dist(p.homeXY, pts[0].xy) / 10 + legs + pts.length * 4 + dist(pts[pts.length - 1].xy, p.homeXY) / 10 + pts[pts.length - 1].alt / 2.5;
      // CSV rounds coordinates and altitudes, so allow a second.
      expect(Math.abs(m.timeS - expected)).toBeLessThan(1);
    }
  });

  it('every mission fits the battery budget, or the battery check fails', () => {
    const budget = 15 * 60 * 0.7;
    const over = p.missions.some((m) => m.timeS > budget);
    expect(status(p, 'battery')).toBe(over ? 'fail' : status(p, 'battery'));
    for (const m of p.missions) expect(m.timeS).toBeLessThanOrEqual(budget);
  });
});

describe('#5 Litchi spacing and altitude limits', () => {
  it('long lines are split into legs of at most 1999 m', () => {
    const p = buildPlan({ ...base, flatGroundConfirmed: true, polygon: rect(0, 0, 3000, 20), home: ll([1500, -10]), gridAngleDeg: 0, maxRangeM: 3000 });
    for (const m of p.missions) for (let i = 0; i + 1 < m.itinerary!.length; i++) expect(leg3d(m.itinerary![i], m.itinerary![i + 1])).toBeLessThanOrEqual(1999);
    expect(status(p, 'litchi')).toBe('pass');
  });
  it('relative altitudes over 500 m block export', () => {
    const tall = new FunctionTerrain((q) => 1.6 * proj.toLocal(q)[1]);
    const p = buildPlan({ ...base, polygon: rect(-100, 0, 100, 400), home: ll([0, -20]), gridAngleDeg: 90, speedMs: 2 }, tall);
    expect(Math.max(...p.missions.flatMap((m) => m.itinerary!.map((w) => w.alt)))).toBeGreaterThan(LITCHI_MAX_ALT_M);
    expect(status(p, 'litchi')).toBe('fail');
    expect(p.exportBlocked).toBe(true);
  });
});

describe('missing terrain fails closed', () => {
  it('partial coverage blocks export unless flat ground is confirmed', () => {
    const partial = { source: 'partial', elevation: (q: LngLat) => (proj.toLocal(q)[0] > 50 ? null : 100) };
    const p = buildPlan({ ...base, polygon: rect(-100, -100, 100, 100), home: ll([0, -120]) }, partial);
    expect(p.terrainStatus).toBe('incomplete');
    expect(status(p, 'terrain')).toBe('fail');
    expect(p.exportBlocked).toBe(true);
  });
});

import { FORMAT, parsePlansFile } from './planfile';
import { PlanError } from './plan';
import { polygonFromKml } from './kml';

describe('#4 imported settings are range-checked and plans are validated before saving', () => {
  const D = DEFAULT_INPUT as unknown as Record<string, unknown>;
  const square = rect(-100, -100, 100, 100);
  const file = (settings: object, polygon: unknown = square) =>
    JSON.stringify({ format: FORMAT, version: 1, plans: [{ name: 'X', polygon, home: ll([0, -120]), settings }] });

  it('sideOverlap 1 falls back to the default instead of crashing the planner', () => {
    const r = parsePlansFile(file({ sideOverlap: 1 }), D);
    expect(r.plans.length).toBe(1);
    expect(r.plans[0].settings.sideOverlap).toBe(DEFAULT_INPUT.sideOverlap);
  });
  it('other out-of-range values fall back too', () => {
    const s = parsePlansFile(file({ speedMs: 0, altitudeM: 1e9, bufferM: -5, reservePct: 2 }), D).plans[0].settings;
    expect([s.speedMs, s.altitudeM, s.bufferM, s.reservePct]).toEqual([DEFAULT_INPUT.speedMs, DEFAULT_INPUT.altitudeM, DEFAULT_INPUT.bufferM, DEFAULT_INPUT.reservePct]);
  });
  it('degenerate and oversized areas are skipped with a reason', () => {
    const line = ([[-100, 0], [0, 0], [100, 0]] as XY[]).map(ll);
    expect(parsePlansFile(file({}, line), D).skipped[0]).toMatch(/too small|in a line/);
    const huge = rect(-5000, -5000, 5000, 5000);
    expect(parsePlansFile(file({}, huge), D).skipped[0]).toMatch(/limit/);
  });
  it('the planner itself refuses out-of-range input with a readable error', () => {
    expect(() => buildPlan({ ...base, polygon: square, home: ll([0, -120]), sideOverlap: 1 })).toThrow(PlanError);
  });
});

describe('#9 KML import reads the Polygon, not the first coordinates element', () => {
  const ring = '98.1,3.5,0 98.11,3.5,0 98.11,3.51,0 98.1,3.51,0 98.1,3.5,0';
  it('skips a takeoff Point placed before the polygon', () => {
    const kml = `<kml><Document><Placemark><Point><coordinates>98.0,3.4,0</coordinates></Point></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
    expect(polygonFromKml(kml)?.length).toBe(5);
  });
  it('is not fooled by a LineString with three or more points', () => {
    const kml = `<kml><Placemark><LineString><coordinates>1,1 2,2 3,3 4,4</coordinates></LineString></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    expect(polygonFromKml(kml)![0]).toEqual([98.1, 3.5]);
  });
  it('handles namespaced KML and ignores inner rings', () => {
    const kml = `<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Polygon><kml:innerBoundaryIs><kml:LinearRing><kml:coordinates>9,9 9,8 8,8</kml:coordinates></kml:LinearRing></kml:innerBoundaryIs>
      <kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>${ring}</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs></kml:Polygon></kml:kml>`;
    expect(polygonFromKml(kml)![0]).toEqual([98.1, 3.5]);
  });
  it('returns null when there is no polygon', () => {
    expect(polygonFromKml('<kml><Point><coordinates>1,2,0</coordinates></Point></kml>')).toBeNull();
  });
});
