"use client";

import { BrowserCameraAdapter, BrowserHandAdapter, HandInputAdapter, PoseInputAdapter, type HandAdapterDiagnostics, type PoseAdapterDiagnostics } from "@101/adapter-camera";
import { InputBus, type InputFrame } from "@101/input";
import { coverTransform, createSimulatedPose, drawHands, drawPose } from "@101/vision";
import { observeCanvasViewport, type CanvasViewport } from "../../components/camera/canvas-viewport";
import { appendInferenceSample, INFERENCE_SAMPLE_WINDOW, summarizeInferenceSamples } from "../../lib/inference-samples";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type VisionState = "idle" | "loading" | "active" | "simulated" | "denied" | "error";
type VisionMode = "body" | "hands";

const BODY_ACTIONS = ["duck", "jump", "leanLeft", "leanRight", "stepLeft", "stepRight", "armsRaised", "punch"] as const;
const HAND_ACTIONS = ["hand.openPalm", "hand.fist", "hand.pinch", "hand.point", "hand.twoFingers", "hand.swipeLeft", "hand.swipeRight", "hand.circle"] as const;

export default function VisionLab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busRef = useRef<InputBus | null>(null);
  const adapterRef = useRef<PoseInputAdapter | HandInputAdapter | null>(null);
  const simulationTimerRef = useRef<number | undefined>(undefined);
  const [inferenceSamples, setInferenceSamples] = useState<readonly number[]>([]);
  const [viewport, setViewport] = useState<CanvasViewport>({ width: 0, height: 0, ratio: 1 });
  const simulationRef = useRef({ x: 0, duck: false, jump: false, arms: false, punch: false });
  const [visionState, setVisionState] = useState<VisionState>("idle");
  const [mode, setMode] = useState<VisionMode>("body");
  const [poseDiagnostics, setPoseDiagnostics] = useState<PoseAdapterDiagnostics | null>(null);
  const [handDiagnostics, setHandDiagnostics] = useState<HandAdapterDiagnostics | null>(null);
  const [frame, setFrame] = useState<InputFrame | null>(null);
  const [error, setError] = useState("");
  const publishSimulation = useCallback(() => {
    if (adapterRef.current instanceof PoseInputAdapter) adapterRef.current.ingestPose(createSimulatedPose(simulationRef.current), performance.now());
  }, []);

  const actions = mode === "body" ? BODY_ACTIONS : HAND_ACTIONS;
  const confidence = mode === "body" ? poseDiagnostics?.signals.confidence ?? 0 : handDiagnostics?.signals.confidence ?? 0;
  const inferenceMs = mode === "body" ? poseDiagnostics?.inferenceMs : handDiagnostics?.inferenceMs;
  const inferenceSummary = summarizeInferenceSamples(inferenceSamples);

  const resetInferenceSamples = useCallback(() => {
    setInferenceSamples([]);
  }, []);
  const recordInferenceSample = useCallback((durationMs: number) => {
    setInferenceSamples((samples) => appendInferenceSample(samples, durationMs));
  }, []);

  const stopCurrent = useCallback(() => {
    if (simulationTimerRef.current !== undefined) window.clearTimeout(simulationTimerRef.current);
    simulationTimerRef.current = undefined;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    void adapter?.stop();
  }, []);

  const selectMode = (next: VisionMode) => {
    if (next === mode) return;
    stopCurrent();
    setPoseDiagnostics(null);
    setHandDiagnostics(null);
    setFrame(null);
    resetInferenceSamples();
    setVisionState("idle");
    setError("");
    setMode(next);
  };

  useEffect(() => {
    const bus = new InputBus();
    busRef.current = bus;
    const unsubscribe = bus.subscribe((next) => setFrame(next));
    return () => {
      unsubscribe();
      stopCurrent();
      void bus.destroy();
      busRef.current = null;
    };
  }, [stopCurrent]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return observeCanvasViewport(canvas, setViewport);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height, ratio } = viewport;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (visionState === "simulated") {
      context.fillStyle = "#0a0a0a";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "rgba(255,255,255,.04)";
      for (let x = 0; x < width; x += 36) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
      for (let y = 0; y < height; y += 36) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    }
    const video = videoRef.current;
    const transform = coverTransform({ streamWidth: visionState === "simulated" ? width : video?.videoWidth ?? 0,
      streamHeight: visionState === "simulated" ? height : video?.videoHeight ?? 0, boxWidth: width, boxHeight: height });
    if (mode === "body") drawPose(context, poseDiagnostics?.pose ?? [], transform, confidence);
    else drawHands(context, handDiagnostics?.hands ?? [], transform);
  }, [confidence, handDiagnostics, mode, poseDiagnostics, viewport, visionState]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (visionState !== "simulated") return;
      if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Space", "KeyA"].includes(event.code)) return;
      event.preventDefault();
      const simulation = simulationRef.current;
      if (event.type === "keydown") {
        simulation.x = event.code === "ArrowLeft" ? -0.72 : event.code === "ArrowRight" ? 0.72 : simulation.x;
        simulation.duck = event.code === "ArrowDown" || simulation.duck;
        simulation.jump = (event.code === "ArrowUp" || event.code === "Space") || simulation.jump;
        simulation.arms = event.code === "KeyA" || simulation.arms;
      } else {
        if (event.code === "ArrowLeft" || event.code === "ArrowRight") simulation.x = 0;
        if (event.code === "ArrowDown") simulation.duck = false;
        if (event.code === "ArrowUp" || event.code === "Space") simulation.jump = false;
        if (event.code === "KeyA") simulation.arms = false;
      }
      publishSimulation();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); };
  }, [publishSimulation, visionState]);

  const emit = (next: InputFrame) => { busRef.current?.accept(next); };

  const enableCamera = async () => {
    const video = videoRef.current;
    if (!video) return;
    stopCurrent();
    resetInferenceSamples();
    setVisionState("loading");
    setError("");
    const recovered = () => {
      if (adapterRef.current !== adapter) return false;
      setVisionState("active");
      setError("");
      return true;
    };
    const onError = (cause: Error) => {
      if (adapterRef.current !== adapter) return;
      setVisionState("error");
      setError(cause.message);
    };
    const adapter = mode === "body"
      ? new BrowserCameraAdapter({ video, mirror: true, classifier: { autoCalibrationFrames: 18 },
        onDiagnostics: (diagnostics) => { if (recovered()) { recordInferenceSample(diagnostics.inferenceMs); setPoseDiagnostics(diagnostics); } }, onError, onCameraLost: onError })
      : new BrowserHandAdapter({ video, mirror: true, classifier: { stableFrames: 3 },
        onDiagnostics: (diagnostics) => { if (recovered()) { recordInferenceSample(diagnostics.inferenceMs); setHandDiagnostics(diagnostics); } }, onError, onCameraLost: onError });
    adapterRef.current = adapter;
    try {
      await adapter.start(emit);
      recovered();
    } catch (cause) {
      if (adapterRef.current !== adapter) return;
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setVisionState(denied ? "denied" : "error");
      setError(denied ? "Camera permission was not granted. The simulator remains available." : cause instanceof Error ? cause.message : "Camera tracking could not start.");
    }
  };

  // This action only exists in body mode. Clear the old adapter before replacing it so pending
  // camera callbacks cannot turn a simulator (or a different mode) back into an active camera.
  const startSimulation = () => {
    stopCurrent();
    resetInferenceSamples();
    const adapter = new PoseInputAdapter({ mirror: false, classifier: { autoCalibrationFrames: 1, smoothing: 1 }, onDiagnostics: setPoseDiagnostics });
    adapter.start(emit);
    adapterRef.current = adapter;
    simulationRef.current = { x: 0, duck: false, jump: false, arms: false, punch: false };
    adapter.ingestPose(createSimulatedPose(simulationRef.current), performance.now());
    setVisionState("simulated");
    setError("");
  };

  const simulate = (action: "left" | "right" | "duck" | "jump" | "arms") => {
    const adapter = adapterRef.current;
    const state = simulationRef.current;
    state.x = action === "left" ? -0.72 : action === "right" ? 0.72 : 0;
    state.duck = action === "duck";
    state.jump = action === "jump";
    state.arms = action === "arms";
    publishSimulation();
    if (simulationTimerRef.current !== undefined) window.clearTimeout(simulationTimerRef.current);
    simulationTimerRef.current = window.setTimeout(() => {
      simulationTimerRef.current = undefined;
      if (adapterRef.current !== adapter) return;
      simulationRef.current = { x: 0, duck: false, jump: false, arms: false, punch: false };
      publishSimulation();
    }, 500);
  };

  const activeActions = actions.filter((action) => frame?.actions[action]);
  return (
    <main className="vision-page">
      <header className="vision-topbar"><Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">VISION LAB</span></Link><span className={`vision-state state-${visionState}`}><i />{visionState.toUpperCase()}</span></header>
      <section className="vision-intro"><p className="eyebrow">Bundled inference · Local landmarks · No recording</p><h1>Your movement.<br />One input source.</h1><p>Switch between the bundled 33-point body model and 21-point hand model. 101 turns local landmarks into stable pose, gesture, swipe, and circle events without sending camera frames anywhere.</p></section>
      <div className="vision-mode-switch" aria-label="Vision pipeline"><button className={mode === "body" ? "active" : ""} onClick={() => selectMode("body")}>BODY · 33 LANDMARKS</button><button className={mode === "hands" ? "active" : ""} onClick={() => selectMode("hands")}>HANDS · 21 LANDMARKS</button></div>
      <section className="vision-workbench">
        <div className="vision-stage">
          <div className="vision-stagebar"><span>LOCAL {mode === "body" ? "POSE" : "HAND"} PREVIEW</span><code>{inferenceMs !== undefined ? `${Math.round(confidence * 100)}% CONFIDENCE · ${inferenceMs.toFixed(1)} MS` : "CAMERA OFF"}</code></div>
          <div className={`vision-feed ${visionState === "simulated" ? "is-simulated" : ""}`}>
            {/* Camera capture is always muted and requests no audio track. */}
            <video ref={videoRef} playsInline muted aria-label={`Mirrored camera preview of your ${mode === "body" ? "body" : "hands"}`} />
            <canvas ref={canvasRef} aria-label={`${mode === "body" ? "Body" : "Hand"} tracking overlay`} />
            {visionState === "idle" && <div className="vision-empty"><span>{mode === "body" ? 33 : 21}</span><p>{mode === "body" ? "BODY" : "HAND"} LANDMARK PIPELINE READY</p></div>}
            {visionState === "loading" && <div className="vision-empty"><span>···</span><p>LOADING LOCAL MODEL</p></div>}
          </div>
          <div className="vision-actions">{actions.map((action) => <span className={frame?.actions[action] ? "active" : ""} key={action}>{action.replace("hand.", "")}</span>)}</div>
        </div>
        <aside className="vision-controls">
          <span className="rail-title">PERMISSION + CALIBRATION <i /></span>
          <button className="primary-button" onClick={enableCamera}>Enable local {mode === "body" ? "body" : "hand"} camera</button>
          {mode === "body" && <button className="outline-button" onClick={startSimulation}>Use keyboard simulation</button>}
          {mode === "body" && <button className="vision-neutral" disabled={!poseDiagnostics} onClick={() => { if (adapterRef.current instanceof PoseInputAdapter) adapterRef.current.calibrateNeutral(); }}>Hold normally · Set neutral</button>}
          {mode === "body" ? <div className="vision-readouts"><div><span>BODY X</span><strong>{(frame?.axes?.bodyX ?? 0).toFixed(2)}</strong></div><div><span>CROUCH</span><strong>{(frame?.axes?.crouch ?? 0).toFixed(2)}</strong></div><div><span>LIFT</span><strong>{(frame?.axes?.lift ?? 0).toFixed(2)}</strong></div><div><span>ACTIVE</span><strong>{activeActions.length || "—"}</strong></div></div> : <div className="vision-readouts"><div><span>POINTER X</span><strong>{(frame?.vectors?.aim?.x ?? 0).toFixed(2)}</strong></div><div><span>POINTER Y</span><strong>{(frame?.vectors?.aim?.y ?? 0).toFixed(2)}</strong></div><div><span>HANDS</span><strong>{handDiagnostics?.hands.length ?? 0}</strong></div><div><span>ACTIVE</span><strong>{activeActions.length || "—"}</strong></div></div>}
          {inferenceSummary && <dl className="vision-inference-summary" aria-label={`Most recent ${inferenceSummary.count} inference timings`}>
            <div><dt>SAMPLES</dt><dd>{inferenceSummary.count} / {INFERENCE_SAMPLE_WINDOW}</dd></div>
            <div><dt>MEAN</dt><dd>{inferenceSummary.meanMs.toFixed(1)} MS</dd></div>
            <div><dt>MEDIAN</dt><dd>{inferenceSummary.medianMs.toFixed(1)} MS</dd></div>
            <div><dt>P95</dt><dd>{inferenceSummary.p95Ms.toFixed(1)} MS</dd></div>
            <div><dt>RANGE</dt><dd>{inferenceSummary.minimumMs.toFixed(1)}–{inferenceSummary.maximumMs.toFixed(1)} MS</dd></div>
          </dl>}
          {visionState === "simulated" && <div className="vision-sim-buttons"><button onClick={() => simulate("left")}>LEAN L</button><button onClick={() => simulate("right")}>LEAN R</button><button onClick={() => simulate("duck")}>DUCK</button><button onClick={() => simulate("jump")}>JUMP</button><button onClick={() => simulate("arms")}>ARMS</button></div>}
          {error && <p className="vision-error">{error}</p>}
          <p className="vision-permission-copy"><strong>Camera:</strong> control games using your {mode === "body" ? "body" : "hands"}. Frames are processed here and are never uploaded or recorded. Denial leaves keyboard and gamepad controls available.</p>
        </aside>
      </section>
      <section className="vision-pipeline"><span>CAMERA FRAME <b>LOCAL</b></span><i>→</i><span>MEDIAPIPE <b>{mode === "body" ? "33 BODY" : "21 HAND"} POINTS</b></span><i>→</i><span>101 CLASSIFIER <b>{mode === "body" ? "HYSTERESIS" : "TEMPORAL"}</b></span><i>→</i><span>INPUT FRAME <b>{frame?.sequence ?? 0}</b></span></section>
      <p className="vision-keyboard-hint">{mode === "body" ? "Simulation: arrows move, Down ducks, Up or Space jumps, and A raises both arms. This path uses the same pose adapter without opening a camera." : "Hand mode stabilizes static poses across frames and recognizes directional swipes and closed circles over time. Spellcaster consumes the same normalized events as phone motion and keyboard input."}</p>
    </main>
  );
}
