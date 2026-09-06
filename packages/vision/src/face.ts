/**
 * Faces.
 *
 * `camera-face` has been a declared input source since the input vocabulary was written, and had an
 * icon drawn for it, and nothing has ever produced one — which is why nothing in 101 can react to a
 * blink, a raised eyebrow or an open mouth.
 *
 * What a game wants from a face is almost never a landmark. It wants "did they blink", "are they
 * looking away", "is their mouth open" — so this exposes the model's blendshapes as named,
 * normalized signals, and keeps the raw mesh available for anything that genuinely needs geometry.
 */

/** A point on the face mesh, normalized to the frame. */
export interface FaceLandmark {
  x: number;
  y: number;
  z: number;
}

/**
 * The expression signals a game can act on, each 0-1.
 *
 * Named for the movement rather than the muscle: a game asks whether an eye closed, not for
 * `eyeBlinkLeft`'s activation. Left and right are the player's own left and right.
 */
export interface FaceExpression {
  blinkLeft: number;
  blinkRight: number;
  /** Both eyes closed together, which is the one a game usually means by "blink". */
  blink: number;
  browRaise: number;
  browLower: number;
  mouthOpen: number;
  smile: number;
  /** Positive when the tongue is out, which children find first and games should support. */
  tongueOut: number;
}

export interface TrackedFace {
  landmarks: FaceLandmark[];
  expression: FaceExpression;
  /**
   * Where the head is pointing, in radians, from the model's transformation matrix.
   * Yaw is turning left/right, pitch is nodding, roll is tilting an ear to a shoulder.
   */
  orientation?: { yaw: number; pitch: number; roll: number };
  confidence: number;
}

/** The blendshape names MediaPipe emits, for the eight signals above. */
const BLENDSHAPES = {
  blinkLeft: ["eyeBlinkLeft"],
  blinkRight: ["eyeBlinkRight"],
  browRaise: ["browInnerUp", "browOuterUpLeft", "browOuterUpRight"],
  browLower: ["browDownLeft", "browDownRight"],
  mouthOpen: ["jawOpen"],
  smile: ["mouthSmileLeft", "mouthSmileRight"],
  tongueOut: ["tongueOut"],
} as const;

/**
 * Turn a blendshape list into named signals.
 *
 * Multi-shape signals average rather than sum, so a value stays 0-1 and a game can treat every
 * signal the same way. Anything the model did not report is 0 — absent is not the same as zero in
 * general, but for an expression it is the honest reading: no evidence of that movement.
 */
export function readExpression(categories: ReadonlyArray<{ categoryName: string; score: number }>): FaceExpression {
  const byName = new Map(categories.map((category) => [category.categoryName, category.score]));
  const read = (names: readonly string[]) => {
    let total = 0;
    let seen = 0;
    for (const name of names) {
      const score = byName.get(name);
      if (score !== undefined) { total += score; seen++; }
    }
    return seen === 0 ? 0 : total / seen;
  };

  const blinkLeft = read(BLENDSHAPES.blinkLeft);
  const blinkRight = read(BLENDSHAPES.blinkRight);
  return {
    blinkLeft,
    blinkRight,
    // Both eyes, not either: a wink is one eye and should not read as a blink.
    blink: Math.min(blinkLeft, blinkRight),
    browRaise: read(BLENDSHAPES.browRaise),
    browLower: read(BLENDSHAPES.browLower),
    mouthOpen: read(BLENDSHAPES.mouthOpen),
    smile: read(BLENDSHAPES.smile),
    tongueOut: read(BLENDSHAPES.tongueOut),
  };
}

/**
 * Head orientation from the 4x4 facial transformation matrix, column-major as MediaPipe emits it.
 *
 * Standard rotation-matrix extraction. Guarded against gimbal lock at ±90° pitch, where yaw and roll
 * stop being separable and the usual formula produces noise rather than an answer.
 */
export function readOrientation(matrix: ReadonlyArray<number>) {
  if (matrix.length < 16) return undefined;
  const m = (row: number, column: number) => matrix[column * 4 + row]!;

  const sinPitch = -m(2, 0);
  const clamped = Math.max(-1, Math.min(1, sinPitch));
  const pitch = Math.asin(clamped);

  if (Math.abs(clamped) > 0.9999) {
    return { yaw: Math.atan2(-m(0, 1), m(1, 1)), pitch, roll: 0 };
  }
  return { yaw: Math.atan2(m(1, 0), m(0, 0)), pitch, roll: Math.atan2(m(2, 1), m(2, 2)) };
}

/** A face doing nothing, for the frames before one is found. */
export const NEUTRAL_FACE: FaceExpression = Object.freeze({
  blinkLeft: 0, blinkRight: 0, blink: 0, browRaise: 0, browLower: 0, mouthOpen: 0, smile: 0, tongueOut: 0,
});
