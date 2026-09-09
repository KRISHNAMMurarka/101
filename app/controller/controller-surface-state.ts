export type ControllerSurfaceState = "waiting" | "play";

/**
 * A phone is not a controller until the host has given it an actual panel. Rendering the fallback
 * controls while it is waiting makes inactive buttons look ready and wastes the short landscape
 * viewport before the player has anything to operate.
 */
export function controllerSurfaceState({
  connected,
  assigned,
  controlCount,
}: {
  readonly connected: boolean;
  readonly assigned: boolean;
  readonly controlCount: number;
}): ControllerSurfaceState {
  return connected && assigned && controlCount > 0 ? "play" : "waiting";
}
