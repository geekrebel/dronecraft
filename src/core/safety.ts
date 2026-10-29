/**
 * Conservative terrain model for flight safety.
 *
 * The elevation data (SRTM, ~30 m) smooths away narrow features and can be misplaced by a cell or
 * more, so the planner never uses it directly for clearance. It uses:
 * - an obstacle surface: the highest DEM value within `radiusM` of each point (covers cliff edges and
 *   misregistration; it cannot recover spires much narrower than a DEM cell — see `maxSlope`);
 * - a takeoff elevation: the lowest DEM value within `radiusM` of takeoff, so an over-reading at
 *   takeoff (common in forest clearings) makes the drone fly higher, never lower;
 * - the steepest DEM slope, used to detect rock formations the data cannot represent.
 */
import type { XY } from './projection';
import { Bounds, gridSize } from './limits';

export const SAFETY_RADIUS_M = 30;
export const GRID_STEP_M = 10;
/** DEM slope (rise per metre over 20 m) above which narrow rock formations are likely underestimated. */
export const STEEP_SLOPE = 1;


export class SafeTerrain {
  private nx: number;
  private ny: number;
  private raw: Float64Array;
  private hi: Float64Array;
  readonly maxSlope: number;
  /** Where the steepest slope is, for the user. */
  readonly maxSlopeAt: XY;

  constructor(
    private ground: (xy: XY) => number,
    private b: Bounds,
    private radiusM = SAFETY_RADIUS_M,
    private step = GRID_STEP_M,
  ) {
    const size = gridSize(b, step);
    this.nx = size.nx;
    this.ny = size.ny;
    const N = this.nx * this.ny;
    this.raw = new Float64Array(N);
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) this.raw[j * this.nx + i] = ground([b.x0 + i * step, b.y0 + j * step]);
    // Separable square max filter; a square of half-width r contains the disc of radius r.
    const r = Math.ceil(radiusM / step);
    const tmp = new Float64Array(N);
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        let m = -Infinity;
        for (let k = Math.max(0, i - r); k <= Math.min(this.nx - 1, i + r); k++) m = Math.max(m, this.raw[j * this.nx + k]);
        tmp[j * this.nx + i] = m;
      }
    this.hi = new Float64Array(N);
    for (let i = 0; i < this.nx; i++)
      for (let j = 0; j < this.ny; j++) {
        let m = -Infinity;
        for (let k = Math.max(0, j - r); k <= Math.min(this.ny - 1, j + r); k++) m = Math.max(m, tmp[k * this.nx + i]);
        this.hi[j * this.nx + i] = m;
      }
    // Steepest slope over a 20 m baseline in x, y and both diagonals.
    let s = 0;
    let at: XY = [b.x0, b.y0];
    const d = 2;
    for (let j = 0; j + d < this.ny; j++)
      for (let i = 0; i + d < this.nx; i++) {
        const v = this.raw[j * this.nx + i];
        const cands = [
          Math.abs(this.raw[j * this.nx + i + d] - v) / (d * step),
          Math.abs(this.raw[(j + d) * this.nx + i] - v) / (d * step),
          Math.abs(this.raw[(j + d) * this.nx + i + d] - v) / (d * step * Math.SQRT2),
          Math.abs(this.raw[(j + d) * this.nx + i] - this.raw[j * this.nx + i + d]) / (d * step * Math.SQRT2),
        ];
        const c = Math.max(...cands);
        if (c > s) {
          s = c;
          at = [b.x0 + (i + 1) * step, b.y0 + (j + 1) * step];
        }
      }
    this.maxSlope = s;
    this.maxSlopeAt = at;
  }

  private inside([x, y]: XY) {
    return x >= this.b.x0 && y >= this.b.y0 && x <= this.b.x0 + (this.nx - 1) * this.step && y <= this.b.y0 + (this.ny - 1) * this.step;
  }

  private bilinear(grid: Float64Array, [x, y]: XY) {
    const fx = (x - this.b.x0) / this.step;
    const fy = (y - this.b.y0) / this.step;
    const i = Math.min(this.nx - 2, Math.max(0, Math.floor(fx)));
    const j = Math.min(this.ny - 2, Math.max(0, Math.floor(fy)));
    const dx = fx - i;
    const dy = fy - j;
    const g = (a: number, c: number) => grid[c * this.nx + a];
    return g(i, j) * (1 - dx) * (1 - dy) + g(i + 1, j) * dx * (1 - dy) + g(i, j + 1) * (1 - dx) * dy + g(i + 1, j + 1) * dx * dy;
  }

  /** Highest ground within the safety radius. Outside the grid, sample the DEM directly in a ring. */
  obstacle(xy: XY): number {
    if (this.inside(xy)) return this.bilinear(this.hi, xy);
    let m = this.ground(xy);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      m = Math.max(m, this.ground([xy[0] + this.radiusM * Math.cos(a), xy[1] + this.radiusM * Math.sin(a)]));
    }
    return m;
  }

  /** Lowest ground within the safety radius, used for the takeoff point. */
  lowest(xy: XY): number {
    let m = this.ground(xy);
    for (const f of [0.5, 1])
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        m = Math.min(m, this.ground([xy[0] + f * this.radiusM * Math.cos(a), xy[1] + f * this.radiusM * Math.sin(a)]));
      }
    return m;
  }
}
