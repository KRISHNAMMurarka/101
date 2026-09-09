import { PLACEMENT_LIMITS, type LightSample } from "@101/vision";

/** Shared thresholds: sampling and placement must agree on what needs attention. */
export const LUMA_LIMITS = {
  minLuma: PLACEMENT_LIMITS.minLuma,
  maxBacklight: PLACEMENT_LIMITS.maxBacklight,
} as const;

/** Mean perceptual luma in [0, 1] from RGBA pixels. */
export function meanLuma(imageData: Pick<ImageData, "data">): number {
  const { data } = imageData;
  let sum = 0;
  const count = Math.floor(data.length / 4);
  for (let index = 0; index < count * 4; index += 4) {
    sum += .2126 * data[index]! + .7152 * data[index + 1]! + .0722 * data[index + 2]!;
  }
  return count ? sum / (count * 255) : 0;
}

/** Sample the whole frame and its centre vertical third, where the player is asked to stand. */
export function sampleVideoLuma(video: HTMLVideoElement, canvas: HTMLCanvasElement): LightSample | undefined {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return undefined;
  if (canvas.width !== 32) canvas.width = 32;
  if (canvas.height !== 24) canvas.height = 24;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  try {
    context.drawImage(video, 0, 0, 32, 24);
    return {
      luma: meanLuma(context.getImageData(0, 0, 32, 24)),
      subjectLuma: meanLuma(context.getImageData(11, 0, 10, 24)),
    };
  } catch {
    // A stream can end between the readiness check and the draw. Missing light is not darkness.
    return undefined;
  }
}
