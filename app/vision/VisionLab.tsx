"use client";

import { BrowserCameraAdapter, PoseInputAdapter, type PoseAdapterDiagnostics } from "@101/adapter-camera";
import { InputBus, type InputFrame } from "@101/input";
import { POSE_CONNECTIONS, type PoseLandmark } from "@101/vision";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type VisionState = "idle" | "loading" | "active" | "simulated" | "denied" | "error";

const ACTIONS = ["duck", "jump", "leanLeft", "leanRight", "stepLeft", "stepRight", "armsRaised", "punch"] as const;

export default function VisionLab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busRef = useRef<InputBus | null>(null);
  const adapterRef = useRef<PoseInputAdapter | null>(null);
  const simulationRef = useRef({ x: 0, duck: false, jump: false, arms: false, punch: false });
  const [visionState, setVisionState] = useState<VisionState>("idle");
  const [diagnostics, setDiagnostics] = useState<PoseAdapterDiagnostics | null>(null);
  const [frame, setFrame] = useState<InputFrame | null>(null);
  const [error, setError] = useState("");
  const publishSimulation = useCallback(() => adapterRef.current?.ingestPose(createSimulatedPose(simulationRef.current), performance.now()), []);

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
    drawPose(context, diagnostics?.pose ?? [], bounds.width, bounds.height, diagnostics?.signals.confidence ?? 0);
  }, [diagnostics, visionState]);

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

  const diagnosticsHandler = (next: PoseAdapterDiagnostics) => setDiagnostics(next);
  const emit = (next: InputFrame) => { busRef.current?.accept(next); };

  const enableCamera = async () => {
    const video = videoRef.current;
    if (!video) return;
    setVisionState("loading");
    setError("");
    void adapterRef.current?.stop();
    const adapter = new BrowserCameraAdapter({
      video,
      mirror: true,
      classifier: { autoCalibrationFrames: 18 },
      onDiagnostics: diagnosticsHandler,
      onError: (cause) => setError(cause.message),
    });
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
    const adapter = new PoseInputAdapter({ mirror: false, classifier: { autoCalibrationFrames: 1, smoothing: 1 }, onDiagnostics: diagnosticsHandler });
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

  const activeActions = ACTIONS.filter((action) => frame?.actions[action]);
  return (
    <main className="vision-page">
      <header className="vision-topbar"><Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">VISION LAB</span></Link><span className={`vision-state state-${visionState}`}><i />{visionState.toUpperCase()}</span></header>
      <section className="vision-intro"><p className="eyebrow">Bundled inference · Local landmarks · No recording</p><h1>Your body.<br />One input source.</h1><p>Camera frames stay in this browser. A bundled pose model finds 33 landmarks, then 101 calibration and gesture state turn them into duck, jump, lean, step, arms, and punch events.</p></section>
      <section className="vision-workbench">
        <div className="vision-stage">
          <div className="vision-stagebar"><span>LOCAL POSE PREVIEW</span><code>{diagnostics ? `${Math.round(diagnostics.signals.confidence * 100)}% CONFIDENCE · ${diagnostics.inferenceMs.toFixed(1)} MS` : "CAMERA OFF"}</code></div>
          <div className={`vision-feed ${visionState === "simulated" ? "is-simulated" : ""}`}>
            {/* Camera capture is always muted and requests no audio track. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} aria-label="Local mirrored camera preview" />
            <canvas ref={canvasRef} aria-label="Local pose landmark overlay" />
            {visionState === "idle" && <div className="vision-empty"><span>33</span><p>LANDMARK PIPELINE READY</p></div>}
            {visionState === "loading" && <div className="vision-empty"><span>···</span><p>LOADING LOCAL MODEL</p></div>}
          </div>
          <div className="vision-actions">{ACTIONS.map((action) => <span className={frame?.actions[action] ? "active" : ""} key={action}>{action}</span>)}</div>
        </div>
        <aside className="vision-controls">
          <span className="rail-title">PERMISSION + CALIBRATION <i /></span>
          <button className="primary-button" onClick={enableCamera}>Enable local camera</button>
          <button className="outline-button" onClick={startSimulation}>Use keyboard simulation</button>
          <button className="vision-neutral" disabled={!diagnostics} onClick={() => adapterRef.current?.calibrateNeutral()}>Hold normally · Set neutral</button>
          <div className="vision-readouts"><div><span>BODY X</span><strong>{(frame?.axes?.bodyX ?? 0).toFixed(2)}</strong></div><div><span>CROUCH</span><strong>{(frame?.axes?.crouch ?? 0).toFixed(2)}</strong></div><div><span>LIFT</span><strong>{(frame?.axes?.lift ?? 0).toFixed(2)}</strong></div><div><span>ACTIVE</span><strong>{activeActions.length || "—"}</strong></div></div>
          {visionState === "simulated" && <div className="vision-sim-buttons"><button onClick={() => simulate("left")}>LEAN L</button><button onClick={() => simulate("right")}>LEAN R</button><button onClick={() => simulate("duck")}>DUCK</button><button onClick={() => simulate("jump")}>JUMP</button><button onClick={() => simulate("arms")}>ARMS</button></div>}
          {error && <p className="vision-error">{error}</p>}
          <p className="vision-permission-copy"><strong>Camera:</strong> control games using your body. Frames are processed here and are never uploaded or recorded. Denial leaves keyboard and gamepad controls available.</p>
        </aside>
      </section>
      <section className="vision-pipeline"><span>CAMERA FRAME <b>LOCAL</b></span><i>→</i><span>MEDIAPIPE <b>33 POINTS</b></span><i>→</i><span>101 CLASSIFIER <b>HYSTERESIS</b></span><i>→</i><span>INPUT FRAME <b>{frame?.sequence ?? 0}</b></span></section>
      <p className="vision-keyboard-hint">Simulation: arrows move, Down ducks, Up or Space jumps, and A raises both arms. This path uses the same pose adapter without opening a camera.</p>
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
