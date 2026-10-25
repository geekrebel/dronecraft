import { Plan } from './plan';
import { at } from './profile';

const COLORS = ['ff3c8cff', 'ff40c0ff', 'ff50d050', 'ffd07030', 'ffc050e0', 'ff30e0e0'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * KML with all missions. With elevation data, altitudes are absolute (takeoff elevation + planned
 * altitude) so Google Earth shows the path against its own terrain. Without it, they are relative
 * to the ground, which is only right on flat sites.
 */
export function toKml(plan: Plan, name: string): string {
  const { proj, input } = plan;
  const abs = plan.terrain !== null;
  const base = plan.terrain?.homeElevM ?? 0;
  const mode = abs ? 'absolute' : 'relativeToGround';
  const ring = [...input.polygon, input.polygon[0]].map(([lon, lat]) => `${lon},${lat},0`).join(' ');
  const styles = COLORS.map(
    (c, i) => `<Style id="m${i}"><LineStyle><color>${c}</color><width>3</width></LineStyle></Style>`,
  ).join('');
  const c = ([lon, lat]: [number, number], alt: number) => `${lon},${lat},${(base + alt).toFixed(1)}`;
  const placemarks = plan.missions
    .map((m, i) => {
      const pts: string[] = [];
      if (m.itinerary) {
        for (const w of m.itinerary) pts.push(c(proj.toLngLat(w.xy), w.alt));
      } else {
        for (const l of m.lines) {
          const wps = l.wps ?? [
            { t: 0, alt: input.altitudeM },
            { t: 1, alt: input.altitudeM },
          ];
          for (const w of wps) pts.push(c(proj.toLngLat(at(l, w.t)), w.alt));
        }
      }
      return `<Placemark><name>Mission ${m.index}</name><styleUrl>#m${i % COLORS.length}</styleUrl><LineString><altitudeMode>${mode}</altitudeMode><coordinates>${pts.join(' ')}</coordinates></LineString></Placemark>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${styles}
<Placemark><name>Area</name><Style><LineStyle><color>ffffffff</color><width>2</width></LineStyle><PolyStyle><color>33ffffff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Takeoff</name><Point><coordinates>${input.home[0]},${input.home[1]},0</coordinates></Point></Placemark>
${placemarks}</Document></kml>
`;
}

/**
 * Outer ring of the first Polygon in a KML string (Polygon > outerBoundaryIs > LinearRing > coordinates),
 * ignoring Points and LineStrings. Handles namespace prefixes. Works without a DOM.
 */
export function polygonFromKml(kml: string): [number, number][] | null {
  const tag = (name: string) => `<(?:[\\w.-]+:)?${name}\\b[^>]*>`;
  const close = (name: string) => `</(?:[\\w.-]+:)?${name}\\s*>`;
  const poly = new RegExp(`${tag('Polygon')}([\\s\\S]*?)${close('Polygon')}`, 'i').exec(kml);
  if (!poly) return null;
  const outer = new RegExp(`${tag('outerBoundaryIs')}([\\s\\S]*?)${close('outerBoundaryIs')}`, 'i').exec(poly[1]);
  if (!outer) return null;
  const coords = new RegExp(`${tag('coordinates')}([\\s\\S]*?)${close('coordinates')}`, 'i').exec(outer[1]);
  if (!coords) return null;
  const pts = coords[1]
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
