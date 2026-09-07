"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  BrowserCameraAdapter,
  BrowserHandAdapter,
  CAMERA_FAILURE_COPY,
  describeCameraFailure,
  type HandAdapterDiagnostics,
  type PoseAdapterDiagnostics,
} from "@101/adapter-camera";
import {
  PLACEMENT_COPY,
  PlacementGate,
  coverTransform,
  describePlacement,
  drawHands,
  drawPose,
  readBodyPlacement,
  readHandPlacement,
  type PlacementReading,
} from "@101/vision";

import { CameraPlacementFigure } from "./CameraPlacementFigure";
import { Icon } from "../Icon";
import { SETUP_COPY, advanceSetup, INITIAL_SETUP, rememberCameraSetup, type SetupState } from "../../lib/camera-setup";
import { saveCameraPlan, type CameraKind } from "../../lib/camera-plan";

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
  onCancel,
}: {
  kind: CameraKind;
  sessionId: string;
  playHref: string;
  needsLegs: boolean;
  onCancel(): void;
}) {
  const [state, dispatch] = useReducer(advanceSetup, kind, INITIAL_SETUP);
  const [reading, setReading] = useState<PlacementReading | undefined>(undefined);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const adapterRef = useRef<BrowserCameraAdapter | BrowserHandAdapter | null>(null);
  const gateRef = useRef(new PlacementGate());
  const lastFrameRef = useRef(0);

  // The reducer is the only thing that decides what happens next, so the frame loop reports what it
  // sees and never sets a step itself.
  const report = useCallback((next: PlacementReading, timestamp: number) => {
    setReading(next);
    const elapsedMs = lastFrameRef.current ? timestamp - lastFrameRef.current : 0;
    lastFrameRef.current = timestamp;
    dispatch({ type: "placement", issue: next.issues[0], elapsedMs });
    if (gateRef.current.update(next, timestamp).passed) dispatch({ type: "placement-held" });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    const onDiagnostics = (diagnostics: PoseAdapterDiagnostics | HandAdapterDiagnostics) => {
      if (cancelled) return;
      const timestamp = performance.now();
      const next = "pose" in diagnostics
        ? readBodyPlacement(diagnostics.pose ?? [], { needsLegs })
        : readHandPlacement(
          (diagnostics.hands ?? []).map((entry) => entry.landmarks),
          video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1,
        );
      report(next, timestamp);
      draw(canvasRef.current, video, diagnostics);
    };

    const adapter = kind === "body"
      ? new BrowserCameraAdapter({ video, mirror: true, onDiagnostics, onError: (cause) => dispatch({ type: "camera-failed", failure: describeCameraFailure(cause).failure }) })
      : new BrowserHandAdapter({ video, mirror: true, onDiagnostics, onError: (cause) => dispatch({ type: "camera-failed", failure: describeCameraFailure(cause).failure }) });
    adapterRef.current = adapter;

    adapter.start(() => {})
      .then(() => {
        if (cancelled) return;
        dispatch({ type: "camera-started" });
        /*
         * A camera that is taken away does not fail a call — the track simply ends. A revoked
         * permission, a closed lid and an unplugged webcam are all this event, and without it they
         * are indistinguishable from a player who walked out of shot: the picture stops changing and
         * the check waits forever for someone who cannot come back.
         */
        for (const track of (video.srcObject as MediaStream | null)?.getTracks() ?? []) {
          track.addEventListener("ended", () => { if (!cancelled) dispatch({ type: "camera-lost" }); });
        }
      })
      .catch((cause) => {
        if (!cancelled) dispatch({ type: "camera-failed", failure: describeCameraFailure(cause).failure });
      });

    return () => {
      cancelled = true;
      void adapter.stop();
      adapterRef.current = null;
    };
  }, [kind, needsLegs, report]);

  // The gesture that closes the flow is the game's own code path, so passing it proves the thing it
  // claims to prove rather than standing in for it.
  useEffect(() => {
    if (state.step !== "confirm" || !reading) return;
    const raised = kind === "body"
      ? reading.regions.arms > 0.6 && reading.issues.length === 0
      : reading.issues.length === 0 && reading.fill > 0.1;
    if (raised) dispatch({ type: "gesture" });
  }, [kind, reading, state.step]);

  useEffect(() => {
    if (state.step !== "ready") return;
    rememberCameraSetup(kind);
    saveCameraPlan(sessionId, { kind, mirror: true });
  }, [kind, sessionId, state.step]);

  const failure = state.failure ? CAMERA_FAILURE_COPY[state.failure] : undefined;
  const placement = reading && !state.failure ? describePlacement(reading, true) : undefined;
  const copy = SETUP_COPY[state.step];

  return (
    <section className="camera-setup" aria-live="polite">
      <StepRail step={state.step} />

      <div className="camera-setup-view">
        <div className="camera-setup-stage" data-showing={state.step === "camera" || state.step === "place" ? "figure" : "picture"}>
          <video ref={videoRef} className="camera-setup-video" playsInline muted />
          <canvas ref={canvasRef} className="camera-setup-canvas" />
          {(state.step === "camera" || state.step === "place") && (
            <Figure kind={kind} issue={placement?.issue} />
          )}
          {(state.step === "check" || state.step === "confirm") && (
            <div className={state.step === "confirm" ? "framing-inset settled" : "framing-inset"} aria-hidden="true" />
          )}
        </div>

        <div className="camera-setup-say">
          <h3>{copy.title}</h3>
          <p>{failure ? failure.problem : placement ? PLACEMENT_COPY[placement.issue].problem : copy.body[kind]}</p>
          <p className="camera-setup-fix">
            {failure ? failure.fix : placement ? PLACEMENT_COPY[placement.issue].fix : ""}
          </p>

          <div className="camera-setup-actions">
            {failure
              ? <button className="primary-button" onClick={() => dispatch({ type: "retry" })}>Try again <Icon name="arrow" size={16} /></button>
              : state.step === "place"
                ? <button className="primary-button" onClick={() => dispatch({ type: "continue" })}>I&apos;m ready <Icon name="arrow" size={16} /></button>
                : state.step === "ready"
                  ? <a className="primary-button" href={playHref}>Start <Icon name="arrow" size={16} /></a>
                  : null}
            {/* A skip is always available. A camera that will not cooperate must never be the reason
                somebody cannot play a game that also takes a keyboard. */}
            <button className="text-button" onClick={() => dispatch({ type: "skip" })}>Skip the check</button>
            <button className="text-button" onClick={onCancel}>Play another way</button>
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
) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  // Only when it actually changed: assigning width or height clears the canvas and reallocates its
  // backing store, and doing that every frame is a full reallocation at frame rate.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const transform = coverTransform({
    streamWidth: video.videoWidth,
    streamHeight: video.videoHeight,
    boxWidth: bounds.width,
    boxHeight: bounds.height,
    // The video element is flipped in CSS, and the adapter has already mirrored the landmarks, so
    // the overlay must not flip them a second time.
    mirrored: false,
  });

  if ("pose" in diagnostics) drawPose(context, diagnostics.pose ?? [], transform, 1);
  else drawHands(context, diagnostics.hands ?? [], transform);
}
