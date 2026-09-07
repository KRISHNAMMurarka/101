import { HAND_CONNECTIONS, HAND_LANDMARK, POSE_CONNECTIONS, type HandLandmark, type PoseLandmark } from "./index.ts";

/**
 * Drawing a body over the picture it was found in.
 *
 * The part that is easy to get wrong, and was: a preview shows the camera with `object-fit: cover`,
 * which crops the stream to the box rather than letterboxing it, while the canvas over it is sized
 * to the box exactly. Landmarks are fractions of the STREAM. Multiplying them by the BOX puts the
 * skeleton somewhere the body is not, by a margin that grows with the difference between the two
 * aspect ratios — a 4:3 camera in a 16:9 frame is out by an eighth of the height, which is a whole
 * head. The overlay looked plausible on a laptop, where the two are close, and visibly wrong on
 * anything else.
 */

export interface CoverBox {
  /** Intrinsic size of the stream, from the video element's videoWidth/videoHeight. */
  readonly streamWidth: number;
  readonly streamHeight: number;
  /** Size of the box it is being displayed in, in CSS pixels. */
  readonly boxWidth: number;
  readonly boxHeight: number;
  /** Whether the picture is flipped, as a preview of yourself always is. */
  readonly mirrored?: boolean;
}

export interface CoverTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** A landmark's normalized position, in box pixels. */
  project(x: number, y: number): { x: number; y: number };
}

/**
 * How `object-fit: cover` places a stream in a box, as arithmetic anything can apply.
 *
 * Cover scales by whichever factor is larger, so the picture always fills the box and overflows on
 * one axis; the overflow is centred, which is where the offsets come from and why they are
 * negative. A degenerate box or stream yields an identity mapping rather than a NaN, because a
 * video element reports zero for both dimensions until metadata arrives and the first few frames
 * would otherwise draw a skeleton at nowhere.
 */
export function coverTransform(box: CoverBox): CoverTransform {
  const { streamWidth, streamHeight, boxWidth, boxHeight, mirrored = false } = box;
  const usable = streamWidth > 0 && streamHeight > 0 && boxWidth > 0 && boxHeight > 0;
  const scale = usable ? Math.max(boxWidth / streamWidth, boxHeight / streamHeight) : 1;
  const drawnWidth = usable ? streamWidth * scale : boxWidth;
  const drawnHeight = usable ? streamHeight * scale : boxHeight;
  const offsetX = (boxWidth - drawnWidth) / 2;
  const offsetY = (boxHeight - drawnHeight) / 2;

  return {
    scale,
    offsetX,
    offsetY,
    project(x, y) {
      const across = mirrored ? 1 - x : x;
      return { x: offsetX + across * drawnWidth, y: offsetY + y * drawnHeight };
    },
  };
}

const INK = "#f2f2f2";

/** Below this a landmark is a guess, and drawing a guess is how an overlay starts lying. */
const DRAWABLE = 0.35;

export function drawPose(
  context: CanvasRenderingContext2D,
  pose: readonly PoseLandmark[],
  transform: CoverTransform,
  confidence: number,
) {
  if (pose.length === 0) return;
  context.lineWidth = 3;
  // Confidence rides the alpha channel, so the hue carried nothing the greyscale cannot.
  context.strokeStyle = `rgba(242,242,242,${0.35 + confidence * 0.65})`;
  for (const [from, to] of POSE_CONNECTIONS) {
    const a = pose[from];
    const b = pose[to];
    if (!a || !b || a.visibility < DRAWABLE || b.visibility < DRAWABLE) continue;
    const start = transform.project(a.x, a.y);
    const end = transform.project(b.x, b.y);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  for (const landmark of pose) {
    if (landmark.visibility < DRAWABLE) continue;
    // Visibility was green-vs-orange; solid-vs-dim survives a monochrome scheme and a colour-blind
    // reader alike.
    context.fillStyle = landmark.visibility > 0.8 ? INK : "rgba(242,242,242,.42)";
    const point = transform.project(landmark.x, landmark.y);
    context.beginPath();
    context.arc(point.x, point.y, 4, 0, Math.PI * 2);
    context.fill();
  }
}

export interface DrawableHand {
  readonly landmarks: readonly HandLandmark[];
  readonly handedness: string;
  readonly confidence: number;
}

export function drawHands(
  context: CanvasRenderingContext2D,
  hands: readonly DrawableHand[],
  transform: CoverTransform,
) {
  for (const hand of hands) {
    if (hand.landmarks.length <= HAND_LANDMARK.middleMcp) continue;
    context.lineWidth = 3;
    // Each hand is shaded by its OWN confidence. Shading both by an aggregate meant a hand the model
    // had firmly and one it had barely drew identically, which is the one thing the shading is for.
    context.strokeStyle = `rgba(242,242,242,${0.35 + hand.confidence * 0.65})`;
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = hand.landmarks[from];
      const b = hand.landmarks[to];
      if (!a || !b) continue;
      const start = transform.project(a.x, a.y);
      const end = transform.project(b.x, b.y);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    }
    context.fillStyle = hand.handedness === "left" ? INK : "#8f8f8f";
    for (const landmark of hand.landmarks) {
      const point = transform.project(landmark.x, landmark.y);
      context.beginPath();
      context.arc(point.x, point.y, 4, 0, Math.PI * 2);
      context.fill();
    }
  }
}

/**
 * The rectangle a body should fill, drawn over the preview so the target is a place rather than a
 * sentence. Derived from the same limits the check applies, so what is drawn and what is judged
 * cannot drift apart.
 */
export function targetFrame(transform: CoverTransform, box: CoverBox, minFill: number, maxFill: number) {
  const centre = transform.project(0.5, 0.5);
  const idealFill = (minFill + maxFill) / 2;
  // Head to hip is a bit over half a standing body, so the whole figure is the span scaled up.
  const height = (idealFill / 0.55) * box.boxHeight;
  const width = height * 0.42;
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}

export function drawTargetFrame(context: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, settled: boolean) {
  context.save();
  context.lineWidth = settled ? 2 : 1;
  context.strokeStyle = settled ? INK : "rgba(242,242,242,.45)";
  context.setLineDash(settled ? [] : [6, 6]);
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

/** A body posed by hand, for the developer surface to drive without a camera. */
export function createSimulatedPose(state: { x: number; duck: boolean; jump: boolean; arms: boolean; punch: boolean }): PoseLandmark[] {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.98 }));
  const shiftY = state.jump ? -0.08 : 0;
  const upperY = state.duck ? 0.09 : 0;
  const center = 0.5 + state.x * 0.12;
  pose[0] = { x: center, y: 0.15 + shiftY + upperY, z: 0, visibility: .98 };
  pose[11] = { x: center - .1, y: .34 + shiftY + upperY, z: 0, visibility: .98 };
  pose[12] = { x: center + .1, y: .34 + shiftY + upperY, z: 0, visibility: .98 };
  pose[13] = { x: center - .14, y: state.arms ? .24 : .46 + shiftY + upperY, z: 0, visibility: .98 };
  pose[14] = { x: center + .14, y: state.arms ? .24 : .46 + shiftY + upperY, z: 0, visibility: .98 };
  pose[15] = { x: center - .16, y: state.arms ? .14 : .57 + shiftY + upperY, z: 0, visibility: .98 };
  pose[16] = { x: center + .16, y: state.arms ? .14 : .57 + shiftY + upperY, z: 0, visibility: .98 };
  pose[23] = { x: center - .06, y: .59 + shiftY, z: 0, visibility: .98 };
  pose[24] = { x: center + .06, y: .59 + shiftY, z: 0, visibility: .98 };
  pose[25] = { x: center - .05, y: .76 + shiftY, z: 0, visibility: .98 };
  pose[26] = { x: center + .05, y: .76 + shiftY, z: 0, visibility: .98 };
  pose[27] = { x: center - .05, y: .94 + shiftY, z: 0, visibility: .98 };
  pose[28] = { x: center + .05, y: .94 + shiftY, z: 0, visibility: .98 };
  pose[29] = { ...pose[27]!, x: center - .07 };
  pose[30] = { ...pose[28]!, x: center + .07 };
  pose[31] = { ...pose[27]!, x: center - .09 };
  pose[32] = { ...pose[28]!, x: center + .09 };
  return pose;
}
