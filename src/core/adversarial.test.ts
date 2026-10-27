/**
 * Adversarial terrain tests: steep rock formations (karst towers, spires, cliffs) that a 30 m DEM
 * cannot represent. The planner only sees a simulated SRTM made from the true surface; each test
 * then measures clearance of the exported flight against the TRUE surface.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT, buildPlan, type Plan, type PlanInput } from './plan';
import { LngLat, XY, dist, makeProjection } from './projection';
import type { Terrain } from './terrain';

const C: LngLat = [98.1, 3.56];
const proj = makeProjection(C);
const ll = (xy: XY) => proj.toLngLat(xy);
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] =>
  ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as XY[]).map(ll);

type Surface = (xy: XY) => number;

/** A steep-sided tower: flat top `h` m above `base`, walls from radius r to r + wall (near vertical when wall is small). */
const tower = (cx: number, cy: number, r: number, h: number, wall = 5): Surface => ([x, y]) => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= r ? h : d >= r + wall ? 0 : h * (1 - (d - r) / wall);
};
const cliff = (x0: number, h: number, wall = 5): Surface => ([x]) => (x <= x0 ? 0 : x >= x0 + wall ? h : (h * (x - x0)) / wall);
const sum = (...fs: Surface[]): Surface => (p) => fs.reduce((s, f) => s + f(p), 0);
const max = (...fs: Surface[]): Surface => (p) => Math.max(...fs.map((f) => f(p)));
const base = (elev: number): Surface => () => elev;

/**
 * Simulated SRTM: the true surface averaged over 30 m cells (radar footprint), posted on a 30 m grid,
 * optionally misregistered by (dx, dy) metres, bilinearly interpolated. Like the real tiles, it never
 * sees anything narrower than a cell at full height.
 */
function simulatedDem(truth: Surface, cell = 30, offset: XY = [0, 0]): Terrain {
  const cache = new Map<string, number>();
  const cellMean = (i: number, j: number) => {
    const k = `${i},${j}`;
    let v = cache.get(k);
    if (v === undefined) {
      let s = 0;
      const n = 6;
      for (let a = 0; a < n; a++)
        for (let b = 0; b < n; b++) s += truth([(i + (a + 0.5) / n - 0.5) * cell + offset[0], (j + (b + 0.5) / n - 0.5) * cell + offset[1]]);
      v = s / (n * n);
      cache.set(k, v);
    }
    return v;
  };
  return {
    source: 'simulated SRTM',
    elevation(p: LngLat) {
      const [x, y] = proj.toLocal(p);
      const fx = x / cell;
      const fy = y / cell;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const dx = fx - i;
      const dy = fy - j;
      return (
        cellMean(i, j) * (1 - dx) * (1 - dy) + cellMean(i + 1, j) * dx * (1 - dy) + cellMean(i, j + 1) * (1 - dx) * dy + cellMean(i + 1, j + 1) * dx * dy
      );
    },
  };
}

/** True clearance of the exported flight and of a straight RTH from every point, at 2 m resolution. */
function trueClearance(p: Plan, truth: Surface, canopyM: number) {
  // Plan altitudes are relative to the takeoff elevation the planner believed; the drone actually
  // takes off from the true ground at home.
  const homeTrue = truth(p.homeXY);
  const top = (xy: XY) => truth(xy) + canopyM;
  let flight = Infinity;
  let rth = Infinity;
  const rthAlt = p.terrain?.rthAltM ?? 0;
  for (const m of p.missions) {
    const w = m.itinerary!;
    // Takeoff: vertical climb to the first waypoint.
    for (let i = 0; i + 1 < w.length; i++) {
      const a = w[i];
      const b = w[i + 1];
      const n = Math.max(1, Math.ceil(dist(a.xy, b.xy) / 2));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const xy: XY = [a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t];
        const alt = a.alt + (b.alt - a.alt) * t;
        flight = Math.min(flight, homeTrue + alt - top(xy));
        // RTH from here: climb to max(alt, rthAlt), straight line home at that altitude.
        if (k % 5 === 0) {
          const ra = Math.max(alt, rthAlt);
          const nn = Math.max(1, Math.ceil(dist(xy, p.homeXY) / 4));
          for (let q = 0; q <= nn; q++) {
            const pp: XY = [xy[0] + ((p.homeXY[0] - xy[0]) * q) / nn, xy[1] + ((p.homeXY[1] - xy[1]) * q) / nn];
            if (dist(pp, p.homeXY) < 10) continue; // final vertical descent at home
            rth = Math.min(rth, homeTrue + ra - top(pp));
          }
        }
      }
    }
  }
  return { flight, rth };
}

const inputFor = (polygon: LngLat[], home: XY, over: Partial<PlanInput> = {}): PlanInput => ({
  ...DEFAULT_INPUT,
  polygon,
  home: ll(home),
  altitudeM: 80,
  canopyM: 30,
  minClearanceM: 30,
  speedMs: 5,
  gridAngleDeg: 0,
  maxRangeM: 2000,
  maxAltitudeM: 500,
  ...over,
});

interface Scenario {
  name: string;
  truth: Surface;
  polygon: LngLat[];
  home: XY;
  offset?: XY;
  over?: Partial<PlanInput>;
}

const scenarios: Scenario[] = [
  {
    name: 'karst tower 80 m wide, 150 m sheer walls, mid-block',
    truth: sum(base(150), tower(0, 0, 40, 150, 4)),
    polygon: rect(-250, -200, 250, 200),
    home: [0, -260],
  },
  {
    name: 'rock spire 24 m wide, 110 m tall (below DEM resolution)',
    truth: sum(base(150), tower(30, 10, 12, 110, 3)),
    polygon: rect(-250, -200, 250, 200),
    home: [0, -260],
  },
  {
    name: 'cliff 120 m high crossing every line',
    truth: sum(base(150), cliff(40, 120, 4)),
    polygon: rect(-250, -200, 250, 200),
    home: [-200, -260],
  },
  {
    name: 'takeoff in a valley 25 m from a 140 m tower',
    truth: sum(base(150), tower(0, -200, 35, 140, 4)),
    polygon: rect(-250, -150, 250, 200),
    home: [0, -260],
  },
  {
    name: 'cliff with DEM misregistered 25 m',
    truth: sum(base(150), cliff(40, 120, 4)),
    polygon: rect(-250, -200, 250, 200),
    home: [-200, -260],
    offset: [25, 0],
  },
  {
    name: 'tower cluster, lines across',
    truth: sum(base(150), max(tower(-120, 40, 30, 130, 4), tower(60, -60, 25, 160, 4), tower(150, 120, 20, 120, 3))),
    polygon: rect(-250, -200, 250, 200),
    home: [0, -260],
  },
];

describe('adversarial: rock formations against the true surface', () => {
  for (const s of scenarios) {
    it(s.name, () => {
      const dem = simulatedDem(s.truth, 30, s.offset ?? [0, 0]);
      const p = buildPlan(inputFor(s.polygon, s.home, s.over), dem);
      const c = trueClearance(p, s.truth, 30);
      const report = `${s.name}: blocked=${p.exportBlocked} plannedMin=${p.minClearanceM.toFixed(1)} TRUE flight=${c.flight.toFixed(1)} TRUE rth=${c.rth.toFixed(1)} rthAlt=${p.terrain?.rthAltM} maxAlt=${Math.max(...p.missions.flatMap((m) => m.itinerary!.map((w) => w.alt))).toFixed(0)} fails=${p.checks.filter((x) => x.status === 'fail').map((x) => x.id).join(',')}`;
      console.log(report);
      // Safety property: if export is allowed, the drone must truly clear the treetops
      // on the flight and on RTH. A plan that is blocked is safe by definition.
      if (!p.exportBlocked) {
        expect(c.flight, report).toBeGreaterThan(0);
        expect(c.rth, report).toBeGreaterThan(0);
      }
    });
  }
});

describe('adversarial: slowing down until export unblocks', () => {
  for (const s of scenarios) {
    it(`${s.name} (smaller block, slower)`, () => {
      const dem = simulatedDem(s.truth, 30, s.offset ?? [0, 0]);
      const small = s.polygon.map((q) => {
        const [x, y] = proj.toLocal(q);
        return ll([x * 0.5, y * 0.5 + (s.name.startsWith('takeoff') ? -60 : 0)]);
      });
      for (const speedMs of [5, 4, 3, 2, 1.5, 1]) {
        const p = buildPlan(inputFor(small, s.home, { ...s.over, speedMs, batteryMin: 31, reservePct: 0.2 }), dem);
        const c = trueClearance(p, s.truth, 30);
        const line = `  ${s.name} @${speedMs} m/s: blocked=${p.exportBlocked} TRUE flight=${c.flight.toFixed(1)} rth=${c.rth.toFixed(1)} fails=${p.checks.filter((x) => x.status === 'fail').map((x) => x.id).join(',')}`;
        console.log(line);
        if (!p.exportBlocked) {
          expect(c.flight, line).toBeGreaterThan(0);
          expect(c.rth, line).toBeGreaterThan(0);
          break;
        }
      }
    });
  }
});

describe('adversarial: with the highest obstacle measured in the field', () => {
  for (const s of scenarios) {
    for (const error of [0, -10]) {
      it(`${s.name}, obstacle height entered ${error === 0 ? 'exactly' : `${-error} m too low`}`, () => {
        const dem = simulatedDem(s.truth, 30, s.offset ?? [0, 0]);
        // What you'd read in DJI Fly hovering level with the tallest rock/tree top: the true highest
        // treetop above the true takeoff ground.
        let top = -Infinity;
        for (let x = -400; x <= 400; x += 2) for (let y = -400; y <= 400; y += 2) top = Math.max(top, s.truth([x, y]) + 30);
        const floor = Math.ceil(top - s.truth(s.home)) + error;
        const p = buildPlan(inputFor(s.polygon, s.home, { ...s.over, obstacleFloorM: floor, droneMaxAltM: 500, speedMs: 3, batteryMin: 31, reservePct: 0.2 }), dem);
        const c = trueClearance(p, s.truth, 30);
        const line = `${s.name} floor=${floor}: blocked=${p.exportBlocked} TRUE flight=${c.flight.toFixed(1)} rth=${c.rth.toFixed(1)} fails=${p.checks.filter((x) => x.status === 'fail').map((x) => x.id).join(',')}`;
        console.log(line);
        // With the obstacle height entered, the plan must be safe whether or not it is exportable.
        expect(c.flight, line).toBeGreaterThan(30 + error - 1.01);
        expect(c.rth, line).toBeGreaterThan(30 + error - 1.01);
      });
    }
  }
});
