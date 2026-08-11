"use client";

import { BrowserCameraAdapter, BrowserHandAdapter, HandInputAdapter, PoseInputAdapter, type HandAdapterDiagnostics, type PoseAdapterDiagnostics } from "@101/adapter-camera";
import { InputBus, type InputFrame } from "@101/input";
import { HAND_CONNECTIONS, POSE_CONNECTIONS, type HandLandmark, type PoseLandmark } from "@101/vision";
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

  const selectMode = (next: VisionMode) => {
    if (next === mode) return;
    void adapterRef.current?.stop();
    adapterRef.current = null;
    setPoseDiagnostics(null);
    setHandDiagnostics(null);
    setFrame(null);
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
      void adapterRef.current?.stop();
      void bus.destroy();
      busRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    if (visionState === "simulated") {
      context.fillStyle = "#090b0b";
      context.fillRect(0, 0, bounds.width, bounds.height);
      context.strokeStyle = "rgba(255,255,255,.04)";
      for (let x = 0; x < bounds.width; x += 36) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, bounds.height); context.stroke(); }
      for (let y = 0; y < bounds.height; y += 36) { context.beginPath(); context.moveTo(0, y); context.lineTo(bounds.width, y); context.stroke(); }
    }
    if (mode === "body") drawPose(context, poseDiagnostics?.pose ?? [], bounds.width, bounds.height, confidence);
    else drawHands(context, handDiagnostics?.hands ?? [], bounds.width, bounds.height, confidence);
  }, [confidence, handDiagnostics, mode, poseDiagnostics, visionState]);

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
    setVisionState("loading");
    setError("");
    void adapterRef.current?.stop();
    const adapter = mode === "body"
      ? new BrowserCameraAdapter({ video, mirror: true, classifier: { autoCalibrationFrames: 18 }, onDiagnostics: setPoseDiagnostics, onError: (cause) => setError(cause.message) })
      : new BrowserHandAdapter({ video, mirror: true, classifier: { stableFrames: 3 }, onDiagnostics: setHandDiagnostics, onError: (cause) => setError(cause.message) });
    adapterRef.current = adapter;
    try {
      await adapter.start(emit);
      setVisionState("active");
    } catch (cause) {
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setVisionState(denied ? "denied" : "error");
      setError(denied ? "Camera permission was not granted. The simulator remains available." : cause instanceof Error ? cause.message : "Camera tracking could not start.");
    }
  };

  const startSimulation = () => {
    void adapterRef.current?.stop();
    if (mode !== "body") return;
    const adapter = new PoseInputAdapter({ mirror: false, classifier: { autoCalibrationFrames: 1, smoothing: 1 }, onDiagnostics: setPoseDiagnostics });
    adapter.start(emit);
    adapterRef.current = adapter;
    simulationRef.current = { x: 0, duck: false, jump: false, arms: false, punch: false };
    adapter.ingestPose(createSimulatedPose(simulationRef.current), performance.now());
    setVisionState("simulated");
    setError("");
  };

  const simulate = (action: "left" | "right" | "duck" | "jump" | "arms") => {
    const state = simulationRef.current;
    state.x = action === "left" ? -0.72 : action === "right" ? 0.72 : 0;
    state.duck = action === "duck";
    state.jump = action === "jump";
    state.arms = action === "arms";
    publishSimulation();
    window.setTimeout(() => {
      if (visionState !== "simulated") return;
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
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} aria-label="Local mirrored camera preview" />
            <canvas ref={canvasRef} aria-label="Local pose landmark overlay" />
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

function drawPose(context: CanvasRenderingContext2D, pose: readonly PoseLandmark[], width: number, height: number, confidence: number) {
  if (pose.length < 29) return;
  context.lineWidth = 3;
  context.strokeStyle = `rgba(80,227,255,${0.35 + confidence * 0.65})`;
  for (const [from, to] of POSE_CONNECTIONS) {
    const a = pose[from]; const b = pose[to];
    if (!a || !b || a.visibility < 0.35 || b.visibility < 0.35) continue;
    context.beginPath(); context.moveTo(a.x * width, a.y * height); context.lineTo(b.x * width, b.y * height); context.stroke();
  }
  for (const landmark of pose) {
    if (landmark.visibility < 0.35) continue;
    context.fillStyle = landmark.visibility > .8 ? "#b5ff66" : "#ff5c35";
    context.beginPath(); context.arc(landmark.x * width, landmark.y * height, 4, 0, Math.PI * 2); context.fill();
  }
}

function drawHands(context: CanvasRenderingContext2D, hands: readonly { landmarks: HandLandmark[]; handedness: string; confidence: number }[], width: number, height: number, confidence: number) {
  for (const hand of hands) {
    if (hand.landmarks.length < 21) continue;
    context.lineWidth = 3;
    context.strokeStyle = `rgba(128,168,255,${0.35 + confidence * 0.65})`;
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = hand.landmarks[from]; const b = hand.landmarks[to];
      if (!a || !b) continue;
      context.beginPath(); context.moveTo(a.x * width, a.y * height); context.lineTo(b.x * width, b.y * height); context.stroke();
    }
    for (const landmark of hand.landmarks) {
      context.fillStyle = hand.handedness === "left" ? "#80a8ff" : "#b5ff66";
      context.beginPath(); context.arc(landmark.x * width, landmark.y * height, 4, 0, Math.PI * 2); context.fill();
    }
  }
}

function createSimulatedPose(state: { x: number; duck: boolean; jump: boolean; arms: boolean; punch: boolean }): PoseLandmark[] {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.98 }));
  const shiftY = state.jump ? -0.08 : 0;
  const upperY = state.duck ? 0.09 : 0;
  const center = 0.5 + state.x * 0.12;
  pose[0] = { x: center, y: 0.15 + shiftY + upperY, z: 0, visibility: .98 };
  pose[11] = { x: center - .1, y: .34 + shiftY + upperY, z: 0, visibility: .98 };
  pose[12] = { x: center + .1, y: .34 + shiftY + upperY, z: 0, visibility: .98 };
  pose[13] = { x: center - .14, y: state.arms ? .24 : .46 + shiftY + upperY, z: 0, visibility: .98 };
  pose[14] = { x: center + .14, y: state.arms ? .24 : .46 + shiftY + upperY, z: 0, visibility: .98 };
  pose[15] = { x: center - .16, y: state.arms ? .14 : .57 + shiftY + upperY, z: 0, visibility: .98 };
  pose[16] = { x: center + .16, y: state.arms ? .14 : .57 + shiftY + upperY, z: 0, visibility: .98 };
  pose[23] = { x: center - .06, y: .59 + shiftY, z: 0, visibility: .98 };
  pose[24] = { x: center + .06, y: .59 + shiftY, z: 0, visibility: .98 };
  pose[25] = { x: center - .05, y: .76 + shiftY, z: 0, visibility: .98 };
  pose[26] = { x: center + .05, y: .76 + shiftY, z: 0, visibility: .98 };
  pose[27] = { x: center - .05, y: .94 + shiftY, z: 0, visibility: .98 };
  pose[28] = { x: center + .05, y: .94 + shiftY, z: 0, visibility: .98 };
  pose[29] = { ...pose[27]!, x: center - .07 };
  pose[30] = { ...pose[28]!, x: center + .07 };
  pose[31] = { ...pose[27]!, x: center - .09 };
  pose[32] = { ...pose[28]!, x: center + .09 };
  return pose;
}
