import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_INPUT, LITCHI_MIN_ALT_M, PlanError, buildPlan, runChecks } from './plan';
import { FunctionTerrain, tilesFor } from './terrain';
import { LngLat, XY, dist, makeProjection } from './projection';
import { pathStats } from './profile';
import { missionWaypoints, parseLitchiCsv, toLitchiCsv } from './litchi';
import { SafeTerrain } from './safety';
import { MAX_TERRAIN_CELLS, gridSize } from './limits';
import { measurementKeys, staleMeasurements } from './measurements';
import { parsePlansFile, serializePlans } from './planfile';
import { toKml } from './kml';
import { PlanStore } from './store';
import { safeStorage } from './storage';

const projection = makeProjection([98.12, 3.55]);
const ll = (xy: XY) => projection.toLngLat(xy);
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] =>
  ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as XY[]).map(ll);
const status = (plan: ReturnType<typeof buildPlan>, id: string) => plan.checks.find((c) => c.id === id)?.status;

describe('issue #2: field measurements belong to their surveyed geometry', () => {
  const polygon = rect(-100, -100, 100, 100);
  const home = ll([0, -200]);
  const terrain = new FunctionTerrain((q) => Math.max(-100, Math.min(0, 0.2 * (projection.toLocal(q)[1] + 200))));
  const input = {
    ...DEFAULT_INPUT, ...measurementKeys(polygon, home), polygon, home, gridAngleDeg: 0 as const,
    obstacleFloorM: 110, maxRangeM: 2000, maxAltitudeM: 200, droneMaxAltM: 300,
  };

  it('blocks the original unsafe lower-takeoff reproduction until remeasured', () => {
    const original = buildPlan(input, terrain);
    expect(original.exportBlocked).toBe(false);
    const moved = buildPlan({ ...input, home: ll([0, -700]) }, terrain);
    expect(status(moved, 'measurements')).toBe('fail');
    expect(moved.exportBlocked).toBe(true);
    const remeasured = buildPlan({ ...input, home: ll([0, -700]), obstacleFloorM: 210, ...measurementKeys(polygon, ll([0, -700])) }, terrain);
    expect(status(remeasured, 'measurements')).toBe('pass');
    for (const m of remeasured.missions)
      for (const w of m.itinerary!) expect(terrain.elevation(remeasured.input.home) + w.alt).toBeGreaterThanOrEqual(140 - 1e-6);
  });

  it('invalidates area edits and legacy measurements without context', () => {
    const surveyed = { ...input, formationM: 100 };
    expect(staleMeasurements(surveyed, polygon, home)).toEqual([]);
    expect(staleMeasurements(surveyed, rect(-100, -100, 110, 100), home)).toHaveLength(2);
    expect(staleMeasurements({ ...surveyed, obstacleMeasuredFor: '', formationMeasuredFor: '' }, polygon, home)).toHaveLength(2);
    expect(staleMeasurements(surveyed, polygon, ll([0, -201]))).toEqual(['Highest obstacle above takeoff']);
  });

  it('preserves context through backup/import without authorizing later geometry edits', () => {
    const settings = { ...DEFAULT_INPUT, ...measurementKeys(polygon, home), obstacleFloorM: 110 };
    const text = serializePlans([{ id: 'test', name: 'survey', updatedAt: 1, polygon, home, settings }]);
    const imported = parsePlansFile(text, DEFAULT_INPUT).plans[0];
    expect(staleMeasurements(imported.settings, imported.polygon, imported.home)).toEqual([]);
    expect(staleMeasurements(imported.settings, imported.polygon, ll([0, -700]))).toHaveLength(1);
  });
});

describe('issue #2: actual takeoff datum and complete return height', () => {
  it('matches independently reconstructed CSV height and blocks the 133 m flight', () => {
    const terrain = new FunctionTerrain((q) => 100 - 0.5 * projection.toLocal(q)[0]);
    const plan = buildPlan({ ...DEFAULT_INPUT, polygon: rect(0, 0, 200, 20), home: ll([0, 0]), gridAngleDeg: 0, altitudeM: 100, droneMaxAltM: 500 }, terrain);
    expect(plan.terrain!.homeElevM).toBeCloseTo(100, 6);
    expect(plan.terrain!.clearanceHomeElevM).toBeCloseTo(85, 5);
    const m = plan.missions[0];
    const rows = parseLitchiCsv(toLitchiCsv(missionWaypoints(m, plan.proj, {
      altitudeM: 100, speedMs: 5, gimbalPitch: -90, trigger: 'distance', photoSpacingM: plan.photoSpacingM, photoIntervalS: plan.photoIntervalS,
    }, plan.homeXY)));
    const ground = (xy: XY) => terrain.elevation(plan.proj.toLngLat(xy));
    const physical = pathStats(rows.map((w) => ({ xy: plan.proj.toLocal([w.lon, w.lat]), alt: w.alt })), ground, ground, 100, 1);
    expect(physical.maxAboveGround).toBeGreaterThan(132);
    expect(plan.maxAboveGroundM).toBeGreaterThanOrEqual(physical.maxAboveGround - 0.1);
    expect(status(plan, 'height')).toBe('fail');
    expect(plan.exportBlocked).toBe(true);
    const kml = toKml(plan, 'datum');
    const coordinates = kml.match(/<LineString>[\s\S]*?<coordinates>([^<]+)/)![1].trim().split(/\s+/);
    expect(Number(coordinates[0].split(',')[2])).toBeCloseTo(100 + m.itinerary![0].alt, 1);
  });

  it('checks a return over a valley at the current altitude, above the RTH setting', () => {
    const polygon = rect(-100, 90, 100, 110);
    const home = ll([0, -200]);
    const input = { ...DEFAULT_INPUT, polygon, home, gridAngleDeg: 0 as const, droneMaxAltM: 500 };
    const flat = buildPlan(input, new FunctionTerrain(() => 100));
    const end = projection.toLocal(flat.proj.toLngLat(flat.missions[0].itinerary!.at(-1)!.xy));
    const cx = end[0] / 2, cy = (end[1] - 200) / 2;
    const terrain = new FunctionTerrain((q) => {
      const [x, y] = projection.toLocal(q);
      return 100 - 80 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 75 ** 2);
    });
    const plan = buildPlan(input, terrain);
    const ground = (xy: XY) => terrain.elevation(plan.proj.toLngLat(xy));
    const last = plan.missions[0].itinerary!.at(-1)!;
    const alt = Math.max(last.alt, plan.terrain!.rthAltM);
    const physical = pathStats([{ xy: last.xy, alt }, { xy: plan.homeXY, alt }], ground, ground, terrain.elevation(home), 1);
    expect(last.alt).toBeGreaterThan(plan.terrain!.rthAltM);
    expect(physical.maxAboveGround).toBeGreaterThan(160);
    expect(plan.maxAboveGroundM).toBeGreaterThanOrEqual(physical.maxAboveGround - 1);
    expect(status(plan, 'height')).toBe('fail');
    expect(plan.exportBlocked).toBe(true);
  });
});

describe('issue #2: supported relative altitudes', () => {
  it('blocks the -356 m downhill reproduction', () => {
    const terrain = new FunctionTerrain((q) => 450 - 0.3 * projection.toLocal(q)[0]);
    const plan = buildPlan({ ...DEFAULT_INPUT, polygon: rect(1300, 0, 1500, 20), home: ll([0, 0]), gridAngleDeg: 0, maxRangeM: 5000, maxAltitudeM: 500, droneMaxAltM: 500 }, terrain);
    expect(Math.min(...plan.missions.flatMap((m) => m.itinerary!.map((w) => w.alt)))).toBeLessThan(-350);
    expect(status(plan, 'litchi')).toBe('fail');
    expect(plan.exportBlocked).toBe(true);
  });

  it.each([[-200.01, 'fail'], [LITCHI_MIN_ALT_M, 'caution'], [-199.99, 'caution'], [0, 'pass'], [500, 'pass'], [500.01, 'fail']])('grades altitude %s at the importer boundary', (alt, expected) => {
    const checks = runChecks({
      input: { ...DEFAULT_INPUT, polygon: rect(0, 0, 200, 200), home: ll([0, 0]), flatGroundConfirmed: true },
      camera: { name: 'test', sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalLengthMm: 8.38, imageWidthPx: 5472, imageHeightPx: 3648, minIntervalS: 2 },
      missions: [], interval: 3, worst: 0.8, budget: 1000, homeToPolygonM: 0,
      minClear: 80, minLineClear: 80, maxAgl: 80, maxVert: 0, terrain: null,
      terrainStatus: 'none', shortestLeg: 1, longestLeg: 100, minAlt: Number(alt), maxAlt: Number(alt), photoSpacing: 15,
    });
    expect(checks.find((c) => c.id === 'litchi')!.status).toBe(expected);
  });
});

describe('issue #2: terrain workloads fail before allocation and fetching', () => {
  it('rejects the 50 km takeoff before even sampling terrain', () => {
    const elevation = vi.fn(() => 100);
    expect(() => buildPlan({ ...DEFAULT_INPUT, polygon: rect(0, 0, 200, 200), home: ll([50000, 50000]) }, { source: 'test', elevation })).toThrow(/Move it within/);
    expect(elevation).not.toHaveBeenCalled();
  });

  it('bounds allocations independently of polygon area', () => {
    const ground = vi.fn(() => 100);
    expect(() => new SafeTerrain(ground, { x0: 0, y0: 0, x1: 50000, y1: 50000 })).toThrow(PlanError);
    expect(ground).not.toHaveBeenCalled();
    expect(gridSize({ x0: 0, y0: 0, x1: 9990, y1: 9990 }, 10).nx ** 2).toBe(MAX_TERRAIN_CELLS);
    expect(() => gridSize({ x0: 0, y0: 0, x1: Infinity, y1: 100 }, 10)).toThrow(PlanError);
  });

  it('refuses oversized tile requests and polar singularities before enumeration', () => {
    expect(() => tilesFor([[97, 2], [99, 4]])).toThrow(/too many elevation tiles/);
    expect(() => tilesFor([[0, 90]])).toThrow(/supported elevation map/);
  });
});

describe('issue #2: both terrain diagonals', () => {
  it.each([1, -1])('detects >100%% slope in diagonal direction %s', (sign) => {
    const terrain = new SafeTerrain(([x, y]) => 0.8 * (x + sign * y), { x0: 0, y0: 0, x1: 100, y1: 100 });
    expect(terrain.maxSlope).toBeCloseTo(Math.SQRT2 * 0.8, 8);
    expect(terrain.maxSlope).toBeGreaterThan(1);
  });
});

describe('issue #2: memory fallback is never reported as saved', () => {
  const makeStorage = () => {
    const values = new Map<string, string>();
    return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) } as Storage;
  };
  const doc = { name: 'survey', polygon: rect(0, 0, 200, 200), home: ll([0, 0]), settings: DEFAULT_INPUT };

  it('shows unsaved before and after successful memory writes, including a blocked storage getter', () => {
    const unavailable = () => { throw new Error('SecurityError'); };
    const store = new PlanStore(safeStorage(unavailable));
    expect(store.saved).toBe(false);
    const plan = store.create(doc);
    store.save({ ...plan, name: 'edited' });
    expect(store.list()[0].name).toBe('edited');
    expect(store.saved).toBe(false);
    expect(new PlanStore(safeStorage(unavailable)).list()).toHaveLength(0);
  });

  it('handles denied writes at startup and preserves ordinary persistent reloads', () => {
    const blocked = makeStorage();
    blocked.setItem = () => { throw new Error('QuotaExceededError'); };
    const memory = new PlanStore(safeStorage(() => blocked));
    memory.create(doc);
    expect(memory.saved).toBe(false);
    const available = makeStorage();
    const store = new PlanStore(safeStorage(() => available));
    store.create(doc);
    expect(store.saved).toBe(true);
    expect(new PlanStore(safeStorage(() => available)).list()).toHaveLength(1);
  });
});
