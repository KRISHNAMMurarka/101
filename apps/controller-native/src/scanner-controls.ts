export function pinchDistance(touches: readonly { pageX: number; pageY: number }[]): number | undefined {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) return undefined;
  return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
}

/** Expo CameraView zoom is a fraction of each device's own maximum zoom. */
export function zoomFromPinch(startZoom: number, startDistance: number, distance: number): number {
  const adjusted = startZoom + (distance - startDistance) / 300;
  return Math.min(1, Math.max(0, Math.round(adjusted * 1000) / 1000));
}
