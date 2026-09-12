/**
 * Waiting for a camera to actually produce a picture, with an end to the waiting.
 *
 * `video.play()` on a live MediaStream returns a promise that resolves when playback starts — and
 * if frames never arrive, it simply never settles. There is no error, no rejection and no event: the
 * await sits there for the life of the page. Observed on a real camera that granted a track and then
 * delivered nothing, where `videoWidth` stayed 0 and `play()` was still pending after eight seconds.
 *
 * A camera held by another application behaves this way, and so does one a privacy setting has
 * blacked out. From the player's side the difference does not matter: the setup says it is starting
 * the camera and then says it forever. An unbounded await is how a product ends up with a spinner
 * that has no failure case.
 *
 * So the wait is bounded, and a camera that has not produced a frame in time is reported as a
 * camera in use — which is both the most common cause and the one with an action attached: close
 * whatever else is looking through it.
 */

/** How long a camera may hold a track open without producing a frame before it counts as failed. */
export const FIRST_FRAME_TIMEOUT_MS = 6_000;

export interface AcquireOptions {
  timeoutMs?: number;
  /** Injected so a test can run this without a real clock. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A video element far enough along to read frames from. */
export function hasPicture(video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">) {
  return video.videoWidth > 0 && video.videoHeight > 0;
}

/**
 * Start playback and wait for the first real frame, or give up.
 *
 * Resolving on `play()` alone is not enough: it can resolve while `videoWidth` is still 0, and the
 * inference backend then initializes against a picture that has no size. Both conditions have to
 * hold before a caller can trust the element.
 */
export async function acquireFirstFrame(
  video: HTMLVideoElement,
  options: AcquireOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? FIRST_FRAME_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  if (hasPicture(video)) {
    // Already running: nothing to wait for, and nothing to tear down.
    void video.play().catch(() => undefined);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("resize", check);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (hasPicture(video)) finish(); };

    const timer = setTimer(() => {
      // Deliberately the same failure a busy camera raises, because that is what it almost always
      // is, and it is the one the player can do something about.
      const error = new DOMException("The camera did not produce a picture", "NotReadableError");
      finish(error);
    }, timeoutMs);

    video.addEventListener("loadeddata", check);
    video.addEventListener("resize", check);
    // `play()` rejecting is a real failure worth surfacing now rather than waiting for the timeout;
    // it resolving proves nothing, so it is not what the wait is keyed on.
    void video.play().then(check, (cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
    check();
  });
}
