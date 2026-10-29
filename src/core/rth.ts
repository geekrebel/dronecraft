import { ItinWp } from './itinerary';
import { XY, dist } from './projection';
import { maxAlong } from './profile';

/** DJI Air 2S Straight Line RTH. Do not apply this model to other aircraft or Power Saving RTH.
 * https://repair.dji.com/help/content?customId=en-us03400006776&documentType=artical&lang=en
 * At <=50 m the setting cannot provide extra clearance. Treat exactly 5 m as landing too,
 * conservatively covering both boundary interpretations in DJI's documentation.
 */
export function air2sReturnMode(distanceM: number): 'land' | 'current' | 'climb' {
  return distanceM <= 5 ? 'land' : distanceM <= 50 ? 'current' : 'climb';
}

interface ReturnRay { high: number; required: number; lowestGround: number; canClimb: boolean }

/** Conservative sampled envelope for Smart RTH and up to 50 m of Failsafe retracing.
 * Check both holding the trigger altitude and following historical altitude: DJI does not
 * specify the retrace's vertical interpolation. Restoration of the link can start a direct
 * return anywhere on that retrace. Landing inside 5 m needs the separately surveyed clearing.
 */
export class Air2sReturns {
  private rays = new Map<string, ReturnRay>();
  settingM = 20;
  /** Shortfall in clearance that increasing the RTH setting cannot repair. */
  shortfallM = 0;

  constructor(
    private home: XY,
    private need: (p: XY) => number,
    private ground: (p: XY) => number,
  ) {}

  private direct(p: XY, low: number, high: number) {
    const mode = air2sReturnMode(dist(p, this.home));
    if (mode === 'land') return;
    const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    let ray = this.rays.get(key);
    if (!ray) {
      let lowestGround = Infinity;
      const required = maxAlong(p, this.home, (q) => {
        lowestGround = Math.min(lowestGround, this.ground(q));
        return this.need(q);
      }, 5);
      ray = { high, required, lowestGround, canClimb: mode === 'climb' };
      this.rays.set(key, ray);
    }
    ray.high = Math.max(ray.high, high);
    const required = ray.required;
    if (mode === 'climb') {
      if (low < required) this.settingM = Math.max(this.settingM, required);
    } else {
      this.shortfallM = Math.max(this.shortfallM, required - low);
    }
  }

  add(wps: ItinWp[]) {
    // One metre near home resolves the 5/50 m branches; elsewhere five metres also resolves
    // the 50 m retrace more closely than the flight's ten metre terrain check.
    const path: { xy: XY; alt: number; along: number }[] = [];
    let along = 0;
    for (let i = 0; i + 1 < wps.length; i++) {
      const a = wps[i], b = wps[i + 1];
      const length = dist(a.xy, b.xy);
      const step = Math.min(dist(a.xy, this.home), dist(b.xy, this.home)) <= length + 100 ? 1 : 5;
      const n = Math.max(1, Math.ceil(length / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        path.push({ xy: [a.xy[0] + (b.xy[0] - a.xy[0]) * t, a.xy[1] + (b.xy[1] - a.xy[1]) * t], alt: a.alt + (b.alt - a.alt) * t, along: along + length * t });
      }
      along += length;
    }
    if (wps.length) path.push({ ...wps[wps.length - 1], along });
    for (let i = 0; i < path.length; i++) {
      const start = path[i];
      this.direct(start.xy, start.alt, start.alt);
      if (air2sReturnMode(dist(start.xy, this.home)) !== 'climb') continue;
      for (let j = i - 1; j >= 0; j--) {
        const prior = path[j];
        const next = path[j + 1];
        const remaining = 50 - (start.along - next.along);
        const length = next.along - prior.along;
        const t = length > remaining ? remaining / length : 1;
        const p: XY = [next.xy[0] + (prior.xy[0] - next.xy[0]) * t, next.xy[1] + (prior.xy[1] - next.xy[1]) * t];
        const historical = next.alt + (prior.alt - next.alt) * t;
        const low = Math.min(start.alt, historical), high = Math.max(start.alt, historical);
        // A straight segment's minimum envelope is sampled along with the forward itinerary.
        if (air2sReturnMode(dist(p, this.home)) !== 'land') this.shortfallM = Math.max(this.shortfallM, this.need(p) - low);
        this.direct(p, low, high);
        if (t < 1 || start.along - prior.along >= 50 || dist(p, this.home) <= 5) break;
      }
    }
    this.settingM = Math.max(this.settingM, this.need(this.home));
  }

  maxAgl(homeElev: number, setting: number): number {
    return [...this.rays.values()].reduce((max, r) => Math.max(max, homeElev + (r.canClimb ? Math.max(r.high, setting) : r.high) - r.lowestGround), -Infinity);
  }
}
