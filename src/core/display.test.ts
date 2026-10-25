import { describe, expect, it } from 'vitest';
import { displayGeometry } from './display';
import { DEFAULT_INPUT, buildPlan } from './plan';
import { LngLat, XY, makeProjection } from './projection';

const proj0 = makeProjection([98.1, 3.55]);
const block = (w: number, h: number): LngLat[] =>
  ([
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ] as XY[]).map((p) => proj0.toLngLat(p));
const home = proj0.toLngLat([-30, -30]);
const colors = ['#a', '#b', '#c'];

describe('display geometry', () => {
  const plan = buildPlan({ ...DEFAULT_INPUT, polygon: block(1500, 1200), home });
  const g = displayGeometry(plan, home, colors);
  const totalLines = plan.missions.reduce((n, m) => n + m.lines.length, 0);

  it('has one feature per mapping line and one turn between consecutive lines', () => {
    expect(plan.missions.length).toBeGreaterThan(1);
    expect(g.lines.features.length).toBe(totalLines);
    expect(g.turns.features.length).toBe(totalLines - plan.missions.length);
  });

  it('path is continuous: each turn joins the previous line end to the next line start', () => {
    let li = 0;
    let ti = 0;
    for (const m of plan.missions) {
      for (let i = 1; i < m.lines.length; i++) {
        const prevEnd = g.lines.features[li + i - 1].geometry.coordinates[1];
        const nextStart = g.lines.features[li + i].geometry.coordinates[0];
        const turn = g.turns.features[ti++].geometry.coordinates;
        expect(turn[0]).toEqual(prevEnd);
        expect(turn[1]).toEqual(nextStart);
      }
      li += m.lines.length;
    }
  });

  it('transit legs connect takeoff to each mission start and end', () => {
    expect(g.transit.features.length).toBe(plan.missions.length * 2);
    g.starts.forEach((s, i) => {
      expect(g.transit.features[i * 2].geometry.coordinates[0]).toEqual(home);
      expect(g.transit.features[i * 2].geometry.coordinates[1]).toEqual(s.at);
      expect(g.transit.features[i * 2 + 1].geometry.coordinates[1]).toEqual(home);
    });
  });

  it('every line gets at least one direction arrow', () => {
    expect(g.arrows.features.length).toBeGreaterThanOrEqual(totalLines);
    for (const a of g.arrows.features) expect(a.geometry.coordinates.length).toBe(3);
  });

  it('missions are coloured in order and cycle', () => {
    expect(g.starts.map((s) => s.color)).toEqual(plan.missions.map((_, i) => colors[i % colors.length]));
  });

  it('photo dots roughly match the plan photo count', () => {
    const n = g.photos.features.length;
    expect(Math.abs(n - plan.photoCount) / plan.photoCount).toBeLessThan(0.05);
  });

  it('skips photo dots when there would be too many', () => {
    expect(displayGeometry(plan, home, colors, 10).photos.features.length).toBe(0);
  });
});
