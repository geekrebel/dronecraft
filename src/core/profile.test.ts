import { describe, expect, it } from 'vitest';
import { at, maxAlong, maxVerticalSpeed, pathStats, profileLine } from './profile';
import { DEFAULT_INPUT, TERRAIN_TOL_M, buildPlan } from './plan';
import { LngLat, XY, makeProjection } from './projection';
import { FunctionTerrain } from './terrain';
import { missionWaypoints, parseLitchiCsv, toLitchiCsv } from './litchi';

const line = { start: [0, 0] as XY, end: [500, 0] as XY };

describe('profileLine', () => {
  it('flat surface: just the two ends', () => {
    const w = profileLine(line, () => 100);
    expect(w).toEqual([
      { t: 0, alt: 100 },
      { t: 1, alt: 100 },
    ]);
  });
  it('linear slope: just the two ends (interpolation is exact)', () => {
    expect(profileLine(line, ([x]) => 100 + 0.2 * x).length).toBe(2);
  });
  it('a ridge in the middle adds waypoints and stays within tolerance everywhere', () => {
    const f = ([x]: XY) => 100 + 60 * Math.exp(-(((x - 250) / 60) ** 2));
    const w = profileLine(line, f, 5, 10);
    expect(w.length).toBeGreaterThan(2);
    for (let x = 0; x <= 500; x += 10) {
      const t = x / 500;
      const i = w.findIndex((p) => p.t >= t - 1e-12);
      const a = w[Math.max(0, i - 1)];
      const b = w[i];
      const interp = b.t === a.t ? b.alt : a.alt + ((b.alt - a.alt) * (t - a.t)) / (b.t - a.t);
      expect(Math.abs(interp - f([x, 0]))).toBeLessThanOrEqual(5 + 1e-9);
    }
  });
});

describe('pathStats', () => {
  it('finds a ridge between two waypoints that a naive check would miss', () => {
    const ground = ([x]: XY) => (x > 240 && x < 260 ? 70 : 0);
    const path = [
      { xy: [0, 0] as XY, alt: 80 },
      { xy: [500, 0] as XY, alt: 80 },
    ];
    const s = pathStats(path, ground, ground, 0, 10);
    expect(s.minClearance).toBe(10);
    expect(s.minClearanceAt![0]).toBeGreaterThan(240);
    expect(s.maxAboveGround).toBe(80);
  });
  it('vertical speed scales with gradient and speed', () => {
    const path = [
      { xy: [0, 0] as XY, alt: 0 },
      { xy: [100, 0] as XY, alt: 30 },
    ];
    expect(maxVerticalSpeed(path, 5)).toBeCloseTo(1.5, 9);
  });
  it('maxAlong samples the whole segment', () => {
    expect(maxAlong([0, 0], [100, 0], ([x]) => x)).toBe(100);
  });
});

describe('buildPlan with terrain', () => {
  const C: LngLat = [98.12, 3.55];
  const proj = makeProjection(C);
  const poly: LngLat[] = ([[-150, -150], [150, -150], [150, 150], [-150, 150]] as XY[]).map((p) => proj.toLngLat(p));
  const home = proj.toLngLat([0, -180]);
  // Ground rising 0.3 m per metre to the north from 100 m at the centre: 90 m of relief over the block.
  const slope = new FunctionTerrain((p) => 100 + 0.3 * proj.toLocal(p)[1]);
  const input = { ...DEFAULT_INPUT, polygon: poly, home, altitudeM: 80, canopyM: 30, minClearanceM: 30 };

  it('waypoint altitudes are height above trees + tree height + ground rise relative to takeoff', () => {
    const p = buildPlan(input, slope);
    expect(p.terrainStatus).toBe('loaded');
    const homeElev = 100 + 0.3 * -180;
    expect(p.terrain!.homeElevM).toBeCloseTo(homeElev, 6);
    for (const m of p.missions)
      for (const l of m.lines)
        for (const w of l.wps!) {
          const y = at(l, w.t)[1];
          const expected = 100 + 0.3 * y + 30 + 80 - homeElev;
          expect(Math.abs(w.alt - expected)).toBeLessThanOrEqual(TERRAIN_TOL_M);
        }
  });

  it('clearance above trees stays near the target height and passes', () => {
    const p = buildPlan(input, slope);
    expect(p.minLineClearanceM).toBeGreaterThan(80 - TERRAIN_TOL_M - 1e-6);
    expect(p.minClearanceM).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(p.checks.find((c) => c.id === 'clearance')!.status).toBe('pass');
  });

  it('exactly at the height limit is a caution, not a failure', () => {
    const flat = new FunctionTerrain(() => 100);
    const p = buildPlan({ ...input, altitudeM: 90, canopyM: 30 }, flat);
    expect(p.checks.find((c) => c.id === 'height')!.status).toBe('caution');
  });

  it('height above ground includes tree height and fails a 120 m limit at 100 m above 30 m trees', () => {
    const p = buildPlan({ ...input, altitudeM: 100 }, slope);
    expect(p.maxAboveGroundM).toBeGreaterThanOrEqual(130 - 1e-6);
    expect(p.checks.find((c) => c.id === 'height')!.status).toBe('fail');
  });

  it('adds a climb waypoint above takeoff and recommends an RTH altitude', () => {
    const p = buildPlan(input, slope);
    for (const m of p.missions) {
      // At least tree height + minimum clearance over the takeoff point, and the leg out keeps that clearance.
      expect(m.climbAltM!).toBeGreaterThanOrEqual(30 + 30 - 1e-6);
    }
    expect(p.minClearanceM).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(p.terrain!.rthAltM % 5).toBe(0);
    expect(p.terrain!.rthAltM).toBeGreaterThanOrEqual(Math.max(...p.missions.flatMap((m) => m.lines.flatMap((l) => l.wps!.map((w) => w.alt)))));
  });

  it('CSV carries the climb waypoint and per-waypoint altitudes; photos stop at each line end', () => {
    const p = buildPlan(input, slope);
    const m = p.missions[0];
    const wps = parseLitchiCsv(
      toLitchiCsv(
        missionWaypoints(m, p.proj, { altitudeM: 80, speedMs: 5, gimbalPitch: -90, trigger: 'distance', photoSpacingM: p.photoSpacingM, photoIntervalS: p.photoIntervalS }, p.homeXY),
      ),
    );
    expect(wps.length).toBe(m.waypointCount);
    expect(wps[0].alt).toBeCloseTo(m.climbAltM!, 1);
    expect(wps[0].photoDist).toBe(-1);
    const alts = new Set(wps.slice(1).map((w) => Math.round(w.alt)));
    expect(alts.size).toBeGreaterThan(1); // altitude varies with the slope
    let i = 1;
    for (const l of m.lines) {
      for (let k = 0; k < l.wps!.length; k++, i++) expect(wps[i].photoDist > 0).toBe(k < l.wps!.length - 1);
    }
  });

  it('steep terrain trips the climb-rate check', () => {
    const steep = new FunctionTerrain((p) => 100 + 1.2 * proj.toLocal(p)[1]);
    const p = buildPlan({ ...input, gridAngleDeg: 90, speedMs: 5 }, steep);
    expect(p.maxVerticalMs).toBeGreaterThan(4);
    expect(p.checks.find((c) => c.id === 'climb')!.status).toBe('fail');
  });

  it('partial coverage falls back to flat planning and says so', () => {
    const partial = new FunctionTerrain((p) => (proj.toLocal(p)[0] > 100 ? null! : 100));
    const p = buildPlan(input, { source: 'partial', elevation: (q) => partial.elevation(q) });
    expect(p.terrainStatus).toBe('incomplete');
    expect(p.terrain).toBeNull();
  });

  it('without terrain, altitude above takeoff is height above trees + tree height', () => {
    const p = buildPlan(input);
    for (const m of p.missions) for (const l of m.lines) for (const w of l.wps!) expect(w.alt).toBe(110);
    expect(p.missions.every((m) => m.climbAltM === undefined)).toBe(true);
  });
});
