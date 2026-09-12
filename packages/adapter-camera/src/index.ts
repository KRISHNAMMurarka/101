import type { InputAdapter, InputFrame, InputFrameListener } from "@101/input";

import { acquireFirstFrame } from "./acquire.ts";
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
  PersonTracker,
  readDeviceHints,
  recommendQuality,
  resolvePoseModel,
  type TrackedPerson,
  type TrackingQuality,
} from "@101/vision";
import { CameraLostError } from "./errors.ts";
import { cameraConstraints, listCameras } from "./cameras.ts";

export interface PoseAdapterDiagnostics {
  rawPose: PoseLandmark[];
  /** The stable player this frame belongs to; absent for direct single-pose ingestion. */
  person?: TrackedPerson;
  /** Includes temporarily missed people, identified by lastSeen. */
  people: readonly TrackedPerson[];
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
  maxPeople?: number;
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
  readonly tracker: PersonTracker;
  private readonly classifierOptions?: PoseClassifierOptions;
  private readonly peopleClassifiers = new Map<number, PoseClassifier>();
  private previousPeople: readonly TrackedPerson[] = [];

  constructor(options: PoseInputAdapterOptions = {}) {
    this.id = options.deviceId ?? "camera-pose-browser";
    this.playerId = options.playerId ?? "player-1";
    this.mirror = options.mirror ?? true;
    this.classifierOptions = options.classifier;
    this.classifier = new PoseClassifier(options.classifier);
    this.tracker = new PersonTracker({ maxPeople: Math.max(1, Math.min(4, Math.round(options.maxPeople ?? 1))) });
    this.onDiagnostics = options.onDiagnostics;
  }

  start(emit: InputFrameListener) {
    this.emit = emit;
  }

  stop() {
    const timestamp = performance.now();
    for (const person of this.previousPeople) {
      this.createFrame([], [], timestamp, 0, this.peopleClassifiers.get(person.id) ?? this.classifier, person, []);
    }
    if (!this.previousPeople.length && this.lastPose) this.createFrame([], [], timestamp, 0, this.classifier);
    this.emit = undefined;
    this.lastPose = undefined;
    this.previousPeople = [];
    this.peopleClassifiers.clear();
    this.tracker.reset();
    this.classifier.reset();
  }

  /** Every model detection enters the tracker, including empty frames that release held controls. */
  ingestPoses(rawPoses: ReadonlyArray<readonly PoseLandmark[]>, timestamp = performance.now(), inferenceMs = 0) {
    const poses = rawPoses.map((pose) => this.mirror ? mirrorPose(pose) : pose.map((point) => ({ ...point })));
    const people = this.tracker.update(poses, timestamp);
    const frames: InputFrame[] = [];
    for (const prior of this.previousPeople) {
      if (people.some((person) => person.id === prior.id)) continue;
      frames.push(this.createFrame([], [], timestamp, inferenceMs, this.peopleClassifiers.get(prior.id) ?? this.classifier, prior, people));
      this.peopleClassifiers.delete(prior.id);
    }
    for (const person of people) {
      let classifier = this.peopleClassifiers.get(person.id);
      if (!classifier) {
        classifier = person.slot === 1 ? this.classifier : new PoseClassifier(this.classifierOptions);
        classifier.reset();
        this.peopleClassifiers.set(person.id, classifier);
      }
      const index = poses.indexOf(person.landmarks as PoseLandmark[]);
      const pose = index < 0 ? [] : poses[index]!;
      if (person.slot === 1) this.lastPose = pose.length ? pose : undefined;
      frames.push(this.createFrame(index < 0 ? [] : rawPoses[index]!, pose, timestamp, inferenceMs, classifier, person, people));
    }
    this.previousPeople = people;
    return frames;
  }

  ingestPose(rawPose: readonly PoseLandmark[], timestamp = performance.now(), inferenceMs = 0) {
    const pose = this.mirror ? mirrorPose(rawPose) : rawPose.map((landmark) => ({ ...landmark }));
    this.lastPose = pose;
    return this.createFrame(rawPose, pose, timestamp, inferenceMs, this.classifier);
  }

  private createFrame(rawPose: readonly PoseLandmark[], pose: PoseLandmark[], timestamp: number, inferenceMs: number,
    classifier: PoseClassifier, person?: TrackedPerson, people: readonly TrackedPerson[] = []): InputFrame {
    const signals = classifier.process(pose, timestamp);
    const frame: InputFrame = {
      deviceId: person && person.slot > 1 ? `${this.id}.player-${person.slot}` : this.id,
      playerId: person && person.slot > 1 ? `player-${person.slot}` : this.playerId,
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
    this.onDiagnostics?.({ rawPose: rawPose.map((landmark) => ({ ...landmark })), pose, signals, frame, inferenceMs, person, people });
    return frame;
  }

  calibrateNeutral() {
    let calibrated = false;
    for (const person of this.previousPeople) {
      calibrated = (this.peopleClassifiers.get(person.id)?.calibrateNeutral(person.landmarks) ?? false) || calibrated;
    }
    return calibrated || (this.lastPose ? this.classifier.calibrateNeutral(this.lastPose) : false);
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
    if (this.emit) this.ingestHands([], performance.now());
    this.emit = undefined;
    this.classifier.reset();
  }

  ingestHands(rawHands: readonly TrackedHand[], timestamp = performance.now(), inferenceMs = 0, frameAspect = 1) {
    const hands = rawHands.map((hand): TrackedHand => ({
      handedness: hand.handedness,
      confidence: hand.confidence,
      landmarks: this.mirror ? mirrorHand(hand.landmarks) : hand.landmarks.map((landmark) => ({ ...landmark })),
    }));
    const signals = this.classifier.process(hands, timestamp, frameAspect);
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
  detect(video: HTMLVideoElement, timestamp: number): PoseLandmark[][];
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
    if (!this.landmarker) return [];
    const safeTimestamp = Math.max(this.lastTimestamp + 1, Math.round(timestamp));
    this.lastTimestamp = safeTimestamp;
    const result = this.landmarker.detectForVideo(video, safeTimestamp);
    return result.landmarks.map((pose, person) => {
      const world = result.worldLandmarks?.[person];
      return pose.map((landmark, index) => ({
        x: landmark.x, y: landmark.y, z: landmark.z,
        visibility: landmark.visibility ?? 0,
        // The installed web API exposes visibility, but does not expose per-joint presence.
        ...(world?.[index] ? { world: { x: world[index]!.x, y: world[index]!.y, z: world[index]!.z } } : {}),
      }));
    });
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
    const create = (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.options.modelPath, delegate },
      runningMode: "VIDEO",
      numHands: this.options.maxHands,
      minHandDetectionConfidence: this.options.minConfidence,
      minHandPresenceConfidence: this.options.minConfidence,
      minTrackingConfidence: this.options.minConfidence,
    });
    // The same fallback the pose backend has, and for the same reason: a blocklisted driver fails at
    // creation rather than at capability-detection time. Without it, hand tracking threw out of
    // initialize() on exactly the machines where pose tracking quietly carried on working — so the
    // camera looked broken on some games and fine on others, on one computer.
    try {
      this.landmarker = this.options.preferGpu ? await create("GPU") : await create("CPU");
    } catch {
      this.landmarker = await create("CPU");
    }
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
  quality?: TrackingQuality;
  /** Explicitly provisioned assets. Omitted means only models committed to this checkout. */
  availablePoseModels?: ReadonlySet<string>;
  video: HTMLVideoElement;
  backend?: PoseVisionBackend;
  maxFps?: number;
  constraints?: MediaTrackConstraints;
  /** Startup errors reject start(); this callback reports runtime inference failures only. */
  onError?: (error: Error) => void;
  /** A running stream ended unexpectedly. Intentional stop never calls this. */
  onCameraLost?: (error: CameraLostError) => void;
}

export class BrowserCameraAdapter extends PoseInputAdapter {
  readonly trackingProfile: ReturnType<typeof resolvePoseModel>;
  private readonly video: HTMLVideoElement;
  private readonly backend: PoseVisionBackend;
  private readonly maxFps: number;
  private readonly constraints: MediaTrackConstraints;
  private readonly onError?: (error: Error) => void;
  private readonly onCameraLost?: (error: CameraLostError) => void;
  private detachTracks?: () => void;
  private detachDevices?: () => void;
  private cameraAvailable = false;
  private running = false;
  private generation = 0;
  private inferenceFailed = false;
  private initialization?: Promise<void>;
  private stream?: MediaStream;
  private frameHandle?: number;
  private lastInferenceAt = Number.NEGATIVE_INFINITY;
  private lastVideoTime = -1;

  constructor(options: BrowserCameraAdapterOptions) {
    super(options);
    this.video = options.video;
    this.trackingProfile = resolvePoseModel(options.quality ?? recommendQuality(readDeviceHints()), options.availablePoseModels);
    this.backend = options.backend ?? new MediaPipePoseBackend({ modelPath: this.trackingProfile.poseModel, maxPeople: options.maxPeople });
    this.maxFps = Math.max(5, Math.min(30, options.maxFps ?? 24));
    this.constraints = options.constraints ?? cameraConstraints();
    this.onError = options.onError;
    this.onCameraLost = options.onCameraLost;
    this.watchAvailability();
  }

  get available() { return this.cameraAvailable && isCameraSupported(); }

  async refreshAvailability() {
    this.cameraAvailable = isCameraSupported() && (await listCameras()).length > 0;
    return this.cameraAvailable;
  }

  private watchAvailability() {
    void this.refreshAvailability();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const devices = navigator.mediaDevices;
    const changed = () => { void this.refreshAvailability(); };
    devices.addEventListener("devicechange", changed);
    this.detachDevices = () => devices.removeEventListener("devicechange", changed);
  }

  override async start(emit: InputFrameListener) {
    this.stop();
    const generation = this.generation;
    this.watchAvailability();
    super.start(emit);
    try {
      if (!isCameraSupported()) throw new Error("Camera access is unavailable in this browser");
      const stream = await navigator.mediaDevices.getUserMedia({ video: this.constraints, audio: false });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Camera start was cancelled", "AbortError");
      }
      this.stream = stream;
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await acquireFirstFrame(this.video);
      if (generation !== this.generation) throw new DOMException("Camera start was cancelled", "AbortError");
      // A restart waits for any previous initialization to settle before reusing this backend.
      if (this.initialization) await this.initialization.catch(() => undefined);
      if (generation !== this.generation) throw new DOMException("Camera start was cancelled", "AbortError");
      const initialization = this.backend.initialize();
      this.initialization = initialization;
      await initialization;
      if (this.initialization === initialization) this.initialization = undefined;
      if (generation !== this.generation) {
        this.backend.close();
        throw new DOMException("Camera start was cancelled", "AbortError");
      }
      if (stream.getTracks().some((track) => track.readyState === "ended")) throw new CameraLostError();
      this.running = true;
      const ended = () => {
        if (!this.running || this.stream !== stream) return;
        this.stop();
        this.onCameraLost?.(new CameraLostError());
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", ended));
      this.detachTracks = () => stream.getTracks().forEach((track) => track.removeEventListener("ended", ended));
      this.frameHandle = requestAnimationFrame(this.processFrame);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Unable to start local pose tracking");
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  override stop() {
    this.generation++;
    this.running = false;
    this.inferenceFailed = false;
    this.detachDevices?.();
    this.detachDevices = undefined;
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.backend.close();
    this.releaseCamera();
    super.stop();
  }

  private processFrame = (now: number) => {
    if (!this.running) return;
    const generation = this.generation;
    const interval = 1000 / this.maxFps;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime && now - this.lastInferenceAt >= interval) {
      const startedAt = performance.now();
      this.lastVideoTime = this.video.currentTime;
      this.lastInferenceAt = now;
      try {
        const poses = this.backend.detect(this.video, now);
        this.ingestPoses(poses, now, performance.now() - startedAt);
        this.inferenceFailed = false;
      } catch (cause) {
        this.ingestPoses([], now);
        if (!this.inferenceFailed) this.onError?.(cause instanceof Error ? cause : new Error("Pose inference failed"));
        this.inferenceFailed = true;
      }
    }
    if (this.running && generation === this.generation) this.frameHandle = requestAnimationFrame(this.processFrame);
  };

  private releaseCamera() {
    this.detachTracks?.();
    this.detachTracks = undefined;
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
  /** Startup errors reject start(); this callback reports runtime inference failures only. */
  onError?: (error: Error) => void;
  /** A running stream ended unexpectedly. Intentional stop never calls this. */
  onCameraLost?: (error: CameraLostError) => void;
}

export class BrowserHandAdapter extends HandInputAdapter {
  private readonly video: HTMLVideoElement;
  private readonly backend: HandVisionBackend;
  private readonly maxFps: number;
  private readonly constraints: MediaTrackConstraints;
  private readonly onError?: (error: Error) => void;
  private readonly onCameraLost?: (error: CameraLostError) => void;
  private detachTracks?: () => void;
  private detachDevices?: () => void;
  private cameraAvailable = false;
  private running = false;
  private generation = 0;
  private inferenceFailed = false;
  private initialization?: Promise<void>;
  private stream?: MediaStream;
  private frameHandle?: number;
  private lastInferenceAt = Number.NEGATIVE_INFINITY;
  private lastVideoTime = -1;

  constructor(options: BrowserHandAdapterOptions) {
    super(options);
    this.video = options.video;
    this.backend = options.backend ?? new MediaPipeHandBackend();
    this.maxFps = Math.max(5, Math.min(30, options.maxFps ?? 24));
    this.constraints = options.constraints ?? cameraConstraints();
    this.onError = options.onError;
    this.onCameraLost = options.onCameraLost;
    this.watchAvailability();
  }

  get available() { return this.cameraAvailable && isCameraSupported(); }

  async refreshAvailability() {
    this.cameraAvailable = isCameraSupported() && (await listCameras()).length > 0;
    return this.cameraAvailable;
  }

  private watchAvailability() {
    void this.refreshAvailability();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    const devices = navigator.mediaDevices;
    const changed = () => { void this.refreshAvailability(); };
    devices.addEventListener("devicechange", changed);
    this.detachDevices = () => devices.removeEventListener("devicechange", changed);
  }

  override async start(emit: InputFrameListener) {
    this.stop();
    const generation = this.generation;
    this.watchAvailability();
    super.start(emit);
    try {
      if (!isCameraSupported()) throw new Error("Camera access is unavailable in this browser");
      const stream = await navigator.mediaDevices.getUserMedia({ video: this.constraints, audio: false });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Camera start was cancelled", "AbortError");
      }
      this.stream = stream;
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await acquireFirstFrame(this.video);
      if (generation !== this.generation) throw new DOMException("Camera start was cancelled", "AbortError");
      // A restart waits for any previous initialization to settle before reusing this backend.
      if (this.initialization) await this.initialization.catch(() => undefined);
      if (generation !== this.generation) throw new DOMException("Camera start was cancelled", "AbortError");
      const initialization = this.backend.initialize();
      this.initialization = initialization;
      await initialization;
      if (this.initialization === initialization) this.initialization = undefined;
      if (generation !== this.generation) {
        this.backend.close();
        throw new DOMException("Camera start was cancelled", "AbortError");
      }
      if (stream.getTracks().some((track) => track.readyState === "ended")) throw new CameraLostError();
      this.running = true;
      const ended = () => {
        if (!this.running || this.stream !== stream) return;
        this.stop();
        this.onCameraLost?.(new CameraLostError());
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", ended));
      this.detachTracks = () => stream.getTracks().forEach((track) => track.removeEventListener("ended", ended));
      this.frameHandle = requestAnimationFrame(this.processFrame);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Unable to start local hand tracking");
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  override stop() {
    this.generation++;
    this.running = false;
    this.inferenceFailed = false;
    this.detachDevices?.();
    this.detachDevices = undefined;
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.backend.close();
    this.releaseCamera();
    super.stop();
  }

  private processFrame = (now: number) => {
    if (!this.running) return;
    const generation = this.generation;
    const interval = 1_000 / this.maxFps;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime && now - this.lastInferenceAt >= interval) {
      const startedAt = performance.now();
      this.lastVideoTime = this.video.currentTime;
      this.lastInferenceAt = now;
      try {
        this.ingestHands(this.backend.detect(this.video, now), now, performance.now() - startedAt, this.video.videoWidth / this.video.videoHeight);
        this.inferenceFailed = false;
      } catch (cause) {
        this.ingestHands([], now);
        if (!this.inferenceFailed) this.onError?.(cause instanceof Error ? cause : new Error("Hand inference failed"));
        this.inferenceFailed = true;
      }
    }
    if (this.running && generation === this.generation) this.frameHandle = requestAnimationFrame(this.processFrame);
  };

  private releaseCamera() {
    this.detachTracks?.();
    this.detachTracks = undefined;
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

/*
 * Why a camera did not start, in words a player can act on.
 */
export * from "./errors.ts";
export * from "./luma.ts";
export * from "./cameras.ts";

/*
 * Waiting for a camera to produce a picture, with an end to the waiting.
 */
export * from "./acquire.ts";
