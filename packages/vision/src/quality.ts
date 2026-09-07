/**
 * Which tracking model to run, and how to pick one for the device in front of you.
 *
 * MediaPipe ships three pose models. The product ran the smallest of them on the CPU, for a single
 * person, which is most of why body tracking felt unreliable — not the approach, the settings.
 *
 * The tiers are named for what a player is choosing between, not for the file they load: nobody is
 * deciding between `pose_landmarker_lite.task` and `pose_landmarker_heavy.task`, they are deciding
 * whether their laptop can afford to be accurate.
 */
export type TrackingQuality = "fast" | "balanced" | "precise";

export interface TrackingProfile {
  readonly quality: TrackingQuality;
  readonly label: string;
  /** What the player gives up or gains, in one line. */
  readonly note: string;
  readonly poseModel: string;
  /** Approximate download, so a phone on cellular is told before it commits. */
  readonly downloadMB: number;
}

export const TRACKING_PROFILES: Readonly<Record<TrackingQuality, TrackingProfile>> = Object.freeze({
  fast: {
    quality: "fast",
    label: "Fast",
    note: "Lowest delay. Loses track when you turn sideways or move quickly.",
    poseModel: "/models/pose_landmarker_lite.task",
    downloadMB: 6,
  },
  balanced: {
    quality: "balanced",
    label: "Balanced",
    note: "Follows turns and partial cover. Right for most devices.",
    poseModel: "/models/pose_landmarker_full.task",
    downloadMB: 9,
  },
  precise: {
    quality: "precise",
    label: "Precise",
    note: "Holds on through fast movement and awkward angles. Needs a recent machine.",
    poseModel: "/models/pose_landmarker_heavy.task",
    downloadMB: 30,
  },
});

export interface DeviceHints {
  /** navigator.hardwareConcurrency, when the browser reports it. */
  readonly cores?: number;
  /** navigator.deviceMemory in GB, Chromium-only. */
  readonly memoryGB?: number;
  /** Whether a GPU delegate is actually available, not merely whether WebGL exists. */
  readonly gpu?: boolean;
  /** A coarse pointer stands in for "this is a phone or tablet". */
  readonly coarsePointer?: boolean;
  /** Metered or slow connection, from the Network Information API. */
  readonly saveData?: boolean;
}

/**
 * A recommendation, not a decision.
 *
 * Deliberately conservative: guessing too high costs a player a stuttering game and a 30MB download
 * they cannot afford, while guessing too low costs them accuracy they can turn back on in one tap.
 * The player's own choice always wins — this only decides what is preselected.
 */
export function recommendQuality(hints: DeviceHints = {}): TrackingQuality {
  if (hints.saveData) return "fast";

  const cores = hints.cores ?? 4;
  const memory = hints.memoryGB ?? (hints.coarsePointer ? 4 : 8);

  // No GPU delegate means every frame is inference on the CPU, where even `full` struggles.
  if (!hints.gpu) return "fast";
  if (hints.coarsePointer) return cores >= 8 && memory >= 6 ? "balanced" : "fast";
  if (cores >= 8 && memory >= 8) return "precise";
  if (cores >= 4) return "balanced";
  return "fast";
}

/** Read what this browser will admit to. Every field is optional in some engine, so all are guarded. */
export function readDeviceHints(): DeviceHints {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return {
    cores: nav.hardwareConcurrency,
    memoryGB: nav.deviceMemory,
    coarsePointer: typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false),
    saveData: nav.connection?.saveData ?? false,
    gpu: detectGpu(),
  };
}

/**
 * Whether a GPU delegate has a chance of working.
 *
 * MediaPipe's GPU delegate wants WebGL2, and asking for a context is the only honest way to know —
 * a browser can expose the constructor and still fail to create one on a blocklisted driver.
 */
function detectGpu() {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

/**
 * Which model file to actually load for a chosen tier.
 *
 * `full` and `heavy` are fetched rather than committed — 9MB and 30MB is not something to carry in
 * a git history for a tier most machines will not pick. A checkout without them still tracks a body,
 * because a tier whose asset is absent resolves to one that is present rather than failing to start.
 *
 * `available` is the set of model paths this deployment actually serves. It defaults to what is
 * committed, so a caller that cannot know resolves to a file that exists — which is what this
 * comment claimed before and the code did not do: with `available` undefined the guard was skipped
 * entirely and the first tier won, so asking for `precise` returned the 30MB model that is not in
 * the repository.
 */
/**
 * The pose models this repository actually serves out of public/models.
 *
 * A constant rather than a filesystem read, because the caller is a browser. A test keeps it honest
 * against the directory, which is the only thing that can: a path that 404s does not fail until a
 * player has already chosen the camera and waited for a download that is not coming.
 */
export const COMMITTED_POSE_MODELS: ReadonlySet<string> = new Set(["/models/pose_landmarker_lite.task"]);

export function resolvePoseModel(quality: TrackingQuality, available: ReadonlySet<string> = COMMITTED_POSE_MODELS) {
  const order: TrackingQuality[] = quality === "precise"
    ? ["precise", "balanced", "fast"]
    : quality === "balanced" ? ["balanced", "fast"] : ["fast"];
  for (const tier of order) {
    const path = TRACKING_PROFILES[tier].poseModel;
    if (available.has(path)) return { quality: tier, poseModel: path };
  }
  return { quality: "fast" as TrackingQuality, poseModel: TRACKING_PROFILES.fast.poseModel };
}
