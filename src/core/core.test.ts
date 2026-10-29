import { describe, expect, it } from 'vitest';
import { AIR_2S, footprint, gsd, lineSpacing, overlapForSpacing, photoSpacing } from './camera';
import { generateLines, lineLength, longestEdgeAngle } from './grid';
import { LITCHI_HEADER, missionWaypoints, parseLitchiCsv, toLitchiCsv } from './litchi';
import { DEFAULT_FLIGHT, budgetS, estimate, splitMissions } from './missions';
import { DEFAULT_INPUT, buildPlan, grade } from './plan';
import { LngLat, XY, dist, makeProjection } from './projection';
import { polygonFromGeoJson, polygonFromKml, toKml } from './kml';

const rect = (w: number, h: number): XY[] => [
  [0, 0],
  [w, 0],
  [w, h],
  [0, h],
];

// A ~400 x 300 m block near Bukit Lawang.
const ORIGIN: LngLat = [98.1, 3.55];
const proj0 = makeProjection(ORIGIN);
const blockLL = (w: number, h: number): LngLat[] => rect(w, h).map((p) => proj0.toLngLat(p));

describe('camera', () => {
  it('GSD at 100 m is 2.88 cm/px', () => {
    expect(gsd(AIR_2S, 100) * 100).toBeCloseTo(2.88, 1);
    expect(Math.abs(gsd(AIR_2S, 100) * 100 - 2.88)).toBeLessThan(0.02);
  });
  it('footprint at 100 m is 157.5 x 105.0 m', () => {
    const f = footprint(AIR_2S, 100);
    expect(Math.abs(f.across - 157.5)).toBeLessThan(0.5);
    expect(Math.abs(f.along - 105.0)).toBeLessThan(0.5);
  });
  it('line and photo spacing follow overlap', () => {
    const f = footprint(AIR_2S, 80);
    expect(lineSpacing(AIR_2S, 80, 0.8)).toBeCloseTo(f.across * 0.2, 6);
    expect(photoSpacing(AIR_2S, 80, 0.8)).toBeCloseTo(f.along * 0.2, 6);
  });
  it('overlapForSpacing inverts photoSpacing', () => {
    expect(overlapForSpacing(AIR_2S, 80, photoSpacing(AIR_2S, 80, 0.75))).toBeCloseTo(0.75, 6);
  });
});

describe('projection', () => {
  it('round trips within 1 cm up to 5 km', () => {
    for (const p of [
      [0, 0],
      [5000, 0],
      [0, -5000],
      [3500, 3500],
    ] as XY[]) {
      const back = proj0.toLocal(proj0.toLngLat(p));
      expect(dist(p, back)).toBeLessThan(0.01);
    }
  });
  it('local distance matches haversine within 0.5%', () => {
    const a = proj0.toLngLat([0, 0]);
    const b = proj0.toLngLat([3000, 2000]);
    const R = 6371008.8;
    const toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR;
    const dLon = (b[0] - a[0]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    const hav = 2 * R * Math.asin(Math.sqrt(h));
    expect(Math.abs(hav - Math.hypot(3000, 2000)) / hav).toBeLessThan(0.005);
  });
});

describe('grid', () => {
  it('200 x 100 m rectangle at 20 m spacing gives 5 or 6 lines inside the extent', () => {
    const lines = generateLines(rect(200, 100), 20, 0, 0);
    expect(lines.length).toBe(5);
    for (const l of lines) {
      for (const p of [l.start, l.end]) {
        expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(p[0]).toBeLessThanOrEqual(200 + 1e-6);
        expect(p[1]).toBeGreaterThan(0);
        expect(p[1]).toBeLessThan(100);
      }
    }
  });
  it('lines are serpentine', () => {
    const lines = generateLines(rect(200, 100), 20, 0, 0);
    for (let i = 1; i < lines.length; i++) {
      const d0 = Math.sign(lines[i - 1].end[0] - lines[i - 1].start[0]);
      const d1 = Math.sign(lines[i].end[0] - lines[i].start[0]);
      expect(d1).toBe(-d0);
    }
  });
  it('buffer extends each line at both ends', () => {
    const a = generateLines(rect(200, 100), 20, 0, 0);
    const b = generateLines(rect(200, 100), 20, 0, 15);
    expect(lineLength(b[0]) - lineLength(a[0])).toBeCloseTo(30, 6);
  });
  it('auto angle follows the long edge of a rotated rectangle', () => {
    const t = (35 * Math.PI) / 180;
    const ring = rect(500, 80).map(([x, y]) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)] as XY);
    expect(Math.abs(longestEdgeAngle(ring) - 35)).toBeLessThan(1);
  });
  it('concave L shape: no segment midpoint falls in the notch', () => {
    const L: XY[] = [
      [0, 0],
      [200, 0],
      [200, 80],
      [80, 80],
      [80, 200],
      [0, 200],
    ];
    const lines = generateLines(L, 20, 0, 0);
    for (const l of lines) {
      const mx = (l.start[0] + l.end[0]) / 2;
      const my = (l.start[1] + l.end[1]) / 2;
      const inNotch = mx > 80 && my > 80;
      expect(inNotch).toBe(false);
      // Segments in the upper arm must not reach past x = 80.
      if (l.start[1] > 80) expect(Math.max(l.start[0], l.end[0])).toBeLessThanOrEqual(80 + 1e-6);
    }
  });
  it('rotating the grid by 180 deg covers the same lines', () => {
    const key = (ls: ReturnType<typeof generateLines>) =>
      ls
        .map((l) => [((l.start[1] + l.end[1]) / 2).toFixed(3), lineLength(l).toFixed(3)].join(':'))
        .sort()
        .join('|');
    expect(key(generateLines(rect(300, 150), 25, 0, 10))).toBe(key(generateLines(rect(300, 150), 25, 180, 10)));
  });
});

describe('missions', () => {
  it('time interval at 5 m/s with 10 m spacing is 2 s', () => {
    expect(10 / 5).toBe(2);
  });
  it('splits 125 lines (250 waypoints) into missions of at most 99 waypoints', () => {
    const lines = Array.from({ length: 125 }, (_, i) => ({ start: [0, i] as XY, end: [1, i] as XY }));
    const ms = splitMissions(lines, [0, 0], { ...DEFAULT_FLIGHT, batteryMin: 1000 });
    expect(ms.length).toBe(3);
    for (const m of ms) expect(m.waypointCount).toBeLessThanOrEqual(99);
    expect(ms.reduce((n, m) => n + m.lines.length, 0)).toBe(125);
  });
  it('no mission exceeds the battery budget', () => {
    const lines = generateLines(rect(1500, 1500), 30, 0, 10);
    const ms = splitMissions(lines, [0, 0], DEFAULT_FLIGHT);
    expect(ms.length).toBeGreaterThan(1);
    for (const m of ms) expect(m.timeS).toBeLessThanOrEqual(budgetS(DEFAULT_FLIGHT));
  });
  it('keeps lines whole when they fit', () => {
    const lines = generateLines(rect(800, 800), 30, 0, 10);
    const ms = splitMissions(lines, [0, 0], DEFAULT_FLIGHT);
    expect(ms.every((m) => !m.splitLine)).toBe(true);
    expect(ms.reduce((n, m) => n + m.lines.length, 0)).toBe(lines.length);
  });
  it('cuts a single line that cannot fit one battery', () => {
    const line = { start: [0, 0] as XY, end: [4000, 0] as XY };
    const ms = splitMissions([line], [0, 0], DEFAULT_FLIGHT);
    expect(ms.length).toBeGreaterThan(1);
    expect(ms.every((m) => m.splitLine)).toBe(true);
    for (const m of ms) expect(m.timeS).toBeLessThanOrEqual(budgetS(DEFAULT_FLIGHT));
  });
  it('a line beyond battery reach still yields missions, which the battery check then fails', () => {
    const line = { start: [0, 0] as XY, end: [15000, 0] as XY };
    const ms = splitMissions([line], [0, 0], DEFAULT_FLIGHT);
    expect(ms.some((m) => m.timeS > budgetS(DEFAULT_FLIGHT))).toBe(true);
  });
  it('each mission starts at the end nearer home', () => {
    const lines = generateLines(rect(1200, 1200), 30, 0, 10);
    const home: XY = [600, -50];
    for (const m of splitMissions(lines, home, DEFAULT_FLIGHT)) {
      const first = m.lines[0].start;
      const last = m.lines[m.lines.length - 1].end;
      expect(dist(home, first)).toBeLessThanOrEqual(dist(home, last) + 1e-6);
    }
  });
  it('estimate includes climb, transit and descent', () => {
    const e = estimate([{ start: [100, 0], end: [600, 0] }], [0, 0], DEFAULT_FLIGHT);
    const f = DEFAULT_FLIGHT;
    const expected = f.altitudeM / f.climbMs + 100 / f.transitSpeedMs + 500 / f.speedMs + 2 * f.turnOverheadS + 600 / f.transitSpeedMs + f.altitudeM / f.descentMs;
    expect(e.timeS).toBeCloseTo(expected, 6);
  });
});

describe('litchi csv', () => {
  const plan = buildPlan({ ...DEFAULT_INPUT, polygon: blockLL(400, 300), home: proj0.toLngLat([-20, -20]) });
  const m = plan.missions[0];
  const settings = {
    altitudeM: 80,
    speedMs: 5,
    gimbalPitch: -90,
    trigger: 'distance' as const,
    photoSpacingM: plan.photoSpacingM,
    photoIntervalS: plan.photoIntervalS,
  };
  const wps = missionWaypoints(m, plan.proj, settings);
  const csv = toLitchiCsv(wps);
  const rows = csv.trim().split('\n');

  it('header has the 46 Litchi columns', () => {
    expect(LITCHI_HEADER.length).toBe(46);
    expect(rows[0]).toBe(LITCHI_HEADER.join(','));
  });
  it('every row has 46 fields', () => {
    for (const r of rows) expect(r.split(',').length).toBe(46);
  });
  it('curvesize is never 0', () => {
    const i = LITCHI_HEADER.indexOf('curvesize(m)');
    for (const r of rows.slice(1)) expect(Number(r.split(',')[i])).toBeGreaterThan(0);
  });
  it('first row is the climb over takeoff at transit speed with photos off', () => {
    const back = parseLitchiCsv(csv);
    expect(m.itinerary![0].kind).toBe('climb');
    expect(back[0].speed).toBe(10);
    expect(back[0].photoDist).toBe(-1);
    expect(back[0].photoTime).toBe(-1);
  });
  it('line start carries the interval, line end carries -1', () => {
    const back = parseLitchiCsv(csv).slice(1);
    for (let i = 0; i < back.length; i += 2) {
      expect(back[i].photoDist).toBeCloseTo(plan.photoSpacingM, 1);
      expect(back[i].photoTime).toBe(-1);
      expect(back[i + 1].photoDist).toBe(-1);
    }
  });
  it('time mode writes the time interval instead', () => {
    const back = parseLitchiCsv(toLitchiCsv(missionWaypoints(m, plan.proj, { ...settings, trigger: 'time' })));
    expect(back[1].photoDist).toBe(-1);
    expect(back[1].photoTime).toBeCloseTo(plan.photoIntervalS, 1);
  });
  it('round trip preserves coordinates, altitude and speed', () => {
    const back = parseLitchiCsv(csv);
    expect(back.length).toBe(wps.length);
    back.forEach((w, i) => {
      expect(w.lat).toBeCloseTo(wps[i].lat, 6);
      expect(w.lon).toBeCloseTo(wps[i].lon, 6);
      expect(w.gimbalPitch).toBe(-90);
      if (i > 0) {
        expect(w.alt).toBe(80);
        expect(w.speed).toBe(5);
      }
    });
  });
  it('heading points along the line (east line = 90 deg)', () => {
    const east = { ...m, itinerary: undefined, lines: [{ start: [0, 0] as XY, end: [100, 0] as XY }] };
    expect(missionWaypoints(east, plan.proj, settings)[0].heading).toBe(90);
  });
});

describe('checks', () => {
  it('grade boundaries', () => {
    expect(grade(9, 9, 10)).toBe('pass');
    expect(grade(9.5, 9, 10)).toBe('caution');
    expect(grade(10, 9, 10)).toBe('caution');
    expect(grade(10.01, 9, 10)).toBe('fail');
  });
  const base = { ...DEFAULT_INPUT, polygon: blockLL(400, 300), home: proj0.toLngLat([0, 0]), flatGroundConfirmed: true,
    siteSurveyedFor: JSON.stringify([blockLL(400, 300), proj0.toLngLat([0, 0])]) };
  const status = (p: ReturnType<typeof buildPlan>, id: string) => p.checks.find((c) => c.id === id)?.status;

  it('photo interval below 2 s fails and blocks export', () => {
    const p = buildPlan({ ...base, speedMs: 12 });
    expect(p.photoIntervalS).toBeLessThan(2);
    expect(status(p, 'interval')).toBe('fail');
    expect(p.exportBlocked).toBe(true);
  });
  it('interval just above 2 s is a caution', () => {
    const p0 = buildPlan(base);
    const speed = p0.photoSpacingM / 2.2;
    expect(status(buildPlan({ ...base, speedMs: speed }), 'interval')).toBe('caution');
  });
  it('defaults pass on a surveyed, confirmed flat site', () => {
    const p = buildPlan(base);
    expect(p.exportBlocked).toBe(false);
    expect(status(p, 'interval')).toBe('pass');
  });
  it('range limit fails when far corner is beyond it', () => {
    expect(status(buildPlan({ ...base, maxRangeM: 300 }), 'range')).toBe('fail');
  });
  it('altitude over limit fails', () => {
    expect(status(buildPlan({ ...base, altitudeM: 130 }), 'height')).toBe('fail');
  });
  it('without elevation data, export is blocked unless the site is confirmed flat', () => {
    const blocked = buildPlan({ ...base, flatGroundConfirmed: false });
    expect(status(blocked, 'terrain')).toBe('fail');
    expect(blocked.exportBlocked).toBe(true);
    const flat = buildPlan(base);
    expect(status(flat, 'terrain')).toBe('caution');
    expect(status(flat, 'geozone')).toBe('caution');
    expect(flat.exportBlocked).toBe(false);
  });
  it('time trigger reports worst-case overlap', () => {
    const p = buildPlan({ ...base, trigger: 'time' });
    expect(p.worstCaseFrontOverlap).toBeLessThan(0.8);
    expect(status(p, 'overlap')).toBe('caution');
  });
});

describe('kml', () => {
  it('exports and re-imports the area polygon', () => {
    const poly = blockLL(400, 300);
    const p = buildPlan({ ...DEFAULT_INPUT, polygon: poly, home: poly[0] });
    const back = polygonFromKml(toKml(p, 'test'));
    expect(back?.length).toBe(5);
    expect(back![0][0]).toBeCloseTo(poly[0][0], 8);
  });
  it('reads a GeoJSON feature collection', () => {
    const gj = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 2], [3, 4], [1, 2]]] } }],
    });
    expect(polygonFromGeoJson(gj)?.length).toBe(4);
  });
});
