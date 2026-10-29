/**
 * Profile translation holds in these generous battery/height fixtures. It does not authorize
 * manual edits: changing field heights requires replanning, which can change battery splits.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT, buildPlan } from './plan';
import { LngLat, XY, dist, makeProjection } from './projection';
import { FunctionTerrain } from './terrain';

const proj = makeProjection([98.1, 3.56]);
const ll = (xy: XY) => proj.toLngLat(xy);
const poly: LngLat[] = ([[-150, -120], [150, -120], [150, 120], [-150, 120]] as XY[]).map(ll);
const hills = new FunctionTerrain((p) => {
  const [x, y] = proj.toLocal(p);
  return 300 + 0.4 * y + 40 * Math.sin(x / 60);
});
const input = { ...DEFAULT_INPUT, polygon: poly, home: ll([0, -150]), canopyM: 30, droneMaxAltM: 500, maxAltitudeM: 500, maxRangeM: 2000, batteryMin: 31, reservePct: 0.2 };

describe('formation profile translation when mission partitions remain unchanged', () => {
  for (const [f0, d] of [[10, 40], [20, 100], [5, 150]]) {
    it(`base ${f0} m, raised by ${d} m`, () => {
      const base = buildPlan({ ...input, formationM: f0 }, hills);
      const high = buildPlan({ ...input, formationM: f0 + d }, hills);
      expect(high.missions.length).toBe(base.missions.length);
      base.missions.forEach((m, i) => {
        const a = m.itinerary!;
        const b = high.missions[i].itinerary!;
        expect(b.length).toBe(a.length);
        a.forEach((w, k) => {
          expect(dist(w.xy, b[k].xy)).toBeLessThan(0.01);
          expect(b[k].alt - w.alt).toBeCloseTo(d, 6);
        });
      });
      // RTH altitude rises by d, within the 5 m rounding.
      expect(Math.abs(high.terrain!.rthAltM - base.terrain!.rthAltM - d)).toBeLessThanOrEqual(5);
      // Planned clearance is measured above treetops + formation allowance, so it is unchanged;
      // height above the real ground rises by d.
      expect(high.minClearanceM).toBeCloseTo(base.minClearanceM, 6);
      expect(high.maxAboveGroundM - base.maxAboveGroundM).toBeCloseTo(d, 6);
      // Each mission takes longer: extra climb at 3 m/s and descent at 2.5 m/s.
      base.missions.forEach((m, i) => {
        const extra = high.missions[i].timeS - m.timeS;
        expect(extra).toBeGreaterThan(0);
        expect(extra).toBeLessThanOrEqual(d / 3 + d / 2.5 + 5 / 3 + 5 / 2.5 + 1e-6);
      });
    });
  }
});
