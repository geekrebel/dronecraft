import { LngLat, XY, centroid, makeProjection } from './projection';

/** Axis-aligned square of `sideM` metres centred on `center`, corners in order SW, SE, NE, NW. */
export function squareAround(center: LngLat, sideM: number): LngLat[] {
  const p = makeProjection(center);
  const h = sideM / 2;
  return ([
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as XY[]).map((xy) => p.toLngLat(xy));
}

/** A takeoff point `offsetM` south of the polygon's southernmost point, centred east-west on the polygon. */
export function defaultHome(polygon: LngLat[], offsetM = 20): LngLat {
  const c = centroid(polygon);
  const p = makeProjection(c);
  const local = polygon.map((q) => p.toLocal(q));
  const minY = Math.min(...local.map((q) => q[1]));
  return p.toLngLat([0, minY - offsetM]);
}

/** Midpoint of each edge i -> i+1 (wrapping), for "add corner" handles. */
export function edgeMidpoints(polygon: LngLat[]): LngLat[] {
  return polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  });
}

/** Move every vertex by the same offset. */
export function translate(polygon: LngLat[], dLon: number, dLat: number): LngLat[] {
  return polygon.map(([lon, lat]) => [lon + dLon, lat + dLat]);
}

/** Polygon area in square metres (shoelace in a local metric frame). */
export function polygonAreaM2(polygon: LngLat[]): number {
  if (polygon.length < 3) return 0;
  const p = makeProjection(centroid(polygon));
  const l = polygon.map((q) => p.toLocal(q));
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const [x1, y1] = l[i];
    const [x2, y2] = l[(i + 1) % l.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
