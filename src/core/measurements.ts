import type { LngLat } from './projection';

export interface MeasurementSettings {
  obstacleFloorM: number;
  formationM: number;
  obstacleMeasuredFor: string;
  formationMeasuredFor: string;
}

/** Exact geometry: moving even one corner or takeoff invalidates the relevant measurement. */
export function measurementKeys(polygon: LngLat[], home: LngLat | null) {
  return {
    obstacleMeasuredFor: JSON.stringify([polygon, home]),
    formationMeasuredFor: JSON.stringify(polygon),
  };
}

export function staleMeasurements(settings: MeasurementSettings, polygon: LngLat[], home: LngLat | null): string[] {
  const keys = measurementKeys(polygon, home);
  const stale: string[] = [];
  if (settings.obstacleFloorM > 0 && settings.obstacleMeasuredFor !== keys.obstacleMeasuredFor) stale.push('Highest obstacle above takeoff');
  if (settings.formationM > 0 && settings.formationMeasuredFor !== keys.formationMeasuredFor) stale.push('Rock formation height');
  return stale;
}
