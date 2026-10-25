import { describe, expect, it } from 'vitest';
import { FORMAT, parsePlansFile, sanitizeSettings, serializePlans } from './planfile';
import { DEFAULT_INPUT } from './plan';
import type { PlanDoc } from './store';

const D = DEFAULT_INPUT as unknown as Record<string, unknown>;
const poly: [number, number][] = [
  [98.1, 3.5],
  [98.11, 3.5],
  [98.11, 3.51],
];
const doc = (name: string, over: Partial<PlanDoc<typeof D>> = {}): PlanDoc<typeof D> => ({
  id: 'x',
  name,
  polygon: poly,
  home: [98.105, 3.49],
  settings: { ...D, altitudeM: 95, trigger: 'time', gridAngleDeg: 30 },
  updatedAt: 1,
  ...over,
});

describe('plan file', () => {
  it('round trips plans, settings and takeoff', () => {
    const text = serializePlans([doc('A'), doc('B', { home: null })]);
    const { plans, skipped } = parsePlansFile(text, D);
    expect(skipped).toEqual([]);
    expect(plans.map((p) => p.name)).toEqual(['A', 'B']);
    expect(plans[0].polygon).toEqual(poly);
    expect(plans[0].home).toEqual([98.105, 3.49]);
    expect(plans[1].home).toBeNull();
    expect(plans[0].settings.altitudeM).toBe(95);
    expect(plans[0].settings.trigger).toBe('time');
    expect(plans[0].settings.gridAngleDeg).toBe(30);
  });

  it('rejects non-JSON and foreign JSON', () => {
    expect(parsePlansFile('nope', D).skipped[0]).toMatch(/not valid JSON/);
    expect(parsePlansFile('{"type":"FeatureCollection"}', D).skipped[0]).toMatch(/Not a DroneCraft/);
  });

  it('refuses files from a newer format version', () => {
    const t = JSON.stringify({ format: FORMAT, version: 99, plans: [] });
    expect(parsePlansFile(t, D).skipped[0]).toMatch(/newer version/);
  });

  it('skips plans with bad areas and keeps the rest', () => {
    const t = JSON.stringify({
      format: FORMAT,
      version: 1,
      plans: [
        { name: 'good', polygon: poly },
        { name: 'two points', polygon: poly.slice(0, 2) },
        { name: 'bad coords', polygon: [[1, 2], [3, 'x'], [5, 6]] },
        { name: 'out of range', polygon: [[200, 0], [0, 0], [0, 1]] },
      ],
    });
    const r = parsePlansFile(t, D);
    expect(r.plans.map((p) => p.name)).toEqual(['good']);
    expect(r.skipped.length).toBe(3);
  });

  it('fills missing settings from defaults and drops bad values', () => {
    const s = sanitizeSettings({ altitudeM: 'high', speedMs: 6, trigger: 'sometimes', gridAngleDeg: 'auto', junk: 1 }, D);
    expect(s.altitudeM).toBe(D.altitudeM);
    expect(s.speedMs).toBe(6);
    expect(s.trigger).toBe(D.trigger);
    expect(s.gridAngleDeg).toBe('auto');
    expect('junk' in s).toBe(false);
  });

  it('names unnamed plans and truncates long names', () => {
    const t = JSON.stringify({ format: FORMAT, version: 1, plans: [{ polygon: poly }, { name: 'x'.repeat(100), polygon: poly }] });
    const r = parsePlansFile(t, D);
    expect(r.plans[0].name).toBe('Plan 1');
    expect(r.plans[1].name.length).toBe(60);
  });
});
