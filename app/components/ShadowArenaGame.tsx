"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Audio101 } from "@101/audio";
import type { GameHost101 } from "@101/game-host";
import { Renderer3D101, THREE } from "@101/render-3d";
import { defineGamePackage } from "@101/sdk";
import FullscreenButton from "@/app/components/FullscreenButton";
import { Icon } from "@/app/components/Icon";
import { describeSources } from "@/app/lib/input-readiness";
import { cameraStatusLabel, useCameraInput } from "@/app/lib/use-camera-input";
import { useGameHost } from "@/app/lib/use-game-host";
import SHADOWARENA_INPUT from "@/games/shadowarena/input.manifest.json";
import SHADOWARENA_MANIFEST from "@/games/shadowarena/manifest.json";
import type { PoseLandmark } from "@101/vision";
import { useEffect, useRef, useState } from "react";
import { createShadowArenaGame, type ShadowArenaState, type ShadowEnemy } from "@/games/shadowarena/src/game";
import { SHADOW_ARENA_ROLES } from "@/games/shadowarena/src/roles";

interface ShadowHud {
  score: number; round: number; combo: number; health: number; focus: number; enemies: number; modifier: string;
  event: string; action: string; gameOver: boolean;
}

const INITIAL_HUD: ShadowHud = { score: 0, round: 1, combo: 0, health: 100, focus: 0, enemies: 0, modifier: "clear", event: "THE ARENA IS LISTENING", action: "READY", gameOver: false };

export default function ShadowArenaGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<GameHost101 | null>(null);
  const poseRef = useRef<PoseLandmark[] | undefined>(undefined);
  const audioEnabledRef = useRef(false);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<ShadowHud>(INITIAL_HUD);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const camera = useCameraInput({
    kind: "body",
    sessionId,
    video: videoRef,
    host: hostRef,
    runKey: run,
    classifier: { autoCalibrationFrames: 18, gestureCooldownMs: 300 },
    // The fighter on screen is drawn from this pose, so the silhouette moves as the player does.
    onDiagnostics: (diagnostics) => { poseRef.current = diagnostics.pose; },
  });

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  const { linked, readiness } = useGameHost<ShadowArenaState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: SHADOWARENA_MANIFEST,
      input: SHADOWARENA_INPUT,
      controllers: SHADOW_ARENA_ROLES,
      game: createShadowArenaGame(`shadowarena-${run}`),
    }),
    adapters: () => [new KeyboardAdapter(), new GamepadAdapter()],
    onReady: ({ context, host }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const audio = createShadowAudio();
      const view = createShadowView(canvas);
      let drawHandle = 0;
      let previousAction = 0;
      let previousImpact = 0;
      hostRef.current = host;
      const draw = () => {
        const state = context.state;
        view.sync(state, poseRef.current);
        if (state.actionSequence !== previousAction) {
          previousAction = state.actionSequence;
          if (audioEnabledRef.current) audio.play(state.lastAction === "SHADOW BURST" ? "special" : "strike", { volume: .65, pan: state.facing * .35 });
          host.haptic("fighter", state.lastAction === "SHADOW BURST" ? "impact" : "tap");
        }
        if (state.impactSequence !== previousImpact) {
          previousImpact = state.impactSequence;
          if (audioEnabledRef.current) audio.play("impact", { volume: .7 });
          host.haptic("fighter", "impact");
        }
        drawHandle = requestAnimationFrame(draw);
      };
      canvas.focus({ preventScroll: true });
      drawHandle = requestAnimationFrame(draw);
      const timer = window.setInterval(() => {
        const state = context.state;
        const enemies = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0).length;
        setHud({ score: state.score, round: state.round, combo: state.combo, health: state.health, focus: state.focus, enemies, modifier: state.modifier, event: state.lastEvent, action: state.lastAction, gameOver: state.gameOver });
        host.sendControllerState("fighter", { ROUND: state.round, HEALTH: state.health, FOCUS: state.focus, CHAIN: state.combo }, {
          message: state.lastEvent, tone: state.health < 30 ? "critical" : enemies > 2 ? "warning" : "normal",
        });
      }, 100);
      return () => {
        window.clearInterval(timer); cancelAnimationFrame(drawHandle); audio.unload(); view.dispose();
        hostRef.current = null; poseRef.current = undefined;
      };
    },
  });

  const restart = () => { setHud(INITIAL_HUD); poseRef.current = undefined; setRun((value) => value + 1); };

  return (
    <section className="shadow-page">
      <header className="shadow-heading">
        <div><button className="back-button" onClick={onExit}><Icon name="back" size={16} />Back</button><h1>Shadow Arena <span>101</span></h1></div>
        <div className="shadow-stats"><div><span>RUN</span><strong>{run}</strong></div><div><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong></div><div><span>ROUND</span><strong>{hud.round}</strong></div><div><span>CHAIN</span><strong>×{hud.combo}</strong></div><div><span>SHADOWS</span><strong>{hud.enemies}</strong></div></div>
      </header>

      <div className="shadow-arena">
        <div className="shadow-statusbar"><FullscreenButton /><span>{linked ? `${linked} LINK FIGHTER` : camera.state === "on" ? cameraStatusLabel(camera.state, "body") : describeSources(readiness)}</span><b>{hud.modifier.toUpperCase()}</b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="Shadow Arena. Move with A/D or arrows, punch with J and K, block with L, jump with W or Space, duck with S, and use Shadow Burst with I." />
        {/* Local camera capture is muted, requests no audio, and is not recorded. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className={camera.state === "on" ? "shadow-camera active" : "shadow-camera"} ref={videoRef} aria-label="Camera preview" />
        <div className="shadow-event"><span>ARENA FEED</span><strong>{hud.event}</strong><small>{hud.action}</small></div>
        <div className="shadow-vitals"><ShadowMeter label="HEALTH" value={hud.health} tone="health" /><ShadowMeter label="FOCUS" value={hud.focus} tone="focus" /></div>
        <div className="shadow-actions">
          {!audioEnabled && <button onClick={() => { setAudioEnabled(true); audioEnabledRef.current = true; }}>ENABLE AUDIO</button>}
          {camera.state === "on" ? <button onClick={camera.recentre}>Stand still, then tap</button> : <button onClick={camera.enable}>{camera.state === "starting" ? "Starting…" : "Use the camera"}</button>}
          <button onClick={onConnect}>{linked ? "ADD FIGHTER" : "CONNECT FIGHTER"}</button>
        </div>
        {camera.state === "failed" && <p className="camera-notice">{camera.message} <span>{camera.fix}</span></p>}
        {hud.gameOver && <div className="game-over-panel"><p>YOUR SHADOW FELL</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL ARENA SCORE</span><button className="primary-button" onClick={restart}>Play again <Icon name="arrow" size={16} /></button></div>}
      </div>
      <div className="shadow-instructions"><span><b>MOVE</b> A/D · arrows · body position</span><span><b>PUNCH</b> J/K · physical punch</span><span><b>BLOCK</b> L · hands together</span><span><b>DUCK / JUMP</b> S/W · body motion</span><span><b>SPECIAL</b> I · raise both arms</span></div>
      <p className="shadow-privacy"><strong>Camera:</strong> fight with your body if you want to. The picture is read on this device and never leaves it — nothing is uploaded, nothing is recorded. Every move also works on the keyboard or a gamepad.</p>
    </section>
  );
}

function ShadowMeter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`shadow-meter shadow-meter-${tone}`}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>;
}

function createShadowAudio() {
  const audio = new Audio101();
  audio.registerTone("strike", { frequency: 690, duration: .065, wave: "square", release: .045 });
  audio.registerTone("impact", { frequency: 78, duration: .13, wave: "square", release: .09 });
  audio.registerTone("special", { frequency: 210, duration: .34, wave: "triangle", release: .22 });
  return audio;
}

const ENEMY_COLOR: Record<ShadowEnemy["type"], number> = { striker: 0xf98b70, brute: 0xff5c35, shade: 0x9e8cff, sentinel: 0xf8d96a };

function createShadowView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.renderer.setClearColor(0x050607, 1); view.scene.fog = new THREE.Fog(0x050607, 12, 40);
  view.camera.position.set(0, 5.1, 13); view.camera.lookAt(0, 1.8, 0);
  view.scene.add(new THREE.AmbientLight(0xffd9cf, .75));
  const back = new THREE.DirectionalLight(0xf98b70, 4); back.position.set(-4, 8, -5); view.scene.add(back);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 10), new THREE.MeshStandardMaterial({ color: 0x0d1011, roughness: .85, metalness: .2 })); floor.rotation.x = -Math.PI / 2; view.scene.add(floor);
  const rings = Array.from({ length: 5 }, (_, index) => { const ring = new THREE.Mesh(new THREE.RingGeometry(2.2 + index * 1.8, 2.23 + index * 1.8, 64), new THREE.MeshBasicMaterial({ color: index % 2 ? 0x2b1b1b : 0x152126, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .01; view.scene.add(ring); return ring; });
  const player = createFighter(0x08090a, 0xf98b70); view.scene.add(player.group);
  const enemies = new Map<string, ReturnType<typeof createFighter>>();
  const effects = new Map<number, THREE.Mesh>();

  const sync = (state: ShadowArenaState, pose?: readonly PoseLandmark[]) => {
    const bounds = canvas.getBoundingClientRect(); view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    player.group.position.set(state.playerX, state.playerY, 0); player.group.rotation.y = state.facing < 0 ? Math.PI : 0;
    if (pose && pose.length >= 29) applyPose(player, pose);
    else animateFighter(player, state.elapsed, state.lastAction);
    const active = new Set(state.enemies.map((enemy) => enemy.id));
    for (const enemy of state.enemies) {
      let fighter = enemies.get(enemy.id);
      if (!fighter) { fighter = createFighter(0x08090a, ENEMY_COLOR[enemy.type]); enemies.set(enemy.id, fighter); view.scene.add(fighter.group); }
      fighter.group.visible = enemy.spawnAt <= state.elapsed;
      fighter.group.position.set(enemy.x, 0, -.15); fighter.group.rotation.y = enemy.x > state.playerX ? Math.PI : 0;
      const warning = enemy.attackAt > state.elapsed && enemy.attackAt - state.elapsed < enemy.windup;
      animateFighter(fighter, state.elapsed + enemy.id.length, warning ? enemy.attack === "low" ? "LOW" : enemy.attack === "heavy" ? "HEAVY" : "PUNCH" : "READY");
      fighter.group.scale.setScalar(enemy.type === "sentinel" ? 1.32 : enemy.type === "brute" ? 1.14 : enemy.type === "shade" ? .88 : 1);
    }
    for (const [id, fighter] of enemies) if (!active.has(id)) { disposeFighter(view, fighter); enemies.delete(id); }
    const effectIds = new Set(state.effects.map((effect) => effect.id));
    for (const effect of state.effects) {
      let mesh = effects.get(effect.id);
      if (!mesh) { mesh = new THREE.Mesh(new THREE.RingGeometry(.12, .2, 32), new THREE.MeshBasicMaterial({ color: effect.kind === "special" ? 0x9e8cff : effect.kind === "block" ? 0x50e3ff : 0xf98b70, transparent: true, opacity: .9, side: THREE.DoubleSide })); effects.set(effect.id, mesh); view.scene.add(mesh); }
      mesh.position.set(effect.x, 1.35, .2); const life = Math.max(0, 1 - (state.elapsed - effect.createdAt) / .9); mesh.scale.setScalar(1 + (1 - life) * (effect.kind === "special" ? 18 : 6)); (mesh.material as THREE.MeshBasicMaterial).opacity = life;
    }
    for (const [id, mesh] of effects) if (!effectIds.has(id)) { view.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); effects.delete(id); }
    back.intensity = state.modifier === "blackout" ? .8 : 4; rings.forEach((ring, index) => { ring.rotation.z = state.elapsed * .02 * (index % 2 ? 1 : -1); });
    view.render();
  };
  return { sync, dispose() { enemies.forEach((fighter) => disposeFighter(view, fighter)); effects.forEach((mesh) => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }); disposeFighter(view, player); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); rings.forEach((ring) => { ring.geometry.dispose(); (ring.material as THREE.Material).dispose(); }); view.dispose(); } };
}

function createFighter(bodyColor: number, edgeColor: number) {
  const material = new THREE.MeshStandardMaterial({ color: bodyColor, emissive: edgeColor, emissiveIntensity: .55, roughness: .55 });
  const group = new THREE.Group();
  const head = new THREE.Mesh(new THREE.SphereGeometry(.27, 16, 12), material); head.position.y = 2.35;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.34, .88, 6, 12), material); torso.position.y = 1.55;
  const limb = () => new THREE.Mesh(new THREE.CapsuleGeometry(.105, .7, 4, 8), material);
  const leftArm = limb(); const rightArm = limb(); const leftLeg = limb(); const rightLeg = limb();
  leftArm.position.set(-.48, 1.65, 0); rightArm.position.set(.48, 1.65, 0); leftLeg.position.set(-.22, .58, 0); rightLeg.position.set(.22, .58, 0);
  group.add(head, torso, leftArm, rightArm, leftLeg, rightLeg);
  return { group, material, head, torso, leftArm, rightArm, leftLeg, rightLeg };
}

function animateFighter(fighter: ReturnType<typeof createFighter>, time: number, action: string) {
  fighter.leftArm.rotation.z = -.2 + Math.sin(time * 4) * .06; fighter.rightArm.rotation.z = .2 - Math.sin(time * 4) * .06;
  if (action.includes("LEFT") || action === "PUNCH") fighter.leftArm.rotation.z = -1.25;
  if (action.includes("RIGHT") || action === "PUNCH") fighter.rightArm.rotation.z = 1.25;
  if (action === "HEAVY") { fighter.leftArm.rotation.z = -1.5; fighter.rightArm.rotation.z = 1.5; }
  if (action === "LOW") { fighter.group.position.y -= .32; }
}

function applyPose(fighter: ReturnType<typeof createFighter>, pose: readonly PoseLandmark[]) {
  const map = (index: number) => ({ x: (pose[index]!.x - .5) * 3.2, y: (1 - pose[index]!.y) * 3 });
  const shoulderL = map(11); const shoulderR = map(12); const wristL = map(15); const wristR = map(16); const hipL = map(23); const hipR = map(24); const ankleL = map(27); const ankleR = map(28);
  placeLimb(fighter.leftArm, shoulderL, wristL); placeLimb(fighter.rightArm, shoulderR, wristR); placeLimb(fighter.leftLeg, hipL, ankleL); placeLimb(fighter.rightLeg, hipR, ankleR);
  fighter.head.position.set((pose[0]!.x - .5) * 3.2, (1 - pose[0]!.y) * 3, 0);
}

function placeLimb(mesh: THREE.Mesh, from: { x: number; y: number }, to: { x: number; y: number }) { mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, 0); mesh.rotation.z = Math.atan2(to.y - from.y, to.x - from.x) - Math.PI / 2; }
function disposeFighter(view: Renderer3D101, fighter: ReturnType<typeof createFighter>) { view.scene.remove(fighter.group); fighter.group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); fighter.material.dispose(); }
