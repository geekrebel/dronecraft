import { Plan } from './plan';

const COLORS = ['ff3c8cff', 'ff40c0ff', 'ff50d050', 'ffd07030', 'ffc050e0', 'ff30e0e0'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * KML with all missions. Altitudes are relativeToGround using the planned height,
 * which is accurate only when terrain is flat; it is meant for visual review.
 */
export function toKml(plan: Plan, name: string): string {
  const { proj, input } = plan;
  const ring = [...input.polygon, input.polygon[0]].map(([lon, lat]) => `${lon},${lat},0`).join(' ');
  const styles = COLORS.map(
    (c, i) => `<Style id="m${i}"><LineStyle><color>${c}</color><width>3</width></LineStyle></Style>`,
  ).join('');
  const placemarks = plan.missions
    .map((m, i) => {
      const coords = [input.home, ...m.lines.flatMap((l) => [proj.toLngLat(l.start), proj.toLngLat(l.end)]), input.home]
        .map(([lon, lat], j, arr) => `${lon},${lat},${j === 0 || j === arr.length - 1 ? 0 : input.altitudeM}`)
        .join(' ');
      return `<Placemark><name>Mission ${m.index}</name><styleUrl>#m${i % COLORS.length}</styleUrl><LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${styles}
<Placemark><name>Area</name><Style><LineStyle><color>ffffffff</color><width>2</width></LineStyle><PolyStyle><color>33ffffff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Takeoff</name><Point><coordinates>${input.home[0]},${input.home[1]},0</coordinates></Point></Placemark>
${placemarks}</Document></kml>
`;
}

/** Parse the first polygon from a KML string. Works without a DOM. */
export function polygonFromKml(kml: string): [number, number][] | null {
  const m = kml.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) return null;
  const pts = m[1]
    .trim()
    .split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((p) => p.length >= 2 && p.every((v) => Number.isFinite(v)))
    .map((p) => [p[0], p[1]] as [number, number]);
  return pts.length >= 3 ? pts : null;
}

/** Parse the first Polygon from GeoJSON (Feature, FeatureCollection or geometry). */
export function polygonFromGeoJson(text: string): [number, number][] | null {
  const g = JSON.parse(text);
  const find = (o: any): any => {
    if (!o) return null;
    if (o.type === 'Polygon') return o.coordinates[0];
    if (o.type === 'MultiPolygon') return o.coordinates[0][0];
    if (o.type === 'Feature') return find(o.geometry);
    if (o.type === 'FeatureCollection') {
      for (const f of o.features) {
        const r = find(f);
        if (r) return r;
      }
    }
    return null;
  };
  const ring = find(g);
  return ring ? ring.map((p: number[]) => [p[0], p[1]] as [number, number]) : null;
}
