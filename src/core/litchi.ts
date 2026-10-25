import { Mission } from './missions';
import { Projection, XY } from './projection';
import { at } from './profile';

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

function headingDeg(dx: number, dy: number): number {
  // Compass heading: 0 = north, clockwise.
  const h = (Math.atan2(dx, dy) * 180) / Math.PI;
  return Math.round(((h % 360) + 360) % 360);
}

export function missionWaypoints(m: Mission, proj: Projection, s: ExportSettings, home?: XY): LitchiWaypoint[] {
  const wps: LitchiWaypoint[] = [];
  const photo = (on: boolean) => ({
    photoTime: on && s.trigger === 'time' ? s.photoIntervalS : -1,
    photoDist: on && s.trigger === 'distance' ? s.photoSpacingM : -1,
  });
  const first = m.lines[0];
  if (m.climbAltM !== undefined && home && first) {
    // Climb vertically above takeoff before heading out, so the leg to the first line clears the trees.
    const [lon, lat] = proj.toLngLat(home);
    wps.push({
      lat,
      lon,
      alt: m.climbAltM,
      heading: headingDeg(first.start[0] - home[0], first.start[1] - home[1]),
      speed: s.speedMs,
      gimbalPitch: s.gimbalPitch,
      ...photo(false),
    });
  }
  for (const l of m.lines) {
    const h = headingDeg(l.end[0] - l.start[0], l.end[1] - l.start[1]);
    const along = l.wps ?? [
      { t: 0, alt: s.altitudeM },
      { t: 1, alt: s.altitudeM },
    ];
    along.forEach((w, i) => {
      const [lon, lat] = proj.toLngLat(at(l, w.t));
      // Photos run on every segment from the line start to the line end; none on the turn after it.
      wps.push({ lat, lon, alt: w.alt, heading: h, speed: s.speedMs, gimbalPitch: s.gimbalPitch, ...photo(i < along.length - 1) });
    });
  }
  return wps;
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
