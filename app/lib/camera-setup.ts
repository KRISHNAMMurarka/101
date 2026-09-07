import type { CameraFailure } from "@101/adapter-camera";
import type { PlacementIssue } from "@101/vision";

import type { CameraKind } from "./camera-plan.ts";

/**
 * The four beats of camera setup, as a reducer.
 *
 * No timers, no DOM, no React. Partly because the test runner cannot import a .tsx and this is the
 * part worth testing; mostly because the flow has transitions that are easy to get wrong and
 * invisible when they are — a check that can be re-entered, a confirmation that must not outlive
 * the framing it confirms, a skip that is not a pass, and a camera that can be taken away at any
 * point including after everything has succeeded.
 *
 * The beats: which camera, where to stand, does it work, do something so we both know it works.
 */

export type SetupStep = "camera" | "place" | "check" | "confirm" | "ready";

export interface SetupState {
  readonly step: SetupStep;
  readonly kind: CameraKind;
  /** Set when the camera itself failed. Nothing proceeds while this is present. */
  readonly failure?: CameraFailure;
  /** What is wrong with the framing right now, if anything. */
  readonly issue?: PlacementIssue;
  /** True when the player chose to go on without finishing the check. */
  readonly skipped: boolean;
  /** How long the framing has been broken during the confirm beat, in milliseconds. */
  readonly brokenForMs: number;
}

export type SetupEvent =
  | { type: "camera-started" }
  | { type: "camera-failed"; failure: CameraFailure }
  | { type: "camera-lost" }
  | { type: "placement"; issue: PlacementIssue | undefined; elapsedMs: number }
  /** The player pressed on from the teaching beat. */
  | { type: "continue" }
  /** The framing has been right for long enough to be believed. */
  | { type: "placement-held" }
  | { type: "gesture" }
  | { type: "skip" }
  | { type: "back" }
  | { type: "retry" };

export const INITIAL_SETUP = (kind: CameraKind): SetupState => ({
  step: "camera",
  kind,
  skipped: false,
  brokenForMs: 0,
});

/**
 * How long the framing may be broken during the confirmation before the flow drops back to the
 * check.
 *
 * Raising both hands above your head is a movement large enough to walk you out of a tight frame,
 * so a brief lapse here is the gesture itself and not a mistake. A long one is someone who has
 * genuinely left, and confirming a framing that no longer exists would send them into a game that
 * cannot see them — having just told them it could.
 */
export const CONFIRM_GRACE_MS = 800;

export function advanceSetup(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case "camera-failed":
      // From any step. A camera can fail after it has been working.
      return { ...state, step: "camera", failure: event.failure, issue: undefined, brokenForMs: 0 };

    case "camera-lost":
      return { ...state, step: "camera", failure: "in-use", issue: undefined, brokenForMs: 0 };

    case "retry":
      return { ...INITIAL_SETUP(state.kind), skipped: state.skipped };

    case "camera-started":
      if (state.step !== "camera") return state;
      return { ...state, step: "place", failure: undefined };

    case "back":
      // Only backwards, and never out of the flow: `camera` is the first beat.
      return {
        ...state,
        step: state.step === "ready" ? "confirm" : state.step === "confirm" ? "check" : state.step === "check" ? "place" : "camera",
        issue: undefined,
        brokenForMs: 0,
      };

    case "skip":
      // Recorded as a skip, not as a pass. A game that knows the check did not run can say so if
      // tracking then goes badly, instead of insisting the camera was set up correctly.
      return { ...state, step: "ready", skipped: true, issue: undefined };

    case "placement": {
      if (state.step === "confirm") {
        // The confirmation only survives a short lapse; see CONFIRM_GRACE_MS.
        const brokenForMs = event.issue ? state.brokenForMs + event.elapsedMs : 0;
        if (brokenForMs > CONFIRM_GRACE_MS) {
          return { ...state, step: "check", issue: event.issue, brokenForMs: 0 };
        }
        return { ...state, brokenForMs };
      }
      if (state.step !== "check" && state.step !== "place") return state;
      return { ...state, issue: event.issue };
    }

    case "continue":
      if (state.step !== "place") return state;
      return { ...state, step: "check", issue: undefined };

    case "placement-held":
      // From the teaching beat this skips ahead: someone already standing correctly is not made to
      // watch a check confirm a thing that has already happened. From the check itself it is the
      // check passing. Both land on the gesture, and `check` is reachable forwards either way —
      // which it was not when one event did both jobs and stepped over it entirely.
      if (state.step === "place") return { ...state, step: "check", issue: undefined };
      if (state.step !== "check") return state;
      return { ...state, step: "confirm", issue: undefined, brokenForMs: 0 };

    case "gesture":
      if (state.step !== "confirm") return state;
      return { ...state, step: "ready", issue: undefined };

    default:
      return state;
  }
}

/** Whether the player may move on from where they are. */
export function canAdvance(state: SetupState) {
  if (state.failure) return false;
  return state.step === "place" || state.step === "ready";
}

export const SETUP_COPY: Readonly<Record<SetupStep, { readonly title: string; readonly body: Readonly<Record<CameraKind, string>> }>> = {
  camera: {
    title: "Camera",
    body: {
      body: "We'll use a camera to watch how you move. Nothing leaves this device.",
      hands: "We'll use a camera to watch your hands. Nothing leaves this device.",
    },
  },
  place: {
    title: "Where to stand",
    body: {
      body: "Put the camera where it can see you from head to knee, and stand back a couple of steps.",
      hands: "Sit where the camera can see your hands in front of you.",
    },
  },
  check: {
    title: "Check",
    body: {
      body: "Stand in the frame until it fills in.",
      hands: "Hold a hand up until the frame fills in.",
    },
  },
  confirm: {
    title: "Start",
    body: {
      body: "Raise both hands above your head.",
      hands: "Hold your hand up and spread your fingers.",
    },
  },
  ready: {
    title: "Ready",
    body: {
      body: "That's it. The camera can see you.",
      hands: "That's it. The camera can see your hands.",
    },
  },
};

/*
 * What the player already did, remembered per camera kind rather than per game.
 *
 * The advice is identical for all three body games — stand back, head to knee — so making someone
 * who has set up BodyDodge do it again for Shadow Arena teaches them nothing and costs them a
 * minute. Keyed by kind, so the hands games and the body games remember separately, which is right:
 * they ask for opposite things.
 */
const MEMORY_KEY = (kind: CameraKind) => `101.camera-setup.${kind}`;

export function rememberCameraSetup(kind: CameraKind) {
  try {
    localStorage.setItem(MEMORY_KEY(kind), "done");
  } catch {
    // The walkthrough simply appears again next time.
  }
}

export function recallCameraSetup(kind: CameraKind) {
  try {
    return localStorage.getItem(MEMORY_KEY(kind)) === "done";
  } catch {
    return false;
  }
}
