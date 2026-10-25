export interface Camera {
  name: string;
  sensorWidthMm: number;
  sensorHeightMm: number;
  focalLengthMm: number;
  imageWidthPx: number;
  imageHeightPx: number;
  minIntervalS: number;
}

export const AIR_2S: Camera = {
  name: 'DJI Air 2S',
  sensorWidthMm: 13.2,
  sensorHeightMm: 8.8,
  focalLengthMm: 8.38,
  imageWidthPx: 5472,
  imageHeightPx: 3648,
  minIntervalS: 2,
};

/** Ground sample distance in metres per pixel at a given height above the surface. */
export function gsd(cam: Camera, heightM: number): number {
  return (cam.sensorWidthMm * heightM) / (cam.focalLengthMm * cam.imageWidthPx);
}

/**
 * Ground footprint in metres. The long side of the sensor is mounted across track,
 * so `across` uses the sensor width and `along` uses the sensor height.
 */
export function footprint(cam: Camera, heightM: number): { across: number; along: number } {
  return {
    across: (cam.sensorWidthMm * heightM) / cam.focalLengthMm,
    along: (cam.sensorHeightMm * heightM) / cam.focalLengthMm,
  };
}

export function lineSpacing(cam: Camera, heightM: number, sideOverlap: number): number {
  return footprint(cam, heightM).across * (1 - sideOverlap);
}

export function photoSpacing(cam: Camera, heightM: number, frontOverlap: number): number {
  return footprint(cam, heightM).along * (1 - frontOverlap);
}

/** Forward overlap actually achieved for a given photo spacing. */
export function overlapForSpacing(cam: Camera, heightM: number, spacingM: number): number {
  return 1 - spacingM / footprint(cam, heightM).along;
}
