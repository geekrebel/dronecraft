/** Fetches and decodes Terrarium elevation tiles in the browser. The service worker caches them for offline use. */
import { TILE_SIZE, TileData, TileKey, decodeTile, keyOf, tileUrl } from './core/terrain';
import { MAX_TERRAIN_TILES, PlanError } from './core/limits';

const cache = new Map<string, TileData>();
const inflight = new Map<string, Promise<TileData>>();

async function decodePng(blob: Blob): Promise<Uint8ClampedArray> {
  // Colour management would alter the encoded heights, so turn it off.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE) : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

async function fetchTile(k: TileKey): Promise<TileData> {
  const res = await fetch(tileUrl(k), { mode: 'cors' });
  if (!res.ok) throw new Error(`Elevation tile ${keyOf(k)}: HTTP ${res.status}`);
  return decodeTile(await decodePng(await res.blob()));
}

export function loadedTiles(): Map<string, TileData> {
  return cache;
}

export function hasTiles(keys: TileKey[]): boolean {
  return keys.every((k) => cache.has(keyOf(k)));
}

/** Load all tiles in `keys`. Resolves when every tile is decoded; rejects if any fails. */
export async function loadTiles(keys: TileKey[]): Promise<void> {
  if (keys.length > MAX_TERRAIN_TILES) throw new PlanError('Too many elevation tiles requested. Split the area or move takeoff closer.');
  await Promise.all(
    keys.map((k) => {
      const id = keyOf(k);
      if (cache.has(id)) return Promise.resolve(cache.get(id)!);
      if (!inflight.has(id)) {
        inflight.set(
          id,
          fetchTile(k)
            .then((t) => {
              cache.set(id, t);
              return t;
            })
            .finally(() => inflight.delete(id)),
        );
      }
      return inflight.get(id)!;
    }),
  );
}
