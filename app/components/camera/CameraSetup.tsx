"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  BrowserCameraAdapter,
  BrowserHandAdapter,
  CAMERA_FAILURE_COPY,
  describeCameraFailure,
  cameraConstraints,
  describeCamera,
  listCameras,
  sampleVideoLuma,
  type HandAdapterDiagnostics,
  type PoseAdapterDiagnostics,
} from "@101/adapter-camera";
import {
  PLACEMENT_COPY,
  PLACEMENT_LIMITS,
  PlacementGate,
  coverTransform,
  describePlacement,
  drawHands,
  drawPose,
  drawTargetFrame,
  targetFrame,
  type LightSample,
  readBodyPlacement,
  readHandPlacement,
  type PlacementReading,
} from "@101/vision";

import { CameraPlacementFigure } from "./CameraPlacementFigure";
import { Icon } from "../Icon";
import { CONFIRM_ALTERNATIVE_MS, SETUP_COPY, advanceSetup, confirmsCameraGesture, INITIAL_SETUP, rememberCameraSetup, type SetupState } from "../../lib/camera-setup";
import { clearCameraPlan, saveCameraPlan, type CameraKind } from "../../lib/camera-plan";
import { observeCanvasViewport, type CanvasViewport } from "./canvas-viewport";

/**
 * Setting up a camera, in four beats: which camera, where to stand, does it work, do something so
 * we both know it works.
 *
 * The decisions all live outside this file — the flow in camera-setup.ts, the verdict and its words
 * in @101/vision, the failure words in @101/adapter-camera — because none of them can be tested
 * here. What is left is what genuinely needs a browser: acquiring a camera, drawing on a canvas at
 * frame rate, and tearing both down.
 *
 * Nothing in here reports a number. The player is told what to do, never how confident anything is.
 */
export default function CameraSetup({
  kind,
  sessionId,
  playHref,
  needsLegs,
  maxPeople = 1,
  onCancel,
}: {
  kind: CameraKind;
  sessionId: string;
  playHref: string;
  needsLegs: boolean;
  maxPeople?: number;
  onCancel(): void;
}) {
  const [state, dispatch] = useReducer(advanceSetup, kind, INITIAL_SETUP);
  const [reading, setReading] = useState<PlacementReading | undefined>(undefined);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const [slowAttempt, setSlowAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const adapterRef = useRef<BrowserCameraAdapter | BrowserHandAdapter | null>(null);
  const gateRef = useRef(new PlacementGate());
  const gatePassedRef = useRef(false);
  const lastFrameRef = useRef(0);
  const armsRaisedRef = useRef(false);
  const stateRef = useRef(state);
  const diagnosticsRef = useRef<PoseAdapterDiagnostics | HandAdapterDiagnostics | undefined>(undefined);
  const viewportRef = useRef<CanvasViewport>({ width: 0, height: 0, ratio: 1 });
  const completedPlanRef = useRef<{ deviceId?: string; poseModel?: string }>({});
  const people = Number.isFinite(maxPeople) ? Math.max(1, Math.min(4, Math.round(maxPeople))) : 1;

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [state.step]);
  useEffect(() => {
    if (!state.attempt || cameraReady || state.failure) return;
    const timer = window.setTimeout(() => setSlowAttempt(state.attempt), 8_000);
    return () => window.clearTimeout(timer);
  }, [state.attempt, cameraReady, state.failure]);
  useEffect(() => {
    gateRef.current.reset();
    gatePassedRef.current = false;
    lastFrameRef.current = 0;
  }, [state.step, state.attempt]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void listCameras().then((devices) => { if (!cancelled) setCameras(devices); }); };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener("devicechange", refresh); };
  }, []);

  const redraw = useCallback(() => {
    const video = videoRef.current;
    const diagnostics = diagnosticsRef.current;
    if (video && diagnostics) draw(canvasRef.current, video, diagnostics, viewportRef.current, stateRef.current.step);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return observeCanvasViewport(canvas, (viewport) => { viewportRef.current = viewport; redraw(); });
  }, [redraw]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || state.attempt === 0) return;
    let cancelled = false;
    let light: LightSample | undefined;
    let lastLightAt = Number.NEGATIVE_INFINITY;
    const lumaCanvas = document.createElement("canvas");
    const onDiagnostics = (diagnostics: PoseAdapterDiagnostics | HandAdapterDiagnostics) => {
      if (cancelled) return;
      // A multi-person adapter reports one frame per identity. The check follows the first person;
      // other people remain available to the game's own multi-person input path after setup.
      if ("pose" in diagnostics && diagnostics.person && diagnostics.people[0]?.id !== diagnostics.person.id) return;
      diagnosticsRef.current = diagnostics;
      const timestamp = performance.now();
      if (timestamp - lastLightAt >= 250) {
        light = sampleVideoLuma(video, lumaCanvas);
        lastLightAt = timestamp;
      }
      const next = "pose" in diagnostics
        ? readBodyPlacement(diagnostics.pose, { needsLegs, light })
        : readHandPlacement(diagnostics.hands.map((entry) => entry.landmarks),
          video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1, light);
      setReading(next);
      const elapsedMs = lastFrameRef.current ? timestamp - lastFrameRef.current : 0;
      lastFrameRef.current = timestamp;
      dispatch({ type: "placement", issue: next.issues[0], elapsedMs });
      const current = stateRef.current;
      if (current.step === "check" && !gatePassedRef.current && gateRef.current.update(next, timestamp).passed) {
        gatePassedRef.current = true;
        dispatch({ type: "placement-held" });
      }
      const raised = "combat" in diagnostics.signals && diagnostics.signals.actions.armsRaised;
      if (current.step === "confirm" && !current.failure && next.issues.length === 0
        && confirmsCameraGesture(diagnostics.signals, armsRaisedRef.current, current.confirmForMs >= CONFIRM_ALTERNATIVE_MS)) {
        dispatch({ type: "gesture" });
      }
      armsRaisedRef.current = raised;
      redraw();
    };
    const fail = (cause: unknown) => {
      if (cancelled) return;
      setCameraReady(false);
      dispatch({ type: "camera-failed", failure: describeCameraFailure(cause).failure });
      clearCameraPlan(sessionId);
    };
    const common = { video, mirror: true, constraints: cameraConstraints(deviceId), onError: fail, onCameraLost: fail };
    const adapter = kind === "body"
      ? new BrowserCameraAdapter({ ...common, maxPeople: people, onDiagnostics })
      : new BrowserHandAdapter({ ...common, onDiagnostics });
    adapterRef.current = adapter;
    adapter.start(() => {}).then(async () => {
      if (cancelled) return;
      const devices = await listCameras();
      if (cancelled) return;
      setCameras(devices);
      const selected = (video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;
      completedPlanRef.current = {
        ...(selected ? { deviceId: selected } : deviceId ? { deviceId } : {}),
        ...(adapter instanceof BrowserCameraAdapter ? { poseModel: adapter.trackingProfile.poseModel } : {}),
      };
      setCameraReady(true);
    }).catch(fail);
    return () => {
      cancelled = true;
      void adapter.stop();
      if (adapterRef.current === adapter) adapterRef.current = null;
    };
  }, [deviceId, kind, needsLegs, people, redraw, sessionId, state.attempt]);

  useEffect(() => {
    if (state.step !== "confirm") return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => dispatch({ type: "confirm-time", elapsedMs: performance.now() - startedAt }), CONFIRM_ALTERNATIVE_MS);
    return () => window.clearTimeout(timer);
  }, [state.step]);

  useEffect(() => {
    if (state.step !== "ready" || state.skipped || state.failure) return;
    rememberCameraSetup(kind);
    saveCameraPlan(sessionId, { kind, mirror: true, ...completedPlanRef.current, ...(kind === "body" ? { maxPeople: people } : {}) });
  }, [kind, people, sessionId, state.failure, state.skipped, state.step]);

  const retry = () => {
    setCameraReady(false);
    setReading(undefined);
    armsRaisedRef.current = false;
    dispatch({ type: "retry" });
  };
  const chooseAnotherWay = () => {
    clearCameraPlan(sessionId);
    void adapterRef.current?.stop();
    onCancel();
  };

  const slowStart = state.attempt > 0 && slowAttempt === state.attempt && !cameraReady && !state.failure;
  const failure = state.failure ? CAMERA_FAILURE_COPY[state.failure] : undefined;
  const placement = reading && !state.failure && (state.step === "place" || state.step === "check") ? describePlacement(reading, true) : undefined;
  const copy = SETUP_COPY[state.step];

  return (
    <section className="camera-setup" aria-live="polite">
      <StepRail step={state.step} />

      <div className="camera-setup-view">
        <div className="camera-setup-stage" data-showing={(state.step === "camera" && !cameraReady) || state.step === "place" ? "figure" : "picture"}>
          {/* Muted camera capture contains no recorded audio to caption. */}
          <video ref={videoRef} className="camera-setup-video" playsInline muted aria-label={kind === "body" ? "Mirrored camera preview of your body" : "Mirrored camera preview of your hands"} />
          <canvas ref={canvasRef} className="camera-setup-canvas" aria-hidden="true" />
          {((state.step === "camera" && !cameraReady) || state.step === "place") && (
            <Figure kind={kind} issue={placement?.issue} />
          )}
        </div>

        <div className="camera-setup-say">
          <h3 ref={headingRef} tabIndex={-1}>{copy.title}</h3>
          <p>{failure ? failure.problem : placement ? PLACEMENT_COPY[placement.issue].problem : copy.body[kind]}</p>
          {state.step === "confirm" && kind === "body" && state.confirmForMs >= CONFIRM_ALTERNATIVE_MS && <p>{SETUP_COPY.confirm.alternative}</p>}
          <p className="camera-setup-fix">
            {failure ? failure.fix : placement ? PLACEMENT_COPY[placement.issue].fix : ""}
          </p>
          {slowStart && <p role="status">Still opening. You can wait, or play another way.</p>}

          {state.step === "camera" && cameras.length > 1 && (
            <label>
              <span>Choose a camera</span>
              <select value={deviceId} onChange={(event) => { setDeviceId(event.currentTarget.value); if (state.attempt > 0) retry(); }}>
                <option value="">Default camera</option>
                {cameras.map((camera, index) => <option key={camera.deviceId || index} value={camera.deviceId}>{describeCamera(camera)}{!camera.label ? ` ${index + 1}` : ""}</option>)}
              </select>
            </label>
          )}
          <div className="camera-setup-actions">
            {failure
              ? <button className="primary-button" onClick={retry}>Try again <Icon name="arrow" size={16} /></button>
              : state.step === "camera"
                ? <button className="primary-button" disabled={state.attempt > 0 && !cameraReady} onClick={cameraReady ? () => dispatch({ type: "camera-started" }) : retry}>{cameraReady ? "Use this camera" : state.attempt > 0 ? "Starting the camera…" : "Turn on the camera"} <Icon name="arrow" size={16} /></button>
              : state.step === "place"
                ? <button className="primary-button" onClick={() => dispatch({ type: "continue" })}>I&apos;m ready <Icon name="arrow" size={16} /></button>
                : state.step === "ready"
                  ? <a className="primary-button" href={playHref}>Start <Icon name="arrow" size={16} /></a>
                  : null}
            {/* A skip is always available. A camera that will not cooperate must never be the reason
                somebody cannot play a game that also takes a keyboard. */}
            <button className="text-button" onClick={() => { dispatch({ type: "skip" }); chooseAnotherWay(); }}>Skip the check</button>
            <button className="text-button" onClick={chooseAnotherWay}>Play another way</button>
          </div>
        </div>
      </div>
    </section>
  );
}

const STEPS = ["camera", "place", "check", "confirm"] as const;

function StepRail({ step }: { step: SetupState["step"] }) {
  const reached = step === "ready" ? STEPS.length : STEPS.indexOf(step as (typeof STEPS)[number]);
  return (
    <ol className="camera-setup-rail">
      {STEPS.map((name, index) => (
        <li key={name} data-state={index < reached ? "done" : index === reached ? "now" : "next"}>
          <i aria-hidden="true" />
          {SETUP_COPY[name].title}
        </li>
      ))}
    </ol>
  );
}

/** The drawing answers the check: if the player is too far, it shows them closer. */
function Figure({ kind, issue }: { kind: CameraKind; issue: string | undefined }) {
  const nudge = issue === "too-far" ? "closer" : issue === "too-close" ? "back" : issue === "cut-off-legs" ? "lower-lid" : undefined;
  return <CameraPlacementFigure kind={kind} nudge={nudge} />;
}

/** Draw the body over the picture it was found in. See coverTransform for why this is not trivial. */
function draw(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement,
  diagnostics: PoseAdapterDiagnostics | HandAdapterDiagnostics,
  viewport: CanvasViewport,
  step: SetupState["step"],
) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const { width, height, ratio } = viewport;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const box = {
    streamWidth: video.videoWidth,
    streamHeight: video.videoHeight,
    boxWidth: width,
    boxHeight: height,
    // The video element is flipped in CSS, and the adapter has already mirrored the landmarks, so
    // the overlay must not flip them a second time.
    mirrored: false,
  };
  const transform = coverTransform(box);
  if (step === "check" || step === "confirm") {
    drawTargetFrame(context, targetFrame(transform, box, PLACEMENT_LIMITS.minFill, PLACEMENT_LIMITS.maxFill), step === "confirm");
  }

  if ("pose" in diagnostics) drawPose(context, diagnostics.pose ?? [], transform, 1);
  else drawHands(context, diagnostics.hands ?? [], transform);
}
