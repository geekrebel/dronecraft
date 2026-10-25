/**
 * DroneCraft plan file: JSON holding one or more plans, for backup and moving plans between devices.
 * Import is defensive: anything malformed is skipped with a reason, never thrown.
 */
import type { PlanDoc } from './store';
import { DEFAULT_INPUT, MAX_AREA_HA, PlanError, SETTING_RANGES, buildPlan } from './plan';
import { polygonAreaM2 } from './shapes';

export const FORMAT = 'dronecraft-plans';
export const VERSION = 1;

export type ImportedPlan<S> = Omit<PlanDoc<S>, 'id' | 'updatedAt'>;

export function serializePlans<S>(plans: PlanDoc<S>[], now = new Date()): string {
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      exportedAt: now.toISOString(),
      plans: plans.map((p) => ({ name: p.name, polygon: p.polygon, home: p.home, settings: p.settings, updatedAt: p.updatedAt })),
    },
    null,
    1,
  );
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLngLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;

/**
 * Keep only settings keys that exist in `defaults` and have a compatible value; fill the rest from defaults.
 * Enumerated fields are checked against their allowed values.
 */
export function sanitizeSettings<S extends Record<string, unknown>>(raw: unknown, defaults: S): S {
  const out: Record<string, unknown> = { ...defaults };
  if (!raw || typeof raw !== 'object') return out as S;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(defaults)) {
    const v = r[k];
    if (v === undefined) continue;
    if (k === 'gridAngleDeg') {
      if (v === 'auto' || isNum(v)) out[k] = v;
    } else if (k === 'trigger') {
      if (v === 'distance' || v === 'time') out[k] = v;
    } else if (typeof v === 'number' && typeof defaults[k] === 'number') {
      const range = SETTING_RANGES[k];
      // Out-of-range numbers fall back to the default rather than being trusted.
      if (Number.isFinite(v) && (!range || (v >= range[0] && v <= range[1]))) out[k] = v;
    } else if (typeof v === typeof defaults[k] && typeof v !== 'number') {
      out[k] = v;
    }
  }
  return out as S;
}

export function parsePlansFile<S extends Record<string, unknown>>(
  text: string,
  defaults: S,
): { plans: ImportedPlan<S>[]; skipped: string[] } {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { plans: [], skipped: ['File is not valid JSON.'] };
  }
  if (!data || data.format !== FORMAT || !Array.isArray(data.plans)) {
    return { plans: [], skipped: ['Not a DroneCraft plan file.'] };
  }
  if (isNum(data.version) && data.version > VERSION) {
    return { plans: [], skipped: [`File is from a newer version of DroneCraft (format ${data.version}). Update the app first.`] };
  }
  const plans: ImportedPlan<S>[] = [];
  const skipped: string[] = [];
  data.plans.forEach((p: any, i: number) => {
    const label = typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : `Plan ${i + 1}`;
    if (!Array.isArray(p?.polygon) || p.polygon.length < 3 || p.polygon.length > 500 || !p.polygon.every(isLngLat)) {
      skipped.push(`${label}: area is missing or has invalid coordinates.`);
      return;
    }
    const polygon = p.polygon.map((q: number[]) => [q[0], q[1]] as [number, number]);
    const reason = areaProblem(polygon);
    if (reason) {
      skipped.push(`${label}: ${reason}`);
      return;
    }
    const settings = sanitizeSettings(p.settings, defaults);
    const home = isLngLat(p.home) ? ([p.home[0], p.home[1]] as [number, number]) : null;
    // Plan it once before accepting it, so nothing that would crash the planner gets stored.
    if (home) {
      try {
        buildPlan({ ...DEFAULT_INPUT, ...(settings as object), polygon, home } as Parameters<typeof buildPlan>[0]);
      } catch (e) {
        skipped.push(`${label}: ${e instanceof PlanError ? e.message : 'could not be planned.'}`);
        return;
      }
    }
    plans.push({ name: label, polygon, home, settings });
  });
  return { plans, skipped };
}

/** Reason an area cannot be planned, or null if it is acceptable. Shared by plan-file and boundary imports. */
export function areaProblem(polygon: [number, number][]): string | null {
  if (polygon.length < 3) return 'area needs at least 3 corners.';
  if (!polygon.every(isLngLat)) return 'area has invalid coordinates.';
  const ha = polygonAreaM2(polygon) / 10000;
  if (ha < 0.01) return 'area is too small or its corners are in a line.';
  if (ha > MAX_AREA_HA) return `area is ${ha.toFixed(0)} ha; the limit is ${MAX_AREA_HA} ha.`;
  return null;
}
