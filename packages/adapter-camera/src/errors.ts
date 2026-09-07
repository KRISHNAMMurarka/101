/**
 * Why the camera did not start, in words a player can act on.
 *
 * Every surface that opens a camera used to hand-roll the same check —
 * `cause.name === "NotAllowedError" || cause.name === "SecurityError"` — write one sentence for
 * that case, and fall through to `cause.message` for everything else. So a denied permission read
 * well and every other failure reached the player as raw browser English: "Requested device not
 * found", "Could not start video source". Those are accurate and they are not instructions. A
 * player who reads "NotReadableError" does not know that the answer is usually to quit a video
 * call.
 *
 * The mapping lives here, once, because the walkthrough and the games must say the same thing: the
 * language the setup teaches has to be the language the game keeps.
 */

export type CameraFailure =
  | "denied"
  | "no-camera"
  | "in-use"
  | "unsupported"
  | "insecure-context"
  | "model-failed"
  | "unknown";

export const CAMERA_FAILURE_COPY: Readonly<Record<CameraFailure, { readonly problem: string; readonly fix: string }>> = {
  denied: {
    problem: "The browser didn't give us the camera.",
    fix: "Look for the camera icon in the address bar and allow it, then try again.",
  },
  "no-camera": {
    problem: "We couldn't find a camera on this device.",
    fix: "Plug one in, or play with the keyboard.",
  },
  "in-use": {
    problem: "Another app is using the camera.",
    fix: "Close it — a video call, usually — then try again.",
  },
  unsupported: {
    problem: "This browser can't open a camera.",
    fix: "Try a different browser, or play with the keyboard.",
  },
  "insecure-context": {
    problem: "The camera only works on a secure connection.",
    fix: "Open this page over https, then try again.",
  },
  "model-failed": {
    problem: "We couldn't finish setting up the camera.",
    fix: "Check your connection and try again.",
  },
  unknown: {
    problem: "The camera didn't start.",
    fix: "Try again, or play with the keyboard.",
  },
};

/**
 * Thrown when a camera that was working stops.
 *
 * A revoked permission, a closed laptop lid and an unplugged webcam all end the track rather than
 * failing a call, so without this they are indistinguishable from a person who has walked out of
 * shot — the picture simply stops changing and the check waits forever for someone who cannot come
 * back.
 */
export class CameraLostError extends Error {
  readonly failure: CameraFailure = "unknown";

  constructor(message = "The camera stopped") {
    super(message);
    this.name = "CameraLostError";
  }
}

/** Which failure this is, from whatever the browser threw. */
export function classifyCameraFailure(cause: unknown): CameraFailure {
  if (cause instanceof CameraLostError) return "in-use";
  if (cause instanceof DOMException || (cause instanceof Error && cause.name)) {
    switch (cause.name) {
      // SecurityError is a denial in every browser that still emits it.
      case "NotAllowedError":
      case "SecurityError":
        return "denied";
      case "NotFoundError":
      case "OverconstrainedError":
      case "DevicesNotFoundError":
        return "no-camera";
      // AbortError is the camera being taken away mid-open, which in practice is another app.
      case "NotReadableError":
      case "TrackStartError":
      case "AbortError":
        return "in-use";
      case "TypeError":
        // getUserMedia is undefined off a secure origin, and calling it throws a TypeError rather
        // than a DOMException — which is why this case does not look like the others.
        return "insecure-context";
      default:
        break;
    }
  }
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/unavailable in this browser|not supported/i.test(text)) return "unsupported";
  if (/secure|https/i.test(text)) return "insecure-context";
  if (/model|wasm|fileset|landmarker|fetch/i.test(text)) return "model-failed";
  return "unknown";
}

/** What to tell the player, from whatever the browser threw. */
export function describeCameraFailure(cause: unknown): { failure: CameraFailure; problem: string; fix: string } {
  const failure = classifyCameraFailure(cause);
  return { failure, ...CAMERA_FAILURE_COPY[failure] };
}
