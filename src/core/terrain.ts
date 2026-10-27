/**
 * Elevation from Terrarium-encoded terrain tiles (AWS Terrain Tiles, Mapzen/Tilezen).
 * Pure functions plus a sampler over decoded tiles; fetching lives in the app.
 */
import type { LngLat } from './projection';
import { MAX_TERRAIN_TILES, PlanError } from './limits';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TILE_SIZE = 256;
export const TERRAIN_ZOOM = 14;

/** Elevation in metres from a Terrarium RGB pixel. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Inverse of decodeTerrarium, used to build test tiles. */
export function encodeTerrarium(h: number): [number, number, number] {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - r * 256 - g) * 256);
  return [r, g, Math.min(255, b)];
}

/** Global pixel coordinates (fractional) of a point in Web Mercator at zoom z. */
export function globalPixel([lon, lat]: LngLat, z: number): [number, number] {
  const n = TILE_SIZE * 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

export interface TileKey {
  z: number;
  x: number;
  y: number;
}
export const keyOf = (t: TileKey) => `${t.z}/${t.x}/${t.y}`;
export const tileUrl = (t: TileKey) =>
  TERRARIUM_URL.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));

/** All tiles needed to sample every point inside the bounding box of `points`, plus one pixel of margin. */
export function tilesFor(points: LngLat[], z = TERRAIN_ZOOM): TileKey[] {
  if (!Number.isInteger(z) || z < 0 || z > 22) throw new PlanError('The elevation zoom level is invalid.');
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    if (!p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) >= 85.05112878)
      throw new PlanError('This area is outside the supported elevation map. Choose a site between 85° south and 85° north.');
    const [x, y] = globalPixel(p, z);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const out: TileKey[] = [];
  if (!points.length) return out;
  const max = 2 ** z - 1;
  const tx0 = Math.max(0, Math.floor((x0 - 1) / TILE_SIZE));
  const tx1 = Math.min(max, Math.floor((x1 + 1) / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor((y0 - 1) / TILE_SIZE));
  const ty1 = Math.min(max, Math.floor((y1 + 1) / TILE_SIZE));
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_TERRAIN_TILES)
    throw new PlanError('This needs too many elevation tiles. Split the area or move takeoff closer.');
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) out.push({ z, x, y });
  return out;
}

/** Decoded tile: elevation per pixel, row-major. */
export type TileData = Float32Array;

export function decodeTile(rgba: Uint8ClampedArray | Uint8Array): TileData {
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = decodeTerrarium(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  return out;
}

export interface Terrain {
  /** Ground elevation in metres, or null where no tile is loaded. */
  elevation(p: LngLat): number | null;
  source: string;
}

/** Bilinear sampler across loaded tiles at one zoom level. Pixel centres sit at +0.5. */
export class TileTerrain implements Terrain {
  constructor(
    private tiles: Map<string, TileData>,
    private z = TERRAIN_ZOOM,
    public source = 'SRTM 30 m via AWS Terrain Tiles',
  ) {}

  private px(gx: number, gy: number): number | null {
    const tx = Math.floor(gx / TILE_SIZE);
    const ty = Math.floor(gy / TILE_SIZE);
    const t = this.tiles.get(`${this.z}/${tx}/${ty}`);
    if (!t) return null;
    return t[(gy - ty * TILE_SIZE) * TILE_SIZE + (gx - tx * TILE_SIZE)];
  }

  elevation(p: LngLat): number | null {
    const [gx, gy] = globalPixel(p, this.z);
    const fx = gx - 0.5;
    const fy = gy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const dx = fx - x0;
    const dy = fy - y0;
    const a = this.px(x0, y0);
    const b = this.px(x0 + 1, y0);
    const c = this.px(x0, y0 + 1);
    const d = this.px(x0 + 1, y0 + 1);
    if (a === null || b === null || c === null || d === null) return null;
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
  }
}

/** Analytic terrain for tests and demos. */
export class FunctionTerrain implements Terrain {
  constructor(
    private f: (p: LngLat) => number,
    public source = 'test surface',
  ) {}
  elevation(p: LngLat) {
    return this.f(p);
  }
}
