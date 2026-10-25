import { describe, expect, it } from 'vitest';
import { defaultHome, edgeMidpoints, squareAround, translate } from './shapes';
import { centroid, dist, makeProjection } from './projection';

const C: [number, number] = [98.12, 3.55];

describe('shapes', () => {
  it('square has 4 corners, the right side length, and is centred', () => {
    const sq = squareAround(C, 200);
    expect(sq.length).toBe(4);
    const p = makeProjection(C);
    const l = sq.map((q) => p.toLocal(q));
    expect(dist(l[0], l[1])).toBeCloseTo(200, 3);
    expect(dist(l[1], l[2])).toBeCloseTo(200, 3);
    const c = centroid(sq);
    expect(c[0]).toBeCloseTo(C[0], 9);
    expect(c[1]).toBeCloseTo(C[1], 9);
  });

  it('default home sits 20 m south of the area', () => {
    const sq = squareAround(C, 200);
    const h = defaultHome(sq);
    const p = makeProjection(C);
    const local = p.toLocal(h);
    expect(local[0]).toBeCloseTo(0, 3);
    expect(local[1]).toBeCloseTo(-120, 3);
  });

  it('edge midpoints lie between consecutive corners, wrapping at the end', () => {
    const sq = squareAround(C, 200);
    const m = edgeMidpoints(sq);
    expect(m.length).toBe(4);
    expect(m[3][0]).toBeCloseTo((sq[3][0] + sq[0][0]) / 2, 12);
    expect(m[3][1]).toBeCloseTo((sq[3][1] + sq[0][1]) / 2, 12);
  });

  it('translate moves every vertex', () => {
    const sq = squareAround(C, 200);
    const t = translate(sq, 0.001, -0.002);
    t.forEach((q, i) => {
      expect(q[0]).toBeCloseTo(sq[i][0] + 0.001, 12);
      expect(q[1]).toBeCloseTo(sq[i][1] - 0.002, 12);
    });
  });
});
