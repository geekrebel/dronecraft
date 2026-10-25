import { Line, lineLength } from './grid';
import { XY, dist } from './projection';

export interface FlightSettings {
  altitudeM: number; // above takeoff (flat terrain until terrain following lands)
  speedMs: number; // speed on mapping lines
  transitSpeedMs: number; // speed to and from home
  climbMs: number;
  descentMs: number;
  turnOverheadS: number; // decel/accel per waypoint stop
  batteryMin: number;
  reservePct: number; // 0..1
  maxWaypoints: number;
}

export const DEFAULT_FLIGHT: FlightSettings = {
  altitudeM: 80,
  speedMs: 5,
  transitSpeedMs: 10,
  climbMs: 3,
  descentMs: 2.5,
  turnOverheadS: 4,
  batteryMin: 27,
  reservePct: 0.3,
  maxWaypoints: 99,
};

export interface Mission {
  index: number;
  lines: Line[];
  waypointCount: number;
  lineDistanceM: number;
  totalDistanceM: number;
  timeS: number;
  maxDistFromHomeM: number;
  /** True if a single flight line had to be cut to fit the battery. */
  splitLine: boolean;
}

export function budgetS(f: FlightSettings): number {
  return f.batteryMin * 60 * (1 - f.reservePct);
}

/** Estimate flight time for an ordered set of lines starting and ending at home. */
export function estimate(lines: Line[], home: XY, f: FlightSettings) {
  if (!lines.length) return { timeS: 0, lineDistanceM: 0, totalDistanceM: 0, maxDistFromHomeM: 0 };
  let lineDist = 0;
  let connDist = 0;
  let maxD = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    lineDist += lineLength(l);
    if (i > 0) connDist += dist(lines[i - 1].end, l.start);
    maxD = Math.max(maxD, dist(home, l.start), dist(home, l.end));
  }
  const toFirst = dist(home, lines[0].start);
  const fromLast = dist(lines[lines.length - 1].end, home);
  const waypoints = lines.length * 2;
  const timeS =
    f.altitudeM / f.climbMs +
    toFirst / f.transitSpeedMs +
    (lineDist + connDist) / f.speedMs +
    waypoints * f.turnOverheadS +
    fromLast / f.transitSpeedMs +
    f.altitudeM / f.descentMs;
  return {
    timeS,
    lineDistanceM: lineDist,
    totalDistanceM: toFirst + lineDist + connDist + fromLast,
    maxDistFromHomeM: maxD,
  };
}

function reverseLines(lines: Line[]): Line[] {
  return lines
    .slice()
    .reverse()
    .map((l) => ({ start: l.end, end: l.start }));
}

/** Cut a line into equal pieces no longer than maxLen. */
function cutLine(l: Line, maxLen: number): Line[] {
  const len = lineLength(l);
  const n = Math.ceil(len / maxLen);
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    out.push({
      start: [l.start[0] + (l.end[0] - l.start[0]) * t0, l.start[1] + (l.end[1] - l.start[1]) * t0],
      end: [l.start[0] + (l.end[0] - l.start[0]) * t1, l.start[1] + (l.end[1] - l.start[1]) * t1],
    });
  }
  return out;
}

/**
 * Greedily pack ordered lines into missions that respect waypoint and battery limits.
 * Lines are kept whole unless a single line alone exceeds the battery budget.
 * Each mission is oriented so it starts at the end nearer home.
 */
export function splitMissions(lines: Line[], home: XY, f: FlightSettings): Mission[] {
  const budget = budgetS(f);
  const fits = (ls: Line[]) =>
    ls.length * 2 <= f.maxWaypoints && estimate(ls, home, f).timeS <= budget;

  const groups: { lines: Line[]; split: boolean }[] = [];
  let cur: Line[] = [];
  for (const line of lines) {
    if (fits([...cur, line])) {
      cur.push(line);
      continue;
    }
    if (cur.length) {
      groups.push({ lines: cur, split: false });
      cur = [];
    }
    if (fits([line])) {
      cur = [line];
      continue;
    }
    // Single line too long: cut until each piece fits on its own.
    let pieces = 2;
    let parts = cutLine(line, lineLength(line) / pieces);
    while (!parts.every((p) => fits([p])) && pieces < 64) {
      pieces++;
      parts = cutLine(line, lineLength(line) / pieces);
    }
    for (const p of parts) groups.push({ lines: [p], split: true });
  }
  if (cur.length) groups.push({ lines: cur, split: false });

  return groups.map((g, i) => {
    let ls = g.lines;
    const first = ls[0].start;
    const last = ls[ls.length - 1].end;
    if (dist(home, last) < dist(home, first)) ls = reverseLines(ls);
    const e = estimate(ls, home, f);
    return {
      index: i + 1,
      lines: ls,
      waypointCount: ls.length * 2,
      lineDistanceM: e.lineDistanceM,
      totalDistanceM: e.totalDistanceM,
      timeS: e.timeS,
      maxDistFromHomeM: e.maxDistFromHomeM,
      splitLine: g.split,
    };
  });
}
