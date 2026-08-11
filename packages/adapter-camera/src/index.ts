import type { InputAdapter, InputFrame, InputFrameListener } from "@101/input";
import {
  flattenPose,
  mirrorPose,
  PoseClassifier,
  type PoseClassifierOptions,
  type PoseLandmark,
  type PoseSignals,
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
      actions: { ...signals.actions },
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

export interface PoseVisionBackend {
  initialize(): Promise<void>;
  detect(video: HTMLVideoElement, timestamp: number): PoseLandmark[] | undefined;
  close(): void;
}

export interface MediaPipePoseBackendOptions {
  wasmRoot?: string;
  modelPath?: string;
  minConfidence?: number;
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
    };
  }

  async initialize() {
    if (this.landmarker) return;
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(this.options.wasmRoot, false);
    this.landmarker = await PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: this.options.modelPath, delegate: "CPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: this.options.minConfidence,
      minPosePresenceConfidence: this.options.minConfidence,
      minTrackingConfidence: this.options.minConfidence,
      outputSegmentationMasks: false,
    });
  }

  detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.landmarker) return undefined;
    const safeTimestamp = Math.max(this.lastTimestamp + 1, Math.round(timestamp));
    this.lastTimestamp = safeTimestamp;
    const result = this.landmarker.detectForVideo(video, safeTimestamp);
    const pose = result.landmarks[0];
    return pose?.map((landmark) => ({
      x: landmark.x,
      y: landmark.y,
      z: landmark.z,
      visibility: landmark.visibility ?? 0,
    }));
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

export function isCameraSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}
