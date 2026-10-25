/**
 * DroneCraft plan file: JSON holding one or more plans, for backup and moving plans between devices.
 * Import is defensive: anything malformed is skipped with a reason, never thrown.
 */
import type { PlanDoc } from './store';

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
    } else if (typeof v === typeof defaults[k] && (typeof v !== 'number' || Number.isFinite(v))) {
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
    if (!Array.isArray(p?.polygon) || p.polygon.length < 3 || !p.polygon.every(isLngLat)) {
      skipped.push(`${label}: area is missing or has invalid coordinates.`);
      return;
    }
    plans.push({
      name: label,
      polygon: p.polygon.map((q: number[]) => [q[0], q[1]] as [number, number]),
      home: isLngLat(p.home) ? [p.home[0], p.home[1]] : null,
      settings: sanitizeSettings(p.settings, defaults),
    });
  });
  return { plans, skipped };
}
