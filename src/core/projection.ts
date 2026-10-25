/** Local equirectangular projection around an origin. Accurate to well under 1 m within a few km. */
export type LngLat = [number, number];
export type XY = [number, number];

const R = 6378137;
const DEG = Math.PI / 180;

export interface Projection {
  origin: LngLat;
  toLocal(p: LngLat): XY;
  toLngLat(p: XY): LngLat;
}

export function makeProjection(origin: LngLat): Projection {
  const [lon0, lat0] = origin;
  const cosLat = Math.cos(lat0 * DEG);
  return {
    origin,
    toLocal([lon, lat]) {
      return [(lon - lon0) * DEG * R * cosLat, (lat - lat0) * DEG * R];
    },
    toLngLat([x, y]) {
      return [lon0 + x / (R * cosLat) / DEG, lat0 + y / R / DEG];
    },
  };
}

export function centroid(ring: LngLat[]): LngLat {
  const pts = closedRingOpen(ring);
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}

/** Drop the closing vertex if the ring is explicitly closed. */
export function closedRingOpen<T extends number[]>(ring: T[]): T[] {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
