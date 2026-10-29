import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT, buildPlan, grade } from './plan';
import { FunctionTerrain, decodeTile } from './terrain';
import { XY, makeProjection } from './projection';
import { measurementKeys } from './measurements';
import { pathStats } from './profile';
import { itineraryTime, ItinWp } from './itinerary';
import { missionWaypoints, toLitchiCsv } from './litchi';
import { toKml } from './kml';
import { Air2sReturns, air2sReturnMode } from './rth';
import { HEIGHT_CHANGE_GUIDANCE, RESUME_GUIDANCE, RTH_GUIDANCE } from './guidance';
import { parsePlansFile, serializePlans } from './planfile';

const proj = makeProjection([98.12, 3.55]);
const ll = (xy: XY) => proj.toLngLat(xy);
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as XY[]).map(ll);
const site = (polygon = rect(-100, -100, 100, 100), home = ll([0, -120])) =>
  ({ ...DEFAULT_INPUT, ...measurementKeys(polygon, home), polygon, home, gridAngleDeg: 0 as const });
const flat = new FunctionTerrain(() => 100);
const status = (p: ReturnType<typeof buildPlan>, id: string) => p.checks.find(c => c.id === id)?.status;

it('requires regenerated missions from home instead of using low RTH as resume height', () => {
  const input = { ...site(rect(-100, 0, 100, 400), ll([0, -100])), droneMaxAltM: 500, maxAltitudeM: 500 };
  const terrain = new FunctionTerrain(q => 100 + .4 * proj.toLocal(q)[1]);
  const p = buildPlan(input, terrain);
  const target = p.missions[0].itinerary!.reduce((a, b) => a.alt > b.alt ? a : b);
  const ground = (xy: XY) => terrain.elevation(p.proj.toLngLat(xy));
  const rth = p.terrain!.rthAltM;
  const unsafe = pathStats([{ xy: p.homeXY, alt: rth }, { xy: target.xy, alt: rth }], ground, ground, terrain.elevation(input.home), 1);
  expect(unsafe.minClearance).toBeLessThan(0); // still a valid reason never to use this transit
  expect(RESUME_GUIDANCE).toContain('plan the remaining area in DroneCraft');
  expect(RESUME_GUIDANCE).toContain('first waypoint from the planned takeoff');
});

it('replans field height changes: the original battery split and legal ceiling no longer hold', () => {
  const input = { ...site(rect(-265, -50, 265, 50), ll([0, -70])), formationM: 5, batteryMin: 15 };
  const base = buildPlan(input, flat);
  expect(base.exportBlocked).toBe(false);
  const raised = base.missions.map(m => itineraryTime(m.itinerary!.map(w => ({ ...w, alt: w.alt + 100 })), base.homeXY,
    { climbMs: 3, descentMs: 2.5, perWaypointS: 4, returnSpeedMs: 10, rthAltM: base.terrain!.rthAltM + 100 }));
  expect(Math.max(...raised)).toBeGreaterThan(630);
  const rebuilt = buildPlan({ ...input, formationM: 105, droneMaxAltM: 220 }, flat);
  expect(rebuilt.missions.length).toBeGreaterThan(base.missions.length);
  expect(status(rebuilt, 'height')).toBe('fail');
  expect(rebuilt.exportBlocked).toBe(true);
  expect(HEIGHT_CHANGE_GUIDANCE).toContain('regenerate every mission');
  expect(HEIGHT_CHANGE_GUIDANCE).toContain('Manual altitude edits in Litchi invalidate');
});

describe('Air 2S documented return branches', () => {
  it.each([[0, 'land'], [4.99, 'land'], [5, 'land'], [5.01, 'current'], [49.99, 'current'], [50, 'current'], [50.01, 'climb']] as const)('distance %s uses %s', (d, mode) => {
    expect(air2sReturnMode(d)).toBe(mode);
  });
  const wp = (x: number, alt: number): ItinWp => ({ xy: [x, 0], alt, speed: 5, photo: false, heading: 0, kind: 'line' });
  it('does not pretend a higher setting repairs the near-home current-altitude route', () => {
    const returns = new Air2sReturns([0, 0], () => 60, () => 0);
    returns.add([wp(30, 40)]);
    expect(returns.shortfallM).toBe(20);
    expect(returns.maxAgl(0, 500)).toBe(40);
  });
  it('includes the unraised signal-loss retrace before the RTH climb', () => {
    const returns = new Air2sReturns([0, 0], p => p[0] < 80 ? 80 : 30, () => 0);
    returns.add([wp(60, 100), wp(110, 40)]);
    expect(returns.shortfallM).toBeGreaterThan(0);
    expect(RTH_GUIDANCE).toContain('Signal loss can retrace');
  });
  it('blocks the adversarial near-home terrain case even with a high RTH setting', () => {
    const polygon = ([[600, -100], [750, -100], [750, 100], [600, 100], [600, 20], [63, 20], [63, -20], [600, -20]] as XY[]).map(ll);
    const terrain = new FunctionTerrain(q => { const [x, y] = proj.toLocal(q); return 20 * Math.exp(-((x - 15) ** 2 + (y - 5) ** 2) / 100) + 20 * Math.max(0, Math.min(1, (x - 300) / 200)); });
    const p = buildPlan({ ...site(polygon, ll([0, 0])), altitudeM: 31, speedMs: 6, frontOverlap: .6, batteryMin: 31, reservePct: .2, droneMaxAltM: 500, maxAltitudeM: 500 }, terrain);
    expect(status(p, 'return-clearance')).toBe('fail');
    expect(p.terrain!.returnShortfallM).toBeGreaterThan(0);
    expect(p.exportBlocked).toBe(true);
  });
});

describe('field survey cannot be inferred from elevation data', () => {
  it('blocks unverified zero allowances even with a flat DEM, and permits an explicitly surveyed clear site', () => {
    const input = site();
    expect(status(buildPlan({ ...input, siteSurveyedFor: '' }, flat), 'survey')).toBe('fail');
    expect(buildPlan(input, flat).exportBlocked).toBe(false);
    expect(status(buildPlan({ ...input, home: ll([0, -121]) }, flat), 'survey')).toBe('fail');
    expect(status(buildPlan({ ...input, polygon: rect(-100, -100, 101, 100) }, flat), 'survey')).toBe('fail');
  });
  it('preserves survey through backup, while legacy settings require a new survey', () => {
    const input = site();
    const doc = { id: 'survey', name: 'survey', updatedAt: 1, polygon: input.polygon, home: input.home, settings: input };
    const imported = parsePlansFile(serializePlans([doc]), DEFAULT_INPUT).plans[0];
    expect(imported.settings.siteSurveyedFor).toBe(input.siteSurveyedFor);
    const { siteSurveyedFor: _old, ...legacy } = doc.settings;
    const old = parsePlansFile(serializePlans([{ ...doc, settings: legacy }]), DEFAULT_INPUT).plans[0];
    expect(old.settings.siteSurveyedFor).toBe('');
  });
  it('blocks the narrow spire missed by a gentle, averaged DEM until surveyed', () => {
    const input = { ...site(), siteSurveyedFor: '' };
    const p0 = buildPlan(input, flat);
    const cy = p0.missions.flatMap(m => m.lines).map(l => proj.toLocal(p0.proj.toLngLat(l.start))[1]).find(y => y > 0)!;
    const truth = ([x, y]: XY) => 100 + (Math.hypot(x - 2.5, y - cy) <= 6 ? 110 : 0);
    const cells = new Map<string, number>();
    const mean = (i: number, j: number) => {
      const key = `${i},${j}`;
      if (!cells.has(key)) {
        let sum = 0;
        for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) sum += truth([(i + (a + .5) / 6 - .5) * 30, (j + (b + .5) / 6 - .5) * 30]);
        cells.set(key, sum / 36);
      }
      return cells.get(key)!;
    };
    const dem = new FunctionTerrain(q => {
      const [x, y] = proj.toLocal(q), fx = x / 30, fy = y / 30, i = Math.floor(fx), j = Math.floor(fy), dx = fx - i, dy = fy - j;
      return mean(i, j) * (1 - dx) * (1 - dy) + mean(i + 1, j) * dx * (1 - dy) + mean(i, j + 1) * (1 - dx) * dy + mean(i + 1, j + 1) * dx * dy;
    });
    const p = buildPlan(input, dem);
    expect(p.terrain!.maxSlope).toBeLessThan(1);
    expect(status(p, 'survey')).toBe('fail');
    expect(p.exportBlocked).toBe(true);
    const surveyed = buildPlan({ ...input, formationM: 110, ...measurementKeys(input.polygon, input.home), maxAltitudeM: 500, droneMaxAltM: 500 }, dem);
    expect(status(surveyed, 'survey')).toBe('pass');
    let clearance = Infinity;
    const realGround = (xy: XY) => truth(proj.toLocal(surveyed.proj.toLngLat(xy)));
    for (const m of surveyed.missions) clearance = Math.min(clearance, pathStats(m.itinerary!, realGround, realGround, truth(proj.toLocal(input.home)), .25).minClearance);
    expect(clearance).toBeGreaterThanOrEqual(30);
  });
});

describe('invalid elevation and export numbers fail closed', () => {
  it.each([NaN, Infinity, -Infinity])('rejects elevation %s even when a flat fallback was confirmed', value => {
    expect(() => buildPlan({ ...site(), flatGroundConfirmed: true }, new FunctionTerrain(() => value))).toThrow(/invalid height/);
    expect(grade(value, 1, 2)).toBe('fail');
  });
  it('rejects a corrupt sample away from takeoff', () => {
    expect(() => buildPlan(site(), new FunctionTerrain(q => proj.toLocal(q)[0] > 30 ? NaN : 100))).toThrow(/invalid height/);
  });
  it('rejects truncated decoded tiles before invalid heights enter the sampler', () => {
    expect(() => decodeTile(new Uint8Array(4))).toThrow(/invalid size/);
  });
  it.each(['alt', 'lat', 'speed', 'heading', 'photoDist'] as const)('CSV rejects nonfinite %s independently of planner', field => {
    const p = buildPlan(site(), flat);
    const rows = missionWaypoints(p.missions[0], p.proj, { altitudeM: 80, speedMs: 5, gimbalPitch: -90, trigger: 'distance', photoSpacingM: p.photoSpacingM, photoIntervalS: p.photoIntervalS }, p.homeXY);
    rows[0][field] = NaN;
    expect(() => toLitchiCsv(rows)).toThrow(/invalid number/);
  });
  it('KML rejects nonfinite altitude independently of planner', () => {
    const p = buildPlan(site(), flat);
    p.missions[0].itinerary![0].alt = Infinity;
    expect(() => toKml(p, 'corrupt')).toThrow(/invalid number/);
  });
});
