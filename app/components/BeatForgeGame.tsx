"use client";

import { BrowserCameraAdapter, type PoseAdapterDiagnostics } from "@101/adapter-camera";
import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Audio101, AudioTimeline101 } from "@101/audio";
import type { GameHost101 } from "@101/game-host";
import { Renderer3D101, THREE } from "@101/render-3d";
import { defineGamePackage } from "@101/sdk";
import FullscreenButton from "@/app/components/FullscreenButton";
import { Icon } from "@/app/components/Icon";
import { describeSources } from "@/app/lib/input-readiness";
import { useGameHost } from "@/app/lib/use-game-host";
import BEATFORGE_INPUT from "@/games/beatforge/input.manifest.json";
import BEATFORGE_MANIFEST from "@/games/beatforge/manifest.json";
import { useEffect, useRef, useState } from "react";
import { beatActionLabel, createBeatForgeGame, type BeatForgeState, type BeatTarget } from "@/games/beatforge/src/game";
import type { BeatAction } from "@/games/beatforge/src/director";
import { BeatCueLookahead } from "@/games/beatforge/src/cue-scheduler";
import { BEATFORGE_ROLES } from "@/games/beatforge/src/roles";

type CameraState = "idle" | "loading" | "active" | "denied" | "error";

interface BeatHud {
  bpm: number;
  score: number;
  combo: number;
  health: number;
  accuracy: number;
  lastJudge: string;
  gameOver: boolean;
  next?: { action: BeatAction; remaining: number };
}

const INITIAL_HUD: BeatHud = { bpm: 112, score: 0, combo: 0, health: 100, accuracy: 100, lastJudge: "FIND THE PULSE", gameOver: false };

/**
 * How far ahead of the strike line a haptic is dispatched.
 *
 * Covers the realtime hop plus the time a phone takes to spin up its vibration motor. Deliberately
 * small: too much lead makes the buzz precede the note visibly, which is worse for a rhythm game
 * than a slightly late one.
 */
const HAPTIC_LEAD_SECONDS = .06;

export default function BeatForgeGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<GameHost101 | null>(null);
  const cameraRef = useRef<BrowserCameraAdapter | null>(null);
  const beatTimelineRef = useRef<AudioTimeline101 | null>(null);
  const audioEnabledRef = useRef(false);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<BeatHud>(INITIAL_HUD);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraConfidence, setCameraConfidence] = useState(0);
  const [cameraError, setCameraError] = useState("");

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  const { linked, readiness } = useGameHost<BeatForgeState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: BEATFORGE_MANIFEST,
      input: BEATFORGE_INPUT,
      controllers: BEATFORGE_ROLES,
      game: createBeatForgeGame(`beatforge-${run}`),
    }),
    adapters: () => [new KeyboardAdapter(), new GamepadAdapter()],
    onReady: ({ context, host }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const audio = createBeatAudio();
      const beatTimeline = createBeatTimeline();
      const beatCues = new BeatCueLookahead(beatTimeline);
      const view = createBeatView(canvas);
      const hapticGroups = new Set<number>();
      let drawHandle = 0;
      let previousCue = 0;
      hostRef.current = host;
      beatTimelineRef.current = beatTimeline;

      const cueTimer = window.setInterval(() => {
        const enabled = audioEnabledRef.current;
        if (enabled && !beatTimeline.running) void beatTimeline.resume();
        if (context.state.gameOver) {
          beatTimeline.cancelAll();
          return;
        }
        beatCues.tick(context.state, enabled);
      }, 25);

      const render = () => {
        const state = context.state;
        view.sync(state);
        for (const target of state.targets) {
          // Fired a little before the note reaches the strike line rather than exactly on it. A
          // haptic still has to cross the link and wake the phone's own vibration motor, so
          // triggering at the instant guarantees the buzz lands after it. The lead is an estimate,
          // not a measurement: the host answers pings but never computes a round trip of its own,
          // so there is no per-device figure to use. Reading one back from the controller would let
          // this adapt per player.
          if (target.targetSeconds > state.elapsed + HAPTIC_LEAD_SECONDS) continue;
          if (hapticGroups.has(target.groupId)) continue;
          hapticGroups.add(target.groupId);
          host.haptic("performer", target.accent ? "impact" : "tap");
        }
        if (state.cueSequence !== previousCue) {
          previousCue = state.cueSequence;
          if (audioEnabledRef.current) audio.play(state.cue === "miss" ? "miss" : state.cue === "perfect" ? "perfect" : "hit", { volume: .72 });
        }
        drawHandle = requestAnimationFrame(render);
      };

      canvas.focus({ preventScroll: true });
      drawHandle = requestAnimationFrame(render);
      const hudTimer = window.setInterval(() => {
        const state = context.state;
        const next = state.targets.filter((target) => target.status === "pending").sort((a, b) => a.targetSeconds - b.targetSeconds)[0];
        setHud({
          bpm: state.bpm,
          score: state.score,
          combo: state.combo,
          health: state.health,
          accuracy: state.accuracy,
          lastJudge: state.lastJudge,
          gameOver: state.gameOver,
          next: next ? { action: next.action, remaining: Math.max(0, next.targetSeconds - state.elapsed) } : undefined,
        });
        host.sendControllerState("performer", {
          BPM: state.bpm,
          COMBO: state.combo,
          ACCURACY: state.accuracy,
          HEALTH: state.health,
        }, {
          message: next ? `NEXT · ${beatActionLabel(next.action)}` : "CHART CLEAR",
          tone: state.health < 30 ? "critical" : state.combo >= 10 ? "warning" : "normal",
        });
      }, 90);

      return () => {
        window.clearInterval(cueTimer);
        window.clearInterval(hudTimer);
        cancelAnimationFrame(drawHandle);
        beatTimeline.dispose();
        audio.unload();
        view.dispose();
        hostRef.current = null;
        cameraRef.current = null;
        if (beatTimelineRef.current === beatTimeline) beatTimelineRef.current = null;
      };
    },
  });

  const enableCamera = async () => {
    const host = hostRef.current;
    const video = videoRef.current;
    if (!host || !video) return;
    setCameraState("loading");
    setCameraError("");
    const adapter = new BrowserCameraAdapter({
      video,
      mirror: true,
      classifier: { autoCalibrationFrames: 18 },
      onDiagnostics: (diagnostics: PoseAdapterDiagnostics) => setCameraConfidence(diagnostics.signals.confidence),
      onError: (error) => setCameraError(error.message),
    });
    cameraRef.current = adapter;
    try {
      await host.inputBus.register(adapter);
      setCameraState("active");
    } catch (cause) {
      await host.inputBus.unregister(adapter);
      cameraRef.current = null;
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setCameraState(denied ? "denied" : "error");
      setCameraError(denied ? "Camera permission was not granted. Keyboard, gamepad, and Link remain active." : cause instanceof Error ? cause.message : "Local movement tracking could not start.");
    }
  };

  const enableAudio = () => {
    void beatTimelineRef.current?.resume();
    setAudioEnabled(true);
    audioEnabledRef.current = true;
  };

  const restart = () => {
    setHud(INITIAL_HUD);
    setCameraState("idle");
    setCameraConfidence(0);
    setRun((value) => value + 1);
  };

  return (
    <section className="beat-page">
      <header className="beat-heading">
        <div><button className="back-button" onClick={onExit}><Icon name="back" size={16} />Back</button><h1>BeatForge <span>101</span></h1></div>
        <div className="beat-stats"><div><span>RUN</span><strong>{run}</strong></div><div><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong></div><div><span>BPM</span><strong>{hud.bpm}</strong></div><div><span>COMBO</span><strong>×{hud.combo}</strong></div><div><span>ACCURACY</span><strong>{hud.accuracy.toFixed(1)}%</strong></div></div>
      </header>

      <div className="beat-arena">
        <div className="beat-statusbar"><FullscreenButton /><span>{linked ? `${linked} LINK PERFORMER` : cameraState === "active" ? `LOCAL POSE · ${Math.round(cameraConfidence * 100)}%` : describeSources(readiness)}</span><b></b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="BeatForge play field. Match left, right, punch, raise, and duck notes with arrow keys, WASD, gamepad, Link motion, or optional body camera." />
        {/* Camera capture is muted, requests no audio, and remains on this device. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className={cameraState === "active" ? "beat-camera-preview active" : "beat-camera-preview"} ref={videoRef} aria-label="Local mirrored movement camera preview" />
        <div className="beat-next"><span>NEXT MOVE</span><strong>{hud.next ? beatActionLabel(hud.next.action) : "READY"}</strong><small>{hud.next ? `${hud.next.remaining.toFixed(2)} S` : "—"}</small></div>
        <div className="beat-judge">{hud.lastJudge}</div>
        <div className="beat-overlay">
          <div className="drift-meter"><span>FLOW</span><i><b style={{ width: `${hud.health}%` }} /></i><strong>{Math.round(hud.health)}%</strong></div>
          <div className="beat-actions">
            {!audioEnabled && <button onClick={enableAudio}>ENABLE AUDIO</button>}
            {cameraState === "active" ? <button onClick={() => cameraRef.current?.calibrateNeutral()}>SET BODY NEUTRAL</button> : <button onClick={enableCamera}>{cameraState === "loading" ? "LOADING MODEL…" : "ENABLE BODY CAMERA"}</button>}
            <button onClick={onConnect}>{linked ? "ADD PERFORMER" : "CONNECT MOTION"}</button>
          </div>
        </div>
        {(cameraState === "denied" || cameraState === "error") && <p className="beat-camera-error">{cameraError}</p>}
        {hud.gameOver && <div className="game-over-panel"><p>FORGE COOLED</p><h2>{hud.score.toLocaleString()}</h2><span>{hud.accuracy.toFixed(1)}% ACCURACY</span><button className="primary-button" onClick={restart}>Play again <Icon name="arrow" size={16} /></button></div>}
      </div>
      <div className="beat-instructions"><span><b>LEFT / RIGHT</b> A D or arrows</span><span><b>PUNCH</b> W / Up / Space</span><span><b>RAISE</b> E / gamepad Y</span><span><b>DUCK</b> S / Down</span></div>
      <p className="beat-privacy"><strong>Optional camera:</strong> body landmarks become punch, raise, duck, and lean actions locally. Video is not uploaded or recorded. Audio cues are generated and bundled by the 101 Audio facade.</p>
    </section>
  );
}

function createBeatAudio() {
  const audio = new Audio101();
  audio.registerTone("hit", { frequency: 520, duration: .08, wave: "triangle", release: .055 });
  audio.registerTone("perfect", { frequency: 820, duration: .11, wave: "sine", release: .08 });
  audio.registerTone("miss", { frequency: 72, duration: .14, wave: "square", release: .1 });
  return audio;
}

function createBeatTimeline() {
  const timeline = new AudioTimeline101();
  timeline.registerTone("beat", { frequency: 130, duration: .055, wave: "square", release: .025, volume: .4 });
  timeline.registerTone("accent", { frequency: 210, duration: .07, wave: "square", release: .035, volume: .55 });
  return timeline;
}

const LANE_X: Record<BeatAction, number> = { left: -3.2, right: 3.2, punch: 0, raise: -1.6, duck: 1.6 };
const LANE_COLOR: Record<BeatAction, number> = { left: 0x50e3ff, right: 0xff5c35, punch: 0xff73c9, raise: 0xb5ff66, duck: 0xf8d96a };

function createBeatView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.renderer.setClearColor(0x08070d, 1);
  view.scene.fog = new THREE.Fog(0x08070d, 16, 90);
  view.camera.position.set(0, 4.2, 9.2);
  view.camera.lookAt(0, .2, -16);
  view.scene.add(new THREE.AmbientLight(0xffffff, 1.3));
  const key = new THREE.DirectionalLight(0xff73c9, 3.2); key.position.set(4, 7, 5); view.scene.add(key);
  const rails: THREE.Mesh[] = [];
  for (const action of Object.keys(LANE_X) as BeatAction[]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(.045, .045, 72), new THREE.MeshBasicMaterial({ color: LANE_COLOR[action], transparent: true, opacity: .34 }));
    rail.position.set(LANE_X[action], 0, -28);
    view.scene.add(rail); rails.push(rail);
  }
  const strike = new THREE.Mesh(new THREE.BoxGeometry(8.2, .08, .16), new THREE.MeshBasicMaterial({ color: 0xf2f1e8 }));
  strike.position.set(0, .03, 2.75); view.scene.add(strike);
  const noteMeshes = new Map<string, THREE.Mesh>();

  const sync = (state: BeatForgeState) => {
    const bounds = canvas.getBoundingClientRect();
    view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    const active = new Set(state.targets.map((target) => target.id));
    for (const target of state.targets) {
      let mesh = noteMeshes.get(target.id);
      if (!mesh) {
        mesh = createBeatMesh(target);
        noteMeshes.set(target.id, mesh);
        view.scene.add(mesh);
      }
      mesh.position.set(LANE_X[target.action], .35, 2.75 - (target.targetSeconds - state.elapsed) * 8.4);
      mesh.rotation.y += .018;
      mesh.rotation.x += .012;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.opacity = target.status === "pending" ? 1 : Math.max(0, 1 - (state.elapsed - (target.judgedAt ?? state.elapsed)) * 2.2);
      material.emissiveIntensity = target.status === "perfect" ? 2.2 : target.status === "miss" ? .15 : .7;
      mesh.scale.setScalar(target.status === "perfect" ? 1.35 : target.status === "miss" ? .7 : 1);
    }
    for (const [id, mesh] of noteMeshes) {
      if (active.has(id)) continue;
      view.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      noteMeshes.delete(id);
    }
    strike.scale.x = 1 + Math.sin(state.elapsed * state.bpm / 60 * Math.PI * 2) * .025;
    view.render();
  };
  return {
    sync,
    dispose() {
      noteMeshes.forEach((mesh) => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); });
      rails.forEach((rail) => { rail.geometry.dispose(); (rail.material as THREE.Material).dispose(); });
      strike.geometry.dispose(); (strike.material as THREE.Material).dispose();
      view.dispose();
    },
  };
}

function createBeatMesh(target: BeatTarget) {
  const geometry = target.action === "punch" ? new THREE.OctahedronGeometry(.42) : target.action === "duck" ? new THREE.BoxGeometry(.78, .28, .6) : new THREE.BoxGeometry(.58, .58, .58);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: LANE_COLOR[target.action], emissive: LANE_COLOR[target.action], emissiveIntensity: .7, metalness: .4, roughness: .28, transparent: true }));
}
