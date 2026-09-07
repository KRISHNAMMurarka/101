import { HAND_LANDMARK, POSE_LANDMARK, type HandLandmark, type PoseLandmark } from "./index.ts";

/**
 * Whether the camera can see the player well enough to play, and what to say when it cannot.
 *
 * Everything here is arithmetic over the picture: normalized x and y across the frame, and
 * per-landmark visibility. Nothing reads `world`, deliberately and not for simplicity. The metric
 * landmarks are expressed relative to the midpoint of the hips, so they carry no distance from the
 * camera at all; mirroring leaves them stale, so they disagree with the image about left and right;
 * and smoothing dropped them outright until today. A check that reasons in the same space as the
 * picture the player is looking at is also the only one a phone acting as the camera could reuse,
 * because the wire format has never carried metres either.
 *
 * The vocabulary is part of the module rather than the component. A placement problem has exactly
 * one right sentence, the game and the walkthrough must say the same one, and a sentence that lives
 * next to the arithmetic that raises it is a sentence that can be tested.
 */

export type PlacementIssue =
  | "no-camera-image"
  | "too-dark"
  | "backlit"
  | "nobody"
  | "too-close"
  | "too-far"
  | "off-left"
  | "off-right"
  | "cut-off-legs"
  | "cut-off-torso"
  | "hands-not-in-shot"
  | "hand-too-small";

export interface BodyRegions {
  readonly head: number;
  readonly torso: number;
  readonly arms: number;
  readonly legs: number;
}

export interface PlacementReading {
  /** Nothing wrong that the player has to fix. */
  readonly ok: boolean;
  /** Every problem found, worst first. `issues[0]` is the one to say out loud. */
  readonly issues: readonly PlacementIssue[];
  readonly regions: BodyRegions;
  /**
   * Roughly how much of the frame's height the body fills, 0 to 1. Measured head to hip rather than
   * across the shoulders: a shoulder span shrinks when someone turns side-on, which would read as
   * them walking away, and it is measured along x, where a 4:3 frame's aspect distorts it.
   */
  readonly fill: number;
  /** Where the body's centre sits across the frame, 0 at the left edge and 1 at the right. */
  readonly centre: number;
}

export interface LightSample {
  /** Mean brightness of the picture, 0 to 1. */
  readonly luma: number;
  /** Mean brightness of the middle of the picture, where a person stands, 0 to 1. */
  readonly subjectLuma: number;
}

export const PLACEMENT_LIMITS = {
  /** A landmark below this is not something to draw conclusions from. */
  seen: 0.5,
  /** Head-to-hip span, as a fraction of frame height. Below is too far, above is too close. */
  minFill: 0.22,
  maxFill: 0.72,
  /** How far the body's centre may sit from the middle of the frame before it is drifting out. */
  maxDrift: 0.3,
  /** Below this the room is too dark to see anyone in. */
  minLuma: 0.16,
  /**
   * How much darker the subject may be than the picture as a whole before they are a silhouette.
   * A window behind someone raises the mean while leaving the person unlit, which is the single
   * most common bad camera in a home and the one a brightness threshold alone never catches.
   */
  maxBacklight: 0.45,
  /** Palm width as a fraction of frame width, corrected for aspect. */
  minHandSize: 0.08,
} as const;

/**
 * Worst first. Order is meaning, not taste: there is no point telling someone to step left while
 * the room is too dark to see them, and "nobody is in the picture" must outrank every framing note,
 * which would otherwise all be true of an empty room.
 */
export const PLACEMENT_PRECEDENCE: readonly PlacementIssue[] = [
  "no-camera-image",
  "too-dark",
  "backlit",
  "nobody",
  "hands-not-in-shot",
  "too-close",
  "too-far",
  "hand-too-small",
  "cut-off-torso",
  "off-left",
  "off-right",
  "cut-off-legs",
];

/**
 * What each problem is called, and what to do about it.
 *
 * Player language throughout: no landmark, no confidence, no model, no percentage. A guard test
 * holds the line, because copy re-acquires developer words the moment someone edits it near the
 * arithmetic.
 */
export const PLACEMENT_COPY: Readonly<Record<PlacementIssue, { readonly problem: string; readonly fix: string }>> = {
  "no-camera-image": { problem: "We can't see anything through the camera.", fix: "Check nothing is covering the lens." },
  "too-dark": { problem: "It's too dark in here to see you.", fix: "Turn a light on, or face a window." },
  "backlit": { problem: "The light behind you is too strong.", fix: "Turn so the window is in front of you, not behind." },
  "nobody": { problem: "Nobody's in the picture yet.", fix: "Step in front of the camera." },
  "too-close": { problem: "You're a bit close.", fix: "Take a step back." },
  "too-far": { problem: "You're a bit far away.", fix: "Come a step closer." },
  "off-left": { problem: "You're off the left of the picture.", fix: "Move to your right." },
  "off-right": { problem: "You're off the right of the picture.", fix: "Move to your left." },
  "cut-off-legs": { problem: "We can see you down to about your waist.", fix: "Take a step back so your legs are in shot." },
  "cut-off-torso": { problem: "We can only see part of you.", fix: "Move so your head and body are both in the picture." },
  "hands-not-in-shot": { problem: "We can't see your hands.", fix: "Hold them up in front of the camera." },
  "hand-too-small": { problem: "Your hand is a bit far from the camera.", fix: "Bring it closer." },
};

/** Sort issues into the order they should be said, and keep them unique. */
function rank(found: Iterable<PlacementIssue>): PlacementIssue[] {
  const unique = new Set(found);
  return PLACEMENT_PRECEDENCE.filter((issue) => unique.has(issue));
}

const seen = (landmarks: readonly PoseLandmark[], index: number) =>
  (landmarks[index]?.visibility ?? 0) >= PLACEMENT_LIMITS.seen;

function regionVisibility(landmarks: readonly PoseLandmark[], indices: readonly number[]) {
  const total = indices.reduce((sum, index) => sum + (landmarks[index]?.visibility ?? 0), 0);
  return total / indices.length;
}

const EMPTY_REGIONS: BodyRegions = { head: 0, torso: 0, arms: 0, legs: 0 };

export interface BodyPlacementOptions {
  /**
   * Brightness of the picture, when the caller has measured it. Optional because it comes from the
   * video element rather than from the model, and a caller that has not sampled it should get a
   * framing verdict rather than a lie about the room: a missing sample is not a dark room.
   */
  light?: LightSample;
  /**
   * Whether this game needs to see the player's legs.
   *
   * The six camera games do not agree. Dodging on your feet needs the whole body in shot; casting
   * with your hands at a desk does not, and demanding legs there would send a seated player
   * backwards until they could no longer reach anything. So legs are a requirement a game states,
   * not a property of the camera.
   */
  needsLegs?: boolean;
}

/** Read a whole-body framing. */
export function readBodyPlacement(landmarks: readonly PoseLandmark[], options: BodyPlacementOptions = {}): PlacementReading {
  const { light, needsLegs = false } = options;
  const issues: PlacementIssue[] = [];

  if (light) {
    if (light.luma < PLACEMENT_LIMITS.minLuma) issues.push("too-dark");
    else if (light.luma - light.subjectLuma > PLACEMENT_LIMITS.maxBacklight) issues.push("backlit");
  }

  if (landmarks.length === 0) {
    return { ok: false, issues: rank([...issues, "nobody"]), regions: EMPTY_REGIONS, fill: 0, centre: 0.5 };
  }

  const regions: BodyRegions = {
    head: regionVisibility(landmarks, [POSE_LANDMARK.nose]),
    torso: regionVisibility(landmarks, [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.rightShoulder, POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip]),
    arms: regionVisibility(landmarks, [POSE_LANDMARK.leftElbow, POSE_LANDMARK.rightElbow, POSE_LANDMARK.leftWrist, POSE_LANDMARK.rightWrist]),
    legs: regionVisibility(landmarks, [POSE_LANDMARK.leftKnee, POSE_LANDMARK.rightKnee, POSE_LANDMARK.leftAnkle, POSE_LANDMARK.rightAnkle]),
  };

  // The torso is what every reader downstream needs, so without it there is no body to place — this
  // is "nobody", not a framing note, however much of an arm happens to be visible.
  const torsoSeen = seen(landmarks, POSE_LANDMARK.leftShoulder) && seen(landmarks, POSE_LANDMARK.rightShoulder)
    && seen(landmarks, POSE_LANDMARK.leftHip) && seen(landmarks, POSE_LANDMARK.rightHip);
  if (!torsoSeen) {
    const anything = regions.head > 0 || regions.arms > 0 || regions.torso > 0;
    return {
      ok: false,
      issues: rank([...issues, anything ? "cut-off-torso" : "nobody"]),
      regions,
      fill: 0,
      centre: 0.5,
    };
  }

  const nose = landmarks[POSE_LANDMARK.nose];
  const leftHip = landmarks[POSE_LANDMARK.leftHip]!;
  const rightHip = landmarks[POSE_LANDMARK.rightHip]!;
  const leftShoulder = landmarks[POSE_LANDMARK.leftShoulder]!;
  const rightShoulder = landmarks[POSE_LANDMARK.rightShoulder]!;

  const hipY = (leftHip.y + rightHip.y) / 2;
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  // Head to hip when the head is in shot; shoulders to hip is about half that span, so it is scaled
  // to match rather than reported as a different quantity with the same name.
  const fill = seen(landmarks, POSE_LANDMARK.nose) && nose
    ? Math.abs(hipY - nose.y)
    : Math.abs(hipY - shoulderY) * 1.9;
  const centre = (leftHip.x + rightHip.x) / 2;

  if (fill > PLACEMENT_LIMITS.maxFill) issues.push("too-close");
  else if (fill < PLACEMENT_LIMITS.minFill) issues.push("too-far");

  const drift = centre - 0.5;
  if (drift < -PLACEMENT_LIMITS.maxDrift) issues.push("off-left");
  else if (drift > PLACEMENT_LIMITS.maxDrift) issues.push("off-right");

  if (needsLegs && regions.legs < PLACEMENT_LIMITS.seen) issues.push("cut-off-legs");

  const ranked = rank(issues);
  return { ok: ranked.length === 0, issues: ranked, regions, fill, centre };
}

/**
 * Read a hands framing.
 *
 * `frameAspect` is width over height. Both landmark axes are fractions of a different edge, so a
 * distance that mixes them is anisotropic: on a 4:3 stream an upright hand measures about a third
 * larger than the same hand held sideways. Scaling x by the aspect puts both terms in units of
 * frame height, which is what makes one threshold hold at any orientation.
 */
export function readHandPlacement(hands: ReadonlyArray<readonly HandLandmark[]>, frameAspect = 1, light?: LightSample): PlacementReading {
  const issues: PlacementIssue[] = [];

  if (light) {
    if (light.luma < PLACEMENT_LIMITS.minLuma) issues.push("too-dark");
    else if (light.luma - light.subjectLuma > PLACEMENT_LIMITS.maxBacklight) issues.push("backlit");
  }

  const hand = hands.find((candidate) => candidate.length > HAND_LANDMARK.middleMcp);
  if (!hand) {
    return { ok: false, issues: rank([...issues, "hands-not-in-shot"]), regions: EMPTY_REGIONS, fill: 0, centre: 0.5 };
  }

  const wrist = hand[HAND_LANDMARK.wrist]!;
  const middle = hand[HAND_LANDMARK.middleMcp]!;
  const palm = Math.hypot((middle.x - wrist.x) * frameAspect, middle.y - wrist.y);
  const centre = (wrist.x + middle.x) / 2;

  if (palm < PLACEMENT_LIMITS.minHandSize) issues.push("hand-too-small");

  const drift = centre - 0.5;
  if (drift < -PLACEMENT_LIMITS.maxDrift) issues.push("off-left");
  else if (drift > PLACEMENT_LIMITS.maxDrift) issues.push("off-right");

  const ranked = rank(issues);
  return { ok: ranked.length === 0, issues: ranked, regions: EMPTY_REGIONS, fill: palm, centre };
}

/**
 * The one sentence to show for a reading, or undefined when there is nothing to fix.
 *
 * `mirrored` flips left and right. A preview is shown mirrored so it behaves like a mirror, and in
 * a mirror the player's own left hand appears on the right of the picture — so an instruction
 * derived from frame coordinates is backwards for the person following it unless it is flipped to
 * match what they are looking at.
 */
export function describePlacement(reading: PlacementReading, mirrored = true): { issue: PlacementIssue; problem: string; fix: string } | undefined {
  const first = reading.issues[0];
  if (!first) return undefined;
  const issue = mirrored ? MIRRORED[first] ?? first : first;
  return { issue, ...PLACEMENT_COPY[issue] };
}

const MIRRORED: Partial<Record<PlacementIssue, PlacementIssue>> = {
  "off-left": "off-right",
  "off-right": "off-left",
};

export interface PlacementGateOptions {
  /** How long everything must stay right before the setup is allowed to move on. */
  holdMs?: number;
  /** How long a problem must persist before its sentence is shown. */
  settleMs?: number;
  /**
   * How long tracking may lapse without restarting the hold.
   *
   * Without this the hold is a continuous run of clean frames, which sounds right and is not: pose
   * tracking drops frames routinely, and at thirty frames a second a 1.2s run is about thirty-six
   * of them. At a five percent drop rate that run completes roughly one time in six, so a player
   * standing in exactly the right place watches the check never finish. A lapse shorter than this
   * is a dropped frame, not a player who moved.
   */
  graceMs?: number;
}

/**
 * Turns a stream of readings into a decision, which is a different job from taking one.
 *
 * Tracking drops and recovers constantly, so a gate that passed on a single clean frame would let
 * a player through on a flicker, and one that re-read its sentence every frame would flip between
 * two near-equal complaints faster than anyone can act on either. So: clean for a continuous
 * stretch before passing, and a problem must hold for a moment before it is worth saying.
 */
export class PlacementGate {
  private readonly holdMs: number;
  private readonly settleMs: number;
  private readonly graceMs: number;
  private cleanSince: number | undefined;
  private lapsedSince: number | undefined;
  private candidate: PlacementIssue | undefined;
  private candidateSince = 0;
  private shown: PlacementIssue | undefined;

  constructor(options: PlacementGateOptions = {}) {
    this.holdMs = options.holdMs ?? 1_200;
    this.settleMs = options.settleMs ?? 500;
    this.graceMs = options.graceMs ?? 350;
  }

  update(reading: PlacementReading, timestamp: number): { passed: boolean; issue: PlacementIssue | undefined } {
    const first = reading.issues[0];

    if (first === undefined) {
      this.cleanSince ??= timestamp;
      this.lapsedSince = undefined;
      this.candidate = undefined;
      this.shown = undefined;
      return { passed: timestamp - this.cleanSince >= this.holdMs, issue: undefined };
    }

    // A short lapse keeps the hold running. A long one is the player having actually moved, and
    // starts it again.
    this.lapsedSince ??= timestamp;
    if (timestamp - this.lapsedSince > this.graceMs) this.cleanSince = undefined;
    if (first !== this.candidate) {
      this.candidate = first;
      this.candidateSince = timestamp;
    }
    // The first problem of a run is shown at once — there is nothing on screen yet to flicker
    // against, and waiting half a second to say anything reads as the camera not working.
    if (this.shown === undefined || timestamp - this.candidateSince >= this.settleMs) this.shown = first;
    return { passed: false, issue: this.shown };
  }

  reset() {
    this.cleanSince = undefined;
    this.lapsedSince = undefined;
    this.candidate = undefined;
    this.shown = undefined;
  }
}
