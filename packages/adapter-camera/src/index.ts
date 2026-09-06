import type { InputAdapter, InputFrame, InputFrameListener } from "@101/input";
import {
  flattenPose,
  flattenHand,
  HandGestureClassifier,
  mirrorHand,
  mirrorPose,
  PoseClassifier,
  type HandGestureClassifierOptions,
  type HandSignals,
  type PoseClassifierOptions,
  type PoseLandmark,
  type PoseSignals,
  type TrackedHand,
  readExpression,
  readOrientation,
  type TrackedFace,
} from "@101/vision";

export interface PoseAdapterDiagnostics {
  rawPose: PoseLandmark[];
  pose: PoseLandmark[];
  signals: PoseSignals;
  frame: InputFrame;
  inferenceMs: number;
}

export interface PoseInputAdapterOptions {
  deviceId?: string;
  playerId?: string;
  mirror?: boolean;
  classifier?: PoseClassifierOptions;
  onDiagnostics?: (diagnostics: PoseAdapterDiagnostics) => void;
}

export class PoseInputAdapter implements InputAdapter {
  readonly id: string;
  readonly source = "camera-pose" as const;
  readonly classifier: PoseClassifier;
  private readonly playerId: string;
  private readonly mirror: boolean;
  private readonly onDiagnostics?: (diagnostics: PoseAdapterDiagnostics) => void;
  private emit?: InputFrameListener;
  private sequence = 0;
  private lastPose?: PoseLandmark[];

  constructor(options: PoseInputAdapterOptions = {}) {
    this.id = options.deviceId ?? "camera-pose-browser";
    this.playerId = options.playerId ?? "player-1";
    this.mirror = options.mirror ?? true;
    this.classifier = new PoseClassifier(options.classifier);
    this.onDiagnostics = options.onDiagnostics;
  }

  start(emit: InputFrameListener) {
    this.emit = emit;
  }

  stop() {
    this.emit = undefined;
    this.lastPose = undefined;
    this.classifier.reset();
  }

  ingestPose(rawPose: readonly PoseLandmark[], timestamp = performance.now(), inferenceMs = 0) {
    const pose = this.mirror ? mirrorPose(rawPose) : rawPose.map((landmark) => ({ ...landmark }));
    this.lastPose = pose;
    const signals = this.classifier.process(pose, timestamp);
    const frame: InputFrame = {
      deviceId: this.id,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp,
      source: this.source,
      actions: {
        ...signals.actions,
        "combat.punchLeft": signals.combat.punchLeft,
        "combat.punchRight": signals.combat.punchRight,
        "combat.block": signals.combat.block,
        "combat.duck": signals.actions.duck,
        "combat.jump": signals.actions.jump,
        "combat.special": signals.combat.special,
      },
      axes: {
        bodyX: signals.axes.bodyX,
        dodgeX: signals.axes.bodyX,
        lean: signals.axes.lean,
        crouch: signals.axes.crouch,
        lift: signals.axes.lift,
      },
      vectors: {
        body: { x: signals.axes.bodyX, y: signals.actions.jump ? -1 : signals.actions.duck ? 1 : 0 },
        bodyLean: { x: signals.axes.lean, y: signals.axes.crouch - signals.axes.lift },
        "combat.move": { x: signals.axes.bodyX, y: signals.actions.jump ? -1 : signals.actions.duck ? 1 : 0 },
      },
      poses: { body: flattenPose(pose) },
    };
    this.emit?.(frame);
    this.onDiagnostics?.({ rawPose: rawPose.map((landmark) => ({ ...landmark })), pose, signals, frame, inferenceMs });
    return frame;
  }

  calibrateNeutral() {
    return this.lastPose ? this.classifier.calibrateNeutral(this.lastPose) : false;
  }
}

export interface HandAdapterDiagnostics {
  rawHands: TrackedHand[];
  hands: TrackedHand[];
  signals: HandSignals;
  frame: InputFrame;
  inferenceMs: number;
}

export interface HandInputAdapterOptions {
  deviceId?: string;
  playerId?: string;
  mirror?: boolean;
  classifier?: HandGestureClassifierOptions;
  onDiagnostics?: (diagnostics: HandAdapterDiagnostics) => void;
}

export class HandInputAdapter implements InputAdapter {
  readonly id: string;
  readonly source = "camera-hand" as const;
  readonly classifier: HandGestureClassifier;
  private readonly playerId: string;
  private readonly mirror: boolean;
  private readonly onDiagnostics?: (diagnostics: HandAdapterDiagnostics) => void;
  private emit?: InputFrameListener;
  private sequence = 0;

  constructor(options: HandInputAdapterOptions = {}) {
    this.id = options.deviceId ?? "camera-hand-browser";
    this.playerId = options.playerId ?? "player-1";
    this.mirror = options.mirror ?? true;
    this.classifier = new HandGestureClassifier(options.classifier);
    this.onDiagnostics = options.onDiagnostics;
  }

  start(emit: InputFrameListener) {
    this.emit = emit;
  }

  stop() {
    this.emit = undefined;
    this.classifier.reset();
  }

  ingestHands(rawHands: readonly TrackedHand[], timestamp = performance.now(), inferenceMs = 0) {
    const hands = rawHands.map((hand): TrackedHand => ({
      handedness: hand.handedness,
      confidence: hand.confidence,
      landmarks: this.mirror ? mirrorHand(hand.landmarks) : hand.landmarks.map((landmark) => ({ ...landmark })),
    }));
    const signals = this.classifier.process(hands, timestamp);
    const activated = new Set(signals.activated);
    const poses: Record<string, number[]> = {};
    hands.forEach((hand, index) => {
      const key = hand.handedness === "unknown" ? `hand${index + 1}` : `${hand.handedness}Hand`;
      poses[key] = flattenHand(hand.landmarks);
      if (index === 0) poses.hand = flattenHand(hand.landmarks);
    });
    const swipeDirection = activated.has("swipeLeft") ? -1 : activated.has("swipeRight") ? 1 : 0;
    const frame: InputFrame = {
      deviceId: this.id,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp,
      source: this.source,
      actions: {
        "hand.openPalm": signals.gestures.openPalm,
        "hand.fist": signals.gestures.fist,
        "hand.pinch": signals.gestures.pinch,
        "hand.point": signals.gestures.point,
        "hand.twoFingers": signals.gestures.twoFingers,
        "hand.grab": signals.gestures.grab,
        "hand.swipeLeft": activated.has("swipeLeft"),
        "hand.swipeRight": activated.has("swipeRight"),
        "hand.circle": activated.has("circle"),
        "spell.cast.shield": activated.has("openPalm"),
        "spell.cast.grab": activated.has("pinch"),
        "spell.cast.projectile": activated.has("twoFingers"),
        "spell.cast.charge": activated.has("fist"),
        "spell.cast.blade": activated.has("swipeLeft") || activated.has("swipeRight"),
        "spell.cast.vortex": activated.has("circle"),
        "swarm.select": signals.gestures.point || activated.has("pinch"),
        "swarm.ability.pulse": activated.has("openPalm"),
        "swarm.ability.recall": activated.has("fist"),
      },
      axes: { handConfidence: signals.confidence, swipeDirection },
      vectors: {
        hand: { x: signals.palm.x * 2 - 1, y: signals.palm.y * 2 - 1 },
        aim: { x: signals.pointer.x * 2 - 1, y: signals.pointer.y * 2 - 1 },
        "swarm.command": { x: signals.pointer.x * 2 - 1, y: signals.pointer.y * 2 - 1 },
        gesture: { x: swipeDirection, y: 0 },
      },
      poses,
    };
    this.emit?.(frame);
    this.onDiagnostics?.({ rawHands: cloneHands(rawHands), hands: cloneHands(hands), signals, frame, inferenceMs });
    return frame;
  }
}

export interface PoseVisionBackend {
  initialize(): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number): PoseLandmark[] | undefined;
  close(): void;
}

export interface MediaPipePoseBackendOptions {
  wasmRoot?: string;
  modelPath?: string;
  minConfidence?: number;
  /** How many people to track at once. One was hardcoded, which ruled out playing together. */
  maxPeople?: number;
  /**
   * Try the GPU delegate first. Inference on the CPU is the single biggest reason tracking felt
   * unreliable — it is the difference between following a movement and sampling it.
   */
  preferGpu?: boolean;
}

export class MediaPipePoseBackend implements PoseVisionBackend {
  private readonly options: Required<MediaPipePoseBackendOptions>;
  private landmarker?: import("@mediapipe/tasks-vision").PoseLandmarker;
  private lastTimestamp = -1;

  constructor(options: MediaPipePoseBackendOptions = {}) {
    this.options = {
      wasmRoot: options.wasmRoot ?? "/mediapipe/wasm",
      modelPath: options.modelPath ?? "/models/pose_landmarker_lite.task",
      minConfidence: options.minConfidence ?? 0.55,
      maxPeople: Math.max(1, Math.min(4, Math.round(options.maxPeople ?? 1))),
      preferGpu: options.preferGpu ?? true,
    };
  }

  async initialize() {
    if (this.landmarker) return;
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(this.options.wasmRoot, false);
    /*
     * GPU first, CPU if it will not start. A blocklisted driver fails at creation rather than at
     * capability-detection time, so the only reliable test is to try — and falling back silently is
     * right here, because the alternative is no tracking at all.
     */
    const create = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.options.modelPath, delegate },
      runningMode: "VIDEO",
      numPoses: this.options.maxPeople,
      minPoseDetectionConfidence: this.options.minConfidence,
      minPosePresenceConfidence: this.options.minConfidence,
      minTrackingConfidence: this.options.minConfidence,
      outputSegmentationMasks: false,
    });
    try {
      this.landmarker = this.options.preferGpu ? await create("GPU") : await create("CPU");
    } catch {
      this.landmarker = await create("CPU");
    }
  }

  detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.landmarker) return undefined;
    const safeTimestamp = Math.max(this.lastTimestamp + 1, Math.round(timestamp));
    this.lastTimestamp = safeTimestamp;
    const result = this.landmarker.detectForVideo(video, safeTimestamp);
    const pose = result.landmarks[0];
    const world = result.worldLandmarks?.[0];
    return pose?.map((landmark, index) => ({
      x: landmark.x,
      y: landmark.y,
      z: landmark.z,
      visibility: landmark.visibility ?? 0,
      // Carried through rather than dropped: this is the only metric geometry the model produces.
      world: world?.[index] ? { x: world[index]!.x, y: world[index]!.y, z: world[index]!.z } : undefined,
    }));
  }

  close() {
    this.landmarker?.close();
    this.landmarker = undefined;
    this.lastTimestamp = -1;
  }
}

export interface HandVisionBackend {
  initialize(): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number): TrackedHand[];
  close(): void;
}

export interface MediaPipeHandBackendOptions {
  wasmRoot?: string;
  modelPath?: string;
  /** Try the GPU delegate first, exactly as the pose backend does. */
  preferGpu?: boolean;
  minConfidence?: number;
  maxHands?: number;
}

export class MediaPipeHandBackend implements HandVisionBackend {
  private readonly options: Required<MediaPipeHandBackendOptions>;
  private landmarker?: import("@mediapipe/tasks-vision").HandLandmarker;
  private lastTimestamp = -1;

  constructor(options: MediaPipeHandBackendOptions = {}) {
    this.options = {
      wasmRoot: options.wasmRoot ?? "/mediapipe/wasm",
      modelPath: options.modelPath ?? "/models/hand_landmarker.task",
      minConfidence: options.minConfidence ?? .55,
      maxHands: Math.max(1, Math.min(2, Math.round(options.maxHands ?? 2))),
      preferGpu: options.preferGpu ?? true,
    };
  }

  async initialize() {
    if (this.landmarker) return;
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(this.options.wasmRoot, false);
    this.landmarker = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.options.modelPath, delegate: this.options.preferGpu ? "GPU" : "CPU" },
      runningMode: "VIDEO",
      numHands: this.options.maxHands,
      minHandDetectionConfidence: this.options.minConfidence,
      minHandPresenceConfidence: this.options.minConfidence,
      minTrackingConfidence: this.options.minConfidence,
    });
  }

  detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.landmarker) return [];
    const safeTimestamp = Math.max(this.lastTimestamp + 1, Math.round(timestamp));
    this.lastTimestamp = safeTimestamp;
    const result = this.landmarker.detectForVideo(video, safeTimestamp);
    return result.landmarks.map((landmarks, index): TrackedHand => {
      const category = result.handedness[index]?.[0];
      const label = category?.categoryName.toLowerCase();
      const world = result.worldLandmarks?.[index];
      return {
        handedness: label === "left" || label === "right" ? label : "unknown",
        confidence: category?.score ?? 1,
        landmarks: landmarks.map((landmark, point) => ({
          x: landmark.x,
          y: landmark.y,
          z: landmark.z,
          world: world?.[point] ? { x: world[point]!.x, y: world[point]!.y, z: world[point]!.z } : undefined,
          /*
           * The hand model reports no per-point visibility, so a curled or occluded finger arrives
           * as a confident coordinate. `visibility` here is the model's confidence in the hand as a
           * whole, which is at least honest about what it is: a property of the detection, not of
           * the individual point. It gives callers something to threshold on instead of nothing.
           */
          visibility: category?.score ?? 1,
        })),
      };
    });
  }

  close() {
    this.landmarker?.close();
    this.landmarker = undefined;
    this.lastTimestamp = -1;
  }
}

export interface BrowserCameraAdapterOptions extends PoseInputAdapterOptions {
  video: HTMLVideoElement;
  backend?: PoseVisionBackend;
  maxFps?: number;
  constraints?: MediaTrackConstraints;
  onError?: (error: Error) => void;
}

export class BrowserCameraAdapter extends PoseInputAdapter {
  private readonly video: HTMLVideoElement;
  private readonly backend: PoseVisionBackend;
  private readonly maxFps: number;
  private readonly constraints: MediaTrackConstraints;
  private readonly onError?: (error: Error) => void;
  private stream?: MediaStream;
  private frameHandle?: number;
  private lastInferenceAt = Number.NEGATIVE_INFINITY;
  private lastVideoTime = -1;

  constructor(options: BrowserCameraAdapterOptions) {
    super(options);
    this.video = options.video;
    this.backend = options.backend ?? new MediaPipePoseBackend();
    this.maxFps = Math.max(5, Math.min(30, options.maxFps ?? 24));
    this.constraints = options.constraints ?? { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } };
    this.onError = options.onError;
  }

  override async start(emit: InputFrameListener) {
    super.start(emit);
    if (!isCameraSupported()) throw new Error("Camera access is unavailable in this browser");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: this.constraints, audio: false });
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      await this.backend.initialize();
      this.frameHandle = requestAnimationFrame(this.processFrame);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Unable to start local pose tracking");
      this.onError?.(error);
      this.releaseCamera();
      throw error;
    }
  }

  override stop() {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.backend.close();
    this.releaseCamera();
    super.stop();
  }

  private processFrame = (now: number) => {
    const interval = 1000 / this.maxFps;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime && now - this.lastInferenceAt >= interval) {
      const startedAt = performance.now();
      try {
        const pose = this.backend.detect(this.video, now);
        if (pose) this.ingestPose(pose, now, performance.now() - startedAt);
        this.lastVideoTime = this.video.currentTime;
        this.lastInferenceAt = now;
      } catch (cause) {
        this.onError?.(cause instanceof Error ? cause : new Error("Pose inference failed"));
      }
    }
    this.frameHandle = requestAnimationFrame(this.processFrame);
  };

  private releaseCamera() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.lastInferenceAt = Number.NEGATIVE_INFINITY;
    this.lastVideoTime = -1;
  }
}

export interface BrowserHandAdapterOptions extends HandInputAdapterOptions {
  video: HTMLVideoElement;
  backend?: HandVisionBackend;
  maxFps?: number;
  constraints?: MediaTrackConstraints;
  onError?: (error: Error) => void;
}

export class BrowserHandAdapter extends HandInputAdapter {
  private readonly video: HTMLVideoElement;
  private readonly backend: HandVisionBackend;
  private readonly maxFps: number;
  private readonly constraints: MediaTrackConstraints;
  private readonly onError?: (error: Error) => void;
  private stream?: MediaStream;
  private frameHandle?: number;
  private lastInferenceAt = Number.NEGATIVE_INFINITY;
  private lastVideoTime = -1;

  constructor(options: BrowserHandAdapterOptions) {
    super(options);
    this.video = options.video;
    this.backend = options.backend ?? new MediaPipeHandBackend();
    this.maxFps = Math.max(5, Math.min(30, options.maxFps ?? 24));
    this.constraints = options.constraints ?? { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } };
    this.onError = options.onError;
  }

  override async start(emit: InputFrameListener) {
    super.start(emit);
    if (!isCameraSupported()) throw new Error("Camera access is unavailable in this browser");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: this.constraints, audio: false });
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      await this.backend.initialize();
      this.frameHandle = requestAnimationFrame(this.processFrame);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Unable to start local hand tracking");
      this.onError?.(error);
      this.releaseCamera();
      throw error;
    }
  }

  override stop() {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.backend.close();
    this.releaseCamera();
    super.stop();
  }

  private processFrame = (now: number) => {
    const interval = 1_000 / this.maxFps;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime && now - this.lastInferenceAt >= interval) {
      const startedAt = performance.now();
      try {
        this.ingestHands(this.backend.detect(this.video, now), now, performance.now() - startedAt);
        this.lastVideoTime = this.video.currentTime;
        this.lastInferenceAt = now;
      } catch (cause) {
        this.onError?.(cause instanceof Error ? cause : new Error("Hand inference failed"));
      }
    }
    this.frameHandle = requestAnimationFrame(this.processFrame);
  };

  private releaseCamera() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.lastInferenceAt = Number.NEGATIVE_INFINITY;
    this.lastVideoTime = -1;
  }
}

export function isCameraSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function cloneHands(hands: readonly TrackedHand[]) {
  return hands.map((hand): TrackedHand => ({
    handedness: hand.handedness,
    confidence: hand.confidence,
    landmarks: hand.landmarks.map((landmark) => ({ ...landmark })),
  }));
}

/* ---- Faces ------------------------------------------------------------------------------------ */

export interface FaceVisionBackend {
  initialize(): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number): TrackedFace[];
  close(): void;
}

export interface MediaPipeFaceBackendOptions {
  wasmRoot?: string;
  modelPath?: string;
  minConfidence?: number;
  /** How many faces to track. More than one is what makes a room of people playable. */
  maxFaces?: number;
  preferGpu?: boolean;
}

/**
 * The face backend.
 *
 * `camera-face` has been a declared input source with an icon drawn for it since the input
 * vocabulary was written, and nothing has ever produced one — so no game could react to a blink, a
 * raised brow or an open mouth.
 *
 * Blendshapes and the transformation matrix are both requested, because what a game wants from a
 * face is an expression and a direction, not 478 points. The mesh comes through as well for anything
 * that genuinely needs the geometry.
 */
export class MediaPipeFaceBackend implements FaceVisionBackend {
  private readonly options: Required<MediaPipeFaceBackendOptions>;
  private landmarker?: import("@mediapipe/tasks-vision").FaceLandmarker;
  private lastTimestamp = -1;

  constructor(options: MediaPipeFaceBackendOptions = {}) {
    this.options = {
      wasmRoot: options.wasmRoot ?? "/mediapipe/wasm",
      modelPath: options.modelPath ?? "/models/face_landmarker.task",
      minConfidence: options.minConfidence ?? 0.5,
      maxFaces: Math.max(1, Math.min(4, Math.round(options.maxFaces ?? 1))),
      preferGpu: options.preferGpu ?? true,
    };
  }

  async initialize() {
    if (this.landmarker) return;
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(this.options.wasmRoot, false);
    const create = (delegate: "GPU" | "CPU") => FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.options.modelPath, delegate },
      runningMode: "VIDEO",
      numFaces: this.options.maxFaces,
      // The two outputs a game actually acts on. Without these the result is a point cloud.
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: this.options.minConfidence,
      minFacePresenceConfidence: this.options.minConfidence,
      minTrackingConfidence: this.options.minConfidence,
    });
    // Same reason as the pose backend: a blocklisted driver fails at creation, not at detection.
    try {
      this.landmarker = this.options.preferGpu ? await create("GPU") : await create("CPU");
    } catch {
      this.landmarker = await create("CPU");
    }
  }

  detect(video: HTMLVideoElement, timestamp: number): TrackedFace[] {
    if (!this.landmarker) return [];
    const safeTimestamp = Math.max(this.lastTimestamp + 1, Math.round(timestamp));
    this.lastTimestamp = safeTimestamp;
    const result = this.landmarker.detectForVideo(video, safeTimestamp);
    return result.faceLandmarks.map((landmarks, index): TrackedFace => {
      const blendshapes = result.faceBlendshapes?.[index]?.categories ?? [];
      const matrix = result.facialTransformationMatrixes?.[index]?.data;
      return {
        landmarks: landmarks.map((landmark) => ({ x: landmark.x, y: landmark.y, z: landmark.z })),
        expression: readExpression(blendshapes),
        orientation: matrix ? readOrientation(Array.from(matrix)) : undefined,
        /*
         * The face model reports no detection score of its own, so this is the strongest expression
         * signal present — which is at least a real measurement of "something is happening on a
         * face" rather than a hardcoded 1.
         */
        confidence: blendshapes.length > 0 ? Math.max(...blendshapes.map((shape) => shape.score)) : 0,
      };
    });
  }

  close() {
    this.landmarker?.close();
    this.landmarker = undefined;
    this.lastTimestamp = -1;
  }
}
