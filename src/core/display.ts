import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { Line, lineLength } from './grid';
import { Plan } from './plan';
import { LngLat, XY } from './projection';

export interface DisplayGeometry {
  /** Mapping lines, where photos are taken. */
  lines: FeatureCollection<LineString>;
  /** Turns between consecutive lines. */
  turns: FeatureCollection<LineString>;
  /** Takeoff to first waypoint and last waypoint back to takeoff. */
  transit: FeatureCollection<LineString>;
  /** Chevrons showing direction of travel. */
  arrows: FeatureCollection<LineString>;
  /** Approximate photo trigger positions. */
  photos: FeatureCollection<Point>;
  /** First waypoint of each mission, for numbered markers. */
  starts: { mission: number; at: LngLat; color: string }[];
}

const fc = <G extends LineString | Point>(features: Feature<G>[]): FeatureCollection<G> => ({
  type: 'FeatureCollection',
  features,
});

/** A small V-shaped chevron centred on `at`, pointing along unit vector (ux, uy). */
function chevron(at: XY, ux: number, uy: number, size: number): XY[] {
  const back = size;
  const wing = size * 0.7;
  const tip: XY = [at[0] + ux * size * 0.5, at[1] + uy * size * 0.5];
  const bx = at[0] - ux * back * 0.5;
  const by = at[1] - uy * back * 0.5;
  return [
    [bx - uy * wing, by + ux * wing],
    tip,
    [bx + uy * wing, by - ux * wing],
  ];
}

/**
 * Turn a plan into map geometry. `colors` is cycled per mission.
 * Arrow size and spacing scale with line spacing so they stay readable at the plan's scale.
 */
export function displayGeometry(plan: Plan, home: LngLat, colors: string[], maxPhotos = 5000): DisplayGeometry {
  const { proj } = plan;
  const ll = (p: XY) => proj.toLngLat(p);
  const lines: Feature<LineString>[] = [];
  const turns: Feature<LineString>[] = [];
  const transit: Feature<LineString>[] = [];
  const arrows: Feature<LineString>[] = [];
  const photos: Feature<Point>[] = [];
  const starts: DisplayGeometry['starts'] = [];

  const arrowSize = Math.max(6, Math.min(40, plan.lineSpacingM * 0.5));
  const arrowEvery = Math.max(arrowSize * 6, 120);
  const photoStep = plan.photoSpacingM;
  const totalPhotos = plan.missions.reduce((n, m) => n + m.lines.reduce((k, l) => k + lineLength(l) / photoStep, 0), 0);
  const showPhotos = totalPhotos <= maxPhotos;

  plan.missions.forEach((m, mi) => {
    const color = colors[mi % colors.length];
    const props = { mission: m.index, color };
    const ls: Line[] = m.lines;
    if (!ls.length) return;

    starts.push({ mission: m.index, at: ll(ls[0].start), color });
    transit.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [home, ll(ls[0].start)] } });
    transit.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'LineString', coordinates: [ll(ls[ls.length - 1].end), home] },
    });

    ls.forEach((l, i) => {
      lines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [ll(l.start), ll(l.end)] } });
      if (i > 0) {
        turns.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: [ll(ls[i - 1].end), ll(l.start)] },
        });
      }
      const len = lineLength(l);
      if (len < 1e-6) return;
      const ux = (l.end[0] - l.start[0]) / len;
      const uy = (l.end[1] - l.start[1]) / len;
      // At least one arrow per line, centred; more on long lines.
      const n = Math.max(1, Math.floor(len / arrowEvery));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const at: XY = [l.start[0] + (l.end[0] - l.start[0]) * t, l.start[1] + (l.end[1] - l.start[1]) * t];
        arrows.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: chevron(at, ux, uy, arrowSize).map(ll) },
        });
      }
      if (showPhotos) {
        for (let d = 0; d <= len + 1e-6; d += photoStep) {
          photos.push({
            type: 'Feature',
            properties: props,
            geometry: { type: 'Point', coordinates: ll([l.start[0] + ux * d, l.start[1] + uy * d]) },
          });
        }
      }
    });
  });

  return { lines: fc(lines), turns: fc(turns), transit: fc(transit), arrows: fc(arrows), photos: fc(photos), starts };
}
