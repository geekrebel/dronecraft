import { describe, expect, it } from 'vitest';
import {
  TILE_SIZE,
  TileTerrain,
  decodeTerrarium,
  decodeTile,
  encodeTerrarium,
  globalPixel,
  keyOf,
  tileUrl,
  tilesFor,
} from './terrain';
import type { LngLat } from './projection';

describe('terrarium encoding', () => {
  it('decodes known values', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 128)).toBe(100.5);
    expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
  });
  it('encode/decode round trips to 1/256 m', () => {
    for (const h of [-50, 0, 12.25, 734.6, 3805.1]) {
      const [r, g, b] = encodeTerrarium(h);
      expect(Math.abs(decodeTerrarium(r, g, b) - h)).toBeLessThan(1 / 256 + 1e-9);
    }
  });
});

describe('tile math', () => {
  it('lon 0 lat 0 is the centre of the world', () => {
    const [x, y] = globalPixel([0, 0], 1);
    expect(x).toBeCloseTo(256, 9);
    expect(y).toBeCloseTo(256, 9);
  });
  it('tile URL template', () => {
    expect(tileUrl({ z: 14, x: 12657, y: 8030 })).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/12657/8030.png');
  });
  it('a small area near Bukit Lawang needs 1 to 4 tiles at z14', () => {
    const t = tilesFor([
      [98.118, 3.548],
      [98.122, 3.552],
    ]);
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(t.length).toBeLessThanOrEqual(4);
    expect(t.every((k) => k.z === 14)).toBe(true);
  });
});

/** Build tiles from an analytic function of global pixel coords. */
function synthTiles(points: LngLat[], z: number, f: (gx: number, gy: number) => number) {
  const tiles = new Map<string, Float32Array>();
  for (const k of tilesFor(points, z)) {
    const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    for (let py = 0; py < TILE_SIZE; py++)
      for (let px = 0; px < TILE_SIZE; px++) {
        const [r, g, b] = encodeTerrarium(f(k.x * TILE_SIZE + px + 0.5, k.y * TILE_SIZE + py + 0.5));
        const i = (py * TILE_SIZE + px) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    tiles.set(keyOf(k), decodeTile(rgba));
  }
  return tiles;
}

describe('tile sampler', () => {
  const area: LngLat[] = [
    [98.11, 3.54],
    [98.13, 3.56],
  ];
  it('reproduces a planar surface exactly, including across tile edges', () => {
    const f = (gx: number, gy: number) => 100 + 0.02 * gx - 0.01 * gy - 0.02 * 3_240_000 + 0.01 * 2_055_000;
    const terr = new TileTerrain(synthTiles(area, 14, f), 14);
    for (let i = 0; i <= 20; i++) {
      const p: LngLat = [98.11 + 0.001 * i, 3.54 + 0.001 * i];
      const [gx, gy] = globalPixel(p, 14);
      expect(terr.elevation(p)!).toBeCloseTo(f(gx, gy), 1);
    }
  });
  it('returns null outside loaded tiles', () => {
    const terr = new TileTerrain(synthTiles(area, 14, () => 50), 14);
    expect(terr.elevation([99.5, 3.55])).toBeNull();
    expect(terr.elevation([98.12, 3.55])).toBeCloseTo(50, 2);
  });
});
