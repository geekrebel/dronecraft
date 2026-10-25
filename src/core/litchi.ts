import { Mission } from './missions';
import { Projection, XY } from './projection';
import { ItinWp, buildItinerary } from './itinerary';

export const LITCHI_HEADER = [
  'latitude',
  'longitude',
  'altitude(m)',
  'heading(deg)',
  'curvesize(m)',
  'rotationdir',
  'gimbalmode',
  'gimbalpitchangle',
  ...Array.from({ length: 15 }, (_, i) => [`actiontype${i + 1}`, `actionparam${i + 1}`]).flat(),
  'altitudemode',
  'speed(m/s)',
  'poi_latitude',
  'poi_longitude',
  'poi_altitude(m)',
  'poi_altitudemode',
  'photo_timeinterval',
  'photo_distinterval',
];

export interface ExportSettings {
  altitudeM: number; // above takeoff
  speedMs: number;
  gimbalPitch: number;
  trigger: 'distance' | 'time';
  photoSpacingM: number;
  photoIntervalS: number;
}

export interface LitchiWaypoint {
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  speed: number;
  gimbalPitch: number;
  photoTime: number;
  photoDist: number;
}

/**
 * Litchi waypoints for a mission, taken from its exported itinerary.
 * Photo legs carry the interval; other legs carry -1, which in Litchi means "use the mission setting",
 * so the mission-level photo interval must be left off in Litchi (see the export instructions).
 */
export function missionWaypoints(m: Mission, proj: Projection, s: ExportSettings, home?: XY): LitchiWaypoint[] {
  const it: ItinWp[] =
    m.itinerary ??
    buildItinerary(
      m.lines.map((l) => ({ ...l, wps: l.wps ?? [{ t: 0, alt: s.altitudeM }, { t: 1, alt: s.altitudeM }] })),
      home ?? m.lines[0]?.start ?? [0, 0],
      { speedMs: s.speedMs, transitSpeedMs: s.speedMs, climbAltM: m.climbAltM ?? s.altitudeM },
    ).filter((w) => home !== undefined || w.kind !== 'climb');
  return it.map((w) => {
    const [lon, lat] = proj.toLngLat(w.xy);
    return {
      lat,
      lon,
      alt: w.alt,
      heading: w.heading,
      speed: w.speed,
      gimbalPitch: s.gimbalPitch,
      photoTime: w.photo && s.trigger === 'time' ? s.photoIntervalS : -1,
      photoDist: w.photo && s.trigger === 'distance' ? s.photoSpacingM : -1,
    };
  });
}

const r = (v: number, d: number) => Number(v.toFixed(d));

export function toLitchiCsv(wps: LitchiWaypoint[]): string {
  const rows = [LITCHI_HEADER.join(',')];
  for (const w of wps) {
    const actions = Array.from({ length: 15 }, () => ['-1', '0']).flat();
    rows.push(
      [
        r(w.lat, 8),
        r(w.lon, 8),
        r(w.alt, 1),
        w.heading,
        0.2, // non-zero: Litchi never writes 0 and some importers reject it
        0,
        2, // gimbal mode: interpolate
        r(w.gimbalPitch, 0),
        ...actions,
        0, // altitude mode: relative to takeoff
        r(w.speed, 1),
        0,
        0,
        0,
        0,
        r(w.photoTime, 1),
        r(w.photoDist, 1),
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

/** Parse a Litchi CSV back into waypoints. Used for round-trip verification. */
export function parseLitchiCsv(csv: string): LitchiWaypoint[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name}`);
    return i;
  };
  const c = {
    lat: idx('latitude'),
    lon: idx('longitude'),
    alt: idx('altitude(m)'),
    heading: idx('heading(deg)'),
    speed: idx('speed(m/s)'),
    pitch: idx('gimbalpitchangle'),
    pt: idx('photo_timeinterval'),
    pd: idx('photo_distinterval'),
  };
  return lines.slice(1).map((line) => {
    const f = line.split(',').map(Number);
    if (f.length !== header.length) throw new Error(`row has ${f.length} fields, expected ${header.length}`);
    return {
      lat: f[c.lat],
      lon: f[c.lon],
      alt: f[c.alt],
      heading: f[c.heading],
      speed: f[c.speed],
      gimbalPitch: f[c.pitch],
      photoTime: f[c.pt],
      photoDist: f[c.pd],
    };
  });
}
