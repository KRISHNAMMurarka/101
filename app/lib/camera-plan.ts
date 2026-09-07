/**
 * What the chooser learned about the camera, handed to the game that starts next.
 *
 * The chooser and the running game are two URLs, deliberately — so nothing live survives the
 * journey. The MediaStream ends, the landmarker is torn down, and the only thing that can cross is
 * a few fields of plain JSON. This is that.
 *
 * It is not in the URL. A camera's deviceId is a stable identifier for a piece of the player's
 * hardware, and a URL is the one part of a page that gets copied into chat windows, pasted into
 * bug reports and written to server logs. The address carries `camera=body` and nothing else; the
 * identifier stays in this tab's own storage.
 *
 * Nothing here is trusted on the way back in. Storage is editable, survives deploys, and outlives
 * the code that wrote it, so a payload that does not match is dropped whole rather than half
 * applied — a plan with a valid deviceId and a corrupted mirror flag would put the player in front
 * of a camera that reverses their movements, which is worse than asking them again.
 */

export type CameraKind = "body" | "hands";

export interface CameraPlan {
  readonly kind: CameraKind;
  /** Which camera, when the player has more than one. Absent means whichever the browser picks. */
  readonly deviceId?: string;
  /** Whether the picture is flipped. True for a camera facing the player, which is nearly always. */
  readonly mirror: boolean;
  /** The pose model the check settled on, so the game does not resolve a different one. */
  readonly poseModel?: string;
}

/**
 * Bumped when the shape changes. A stored plan from an older shape is discarded rather than
 * migrated: this costs a player one walkthrough they have done before, and the alternative is
 * guessing at fields that were never written.
 */
const PLAN_VERSION = 1;

const KEY = (sessionId: string) => `101.camera-plan.${sessionId}`;

export function encodeCameraPlan(plan: CameraPlan): string {
  return JSON.stringify({ v: PLAN_VERSION, ...plan });
}

/** Parse a stored plan, or undefined if it is anything other than one this build wrote. */
export function decodeCameraPlan(raw: string | null | undefined): CameraPlan | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.v !== PLAN_VERSION) return undefined;
  if (record.kind !== "body" && record.kind !== "hands") return undefined;
  if (typeof record.mirror !== "boolean") return undefined;
  if (record.deviceId !== undefined && typeof record.deviceId !== "string") return undefined;
  if (record.poseModel !== undefined && typeof record.poseModel !== "string") return undefined;

  return {
    kind: record.kind,
    mirror: record.mirror,
    ...(record.deviceId ? { deviceId: record.deviceId } : {}),
    ...(record.poseModel ? { poseModel: record.poseModel } : {}),
  };
}

/*
 * Every touch of storage is wrapped. A private window, a browser set to block site data and an
 * embedded webview all throw on access rather than returning empty, and a walkthrough that throws
 * while saving what it just learned would lose the player the setup they completed. Failing to
 * remember is the ordinary path, not an error.
 */

export function saveCameraPlan(sessionId: string, plan: CameraPlan) {
  try {
    sessionStorage.setItem(KEY(sessionId), encodeCameraPlan(plan));
  } catch {
    // The game asks again. That is the same experience as never having set it up.
  }
}

export function readCameraPlan(sessionId: string): CameraPlan | undefined {
  try {
    return decodeCameraPlan(sessionStorage.getItem(KEY(sessionId)));
  } catch {
    return undefined;
  }
}

export function clearCameraPlan(sessionId: string) {
  try {
    sessionStorage.removeItem(KEY(sessionId));
  } catch {
    // Nothing to do: an unreadable store is also one nothing can be recovered from.
  }
}
