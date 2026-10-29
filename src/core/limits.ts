import { XY, dist } from './projection';

/** Errors that can be explained directly to the operator. */
export class PlanError extends Error {}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Three Float64 grids use at most 24 MB, before decoded elevation tiles and map data.
export const MAX_TERRAIN_CELLS = 1_000_000;
export const MAX_TERRAIN_TILES = 256;

export function gridSize(b: Bounds, step: number): { nx: number; ny: number } {
  if (!Object.values(b).every(Number.isFinite) || !Number.isFinite(step) || step <= 0 || b.x1 < b.x0 || b.y1 < b.y0)
    throw new PlanError('The terrain bounds are invalid. Choose a smaller area and a nearby takeoff point.');
  const nx = Math.max(2, Math.ceil((b.x1 - b.x0) / step) + 1);
  const ny = Math.max(2, Math.ceil((b.y1 - b.y0) / step) + 1);
  if (nx * ny > MAX_TERRAIN_CELLS)
    throw new PlanError('The terrain area is too large. Split the area or move takeoff closer before loading elevation.');
  return { nx, ny };
}

export function minDistToRing(p: XY, ring: XY[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, dist(p, [a[0] + t * dx, a[1] + t * dy]));
  }
  return inside ? 0 : best;
}

/** Apply the existing takeoff-distance failure threshold before any terrain work. */
export function checkTakeoffDistance(home: XY, ring: XY[], maxRangeM: number): number {
  const distance = minDistToRing(home, ring);
  if (!Number.isFinite(distance) || distance > maxRangeM * 0.5 + 0.001)
    throw new PlanError(`Takeoff is ${Math.round(distance)} m outside the area. Move it within ${Math.round(maxRangeM * 0.5)} m before planning or loading elevation.`);
  return distance;
}
