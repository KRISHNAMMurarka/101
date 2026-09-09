"use client";

import GameControllerOverlay from "./GameControllerOverlay";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { PointerAdapter } from "@101/adapter-pointer";
import { Audio101 } from "@101/audio";
import type { GameHost101 } from "@101/game-host";
import { Renderer3D101, THREE } from "@101/render-3d";
import { defineGamePackage } from "@101/sdk";
import type { HandGesture } from "@101/vision";
import GameOverPanel from "./GameOverPanel";
import FullscreenButton from "@/app/components/FullscreenButton";
import { Icon } from "@/app/components/Icon";
import { describeSources } from "@/app/lib/input-readiness";
import { cameraStatusLabel, useCameraInput } from "@/app/lib/use-camera-input";
import { useGameHost } from "@/app/lib/use-game-host";
import SWARMCOMMANDER_INPUT from "@/games/swarmcommander/input.manifest.json";
import SWARMCOMMANDER_MANIFEST from "@/games/swarmcommander/manifest.json";
import { useEffect, useRef, useState } from "react";
import { createSwarmCommanderGame, type CommanderEnemy, type SwarmCommanderState } from "@/games/swarmcommander/src/game";
import { SWARM_COMMANDER_ROLES } from "@/games/swarmcommander/src/roles";

interface SwarmHud { score: number; wave: number; agents: number; selected: number; enemies: number; energy: number; formation: string; modifier: string; event: string; shield: boolean; gameOver: boolean }
/*
 * What the command feed calls the gesture a hand just made.
 *
 * Only the four this game acts on are named. The classifier reports nine, and the other five used to
 * reach the player as their own identifiers — two fingers held up in front of Swarm Commander read
 * "TWOFINGERS", which is the code's name for a shape that commands nothing here.
 */
const COMMAND_GESTURES: Partial<Record<HandGesture, string>> = {
  point: "POINT · COMMAND TARGET",
  pinch: "PINCH · SELECT",
  openPalm: "OPEN PALM · ION PULSE",
  fist: "FIST · RECALL",
};

const INITIAL_HUD: SwarmHud = { score: 0, wave: 1, agents: 168, selected: 0, enemies: 0, energy: 100, formation: "cluster", modifier: "clear", event: "COLLECTIVE ONLINE", shield: false, gameOver: false };

export default function SwarmCommanderGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<GameHost101 | null>(null);
  const audioEnabledRef = useRef(false);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<SwarmHud>(INITIAL_HUD);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [gesture, setGesture] = useState("POINT TO COMMAND");

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
  const camera = useCameraInput({
    kind: "hands",
    sessionId,
    video: videoRef,
    host: hostRef,
    runKey: run,
    classifier: { stableFrames: 3, gestureCooldownMs: 420 },
    // The command feed names the order that was just given, which only the diagnostics carry.
    onDiagnostics: (diagnostics) => {
      const named = diagnostics.signals.activated.map((activated) => COMMAND_GESTURES[activated]).filter(Boolean).at(-1);
      const shown = named ?? (diagnostics.signals.gestures.point ? COMMAND_GESTURES.point : undefined);
      if (shown) setGesture(shown);
    },
  });

  const { linked, readiness, controllerHost } = useGameHost<SwarmCommanderState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: SWARMCOMMANDER_MANIFEST,
      input: SWARMCOMMANDER_INPUT,
      controllers: SWARM_COMMANDER_ROLES,
      game: createSwarmCommanderGame(`swarmcommander-${run}`),
    }),
    adapters: () => {
      const canvas = canvasRef.current;
      return canvas
        ? [new KeyboardAdapter(), new GamepadAdapter(), new PointerAdapter(canvas)]
        : [new KeyboardAdapter(), new GamepadAdapter()];
    },
    onReady: ({ context, host }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const audio = createSwarmAudio();
      const view = createSwarmView(canvas);
      let drawHandle = 0; let previousAction = 0; let previousImpact = 0;
      hostRef.current = host;
      const draw = () => {
        const state = context.state; view.sync(state);
        if (state.actionSequence !== previousAction) { previousAction = state.actionSequence; if (audioEnabledRef.current) audio.play("command", { volume: .5 }); host.haptic("navigator", "tap"); host.haptic("tactician", state.lastEvent.includes("PULSE") ? "impact" : "tap"); }
        if (state.impactSequence !== previousImpact) { previousImpact = state.impactSequence; if (audioEnabledRef.current) audio.play("impact", { volume: .42 }); }
        drawHandle = requestAnimationFrame(draw);
      };
      canvas.focus({ preventScroll: true }); drawHandle = requestAnimationFrame(draw);
      const timer = window.setInterval(() => {
        const state = context.state; const enemies = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0).length;
        setHud({ score: state.score, wave: state.wave, agents: state.agents.length, selected: state.selected, enemies, energy: state.energy, formation: state.formation, modifier: state.modifier, event: state.lastEvent, shield: state.shieldUntil > state.elapsed, gameOver: state.gameOver });
        host.sendControllerState("navigator", { WAVE: state.wave, AGENTS: state.agents.length, ENERGY: state.energy }, { message: state.lastEvent, tone: state.agents.length < 45 ? "critical" : enemies > 10 ? "warning" : "normal" });
        host.sendControllerState("tactician", { FORM: state.formation.toUpperCase(), SELECTED: state.selected || "ALL", ENERGY: state.energy, HOSTILES: enemies }, { message: state.lastEvent, tone: enemies > 10 ? "warning" : "normal" });
      }, 100);
      return () => { window.clearInterval(timer); cancelAnimationFrame(drawHandle); audio.unload(); view.dispose(); hostRef.current = null; };
    },
  });

  /* One table of failures, shared with the setup walkthrough, in place of a private NotAllowedError
     test that fell through to whatever the browser said — "Requested device not found" is a note to
     a developer, not a sentence a player can act on. */

  const restart = () => { setHud(INITIAL_HUD); setRun((value) => value + 1); };

  return (
    <section className="swarm-page">
      <header className="swarm-heading"><div><button className="back-button" onClick={onExit}><Icon name="back" size={16} />Back</button><h1>Swarm Commander <span>101</span></h1></div><div className="swarm-stats"><div><span>RUN</span><strong>{run}</strong></div><div><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong></div><div><span>WAVE</span><strong>{hud.wave}</strong></div><div><span>AGENTS</span><strong>{hud.agents}</strong></div><div><span>HOSTILES</span><strong>{hud.enemies}</strong></div></div></header>

      <GameControllerOverlay binding={controllerHost} runComplete={hud.gameOver}>
        <div className="swarm-arena">
        <div className="swarm-statusbar"><FullscreenButton /><span>{linked ? `${linked} SPECIALIST DEVICES` : camera.state === "on" ? cameraStatusLabel(camera.state, "hands") : describeSources(readiness)}</span><b>{hud.modifier.toUpperCase()}</b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="Swarm Commander. Point with the mouse to command, click to select, move with WASD or arrows, choose formations with one through five, pulse with Q, shield with E, and recall with R." />
        {/* Local camera capture requests no audio and is never recorded or uploaded. */}
        <video className={camera.state === "on" ? "swarm-camera active" : "swarm-camera"} ref={videoRef} playsInline muted aria-hidden={camera.state !== "on"} aria-label="Mirrored camera preview of your hands" />
        <div className="swarm-event"><span>COMMAND FEED</span><strong>{hud.event}</strong><small>{camera.state === "on" ? gesture : `${hud.formation.toUpperCase()} · ${hud.selected || "ALL"} ASSIGNED`}</small></div>
        <div className="swarm-vitals"><SwarmMeter label="ENERGY" value={hud.energy} /><div className={hud.shield ? "swarm-shield active" : "swarm-shield"}><span>COLLECTIVE SHIELD</span><strong>{hud.shield ? "ACTIVE" : "READY"}</strong></div></div>
        <div className="swarm-actions">{!audioEnabled && <button onClick={() => { setAudioEnabled(true); audioEnabledRef.current = true; }}>ENABLE AUDIO</button>}{camera.state !== "on" && <button onClick={camera.enable}>{camera.state === "starting" ? "Starting…" : "Use the camera"}</button>}<button onClick={onConnect}>{linked ? "ADD SPECIALIST" : "CONNECT SPECIALISTS"}</button></div>
        {camera.state === "failed" && <p className="camera-notice">{camera.message} <span>{camera.fix}</span></p>}
        {hud.gameOver && <GameOverPanel title="Collective dispersed" score={hud.score} detail="Final command score" onRestart={restart} />}
      </div>
      </GameControllerOverlay>
      <div className="swarm-instructions"><span><b>COMMAND</b> mouse · right stick · point</span><span><b>SELECT</b> click · A · pinch</span><span><b>FORMATIONS</b> keys 1–5 · tactician</span><span><b>PULSE / SHIELD</b> Q / E</span><span><b>RECALL</b> R · navigator</span></div>
      <p className="swarm-privacy"><strong>Different dimensions, different devices:</strong> a navigator can tilt the shared direction while a tactician sets targets and formations. Hands are optional: the picture is read on this device and never leaves it, and every command also has a key, a stick or a pointer.</p>
    </section>
  );
}

function SwarmMeter({ label, value }: { label: string; value: number }) { return <div className="swarm-meter"><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>; }
function createSwarmAudio() { const audio = new Audio101(); audio.registerTone("command", { frequency: 520, duration: .07, wave: "triangle", release: .05 }); audio.registerTone("impact", { frequency: 92, duration: .1, wave: "square", release: .07 }); return audio; }
const ENEMY_COLORS: Record<CommanderEnemy["type"], number> = { raider: 0xff756a, tank: 0xff5c35, splitter: 0xc98cff, artillery: 0x80a8ff, hive: 0xff355d };

function createSwarmView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" }); view.renderer.setClearColor(0x050706, 1); view.scene.fog = new THREE.Fog(0x050706, 14, 34); view.camera.position.set(0, 13.5, 11.5); view.camera.lookAt(0, 0, 0);
  view.scene.add(new THREE.AmbientLight(0xc7dfd2, 1.1)); const key = new THREE.DirectionalLight(0xf6c15c, 3.4); key.position.set(-4, 10, 5); view.scene.add(key);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 15, 14, 10), new THREE.MeshStandardMaterial({ color: 0x0a0f0d, wireframe: true, emissive: 0x14231d, emissiveIntensity: .6, roughness: .9 })); floor.rotation.x = -Math.PI / 2; view.scene.add(floor);
  const agents = new THREE.InstancedMesh(new THREE.ConeGeometry(.105, .34, 5), new THREE.MeshStandardMaterial({ color: 0xf6c15c, emissive: 0x6b4d13, emissiveIntensity: .8, metalness: .45, roughness: .35 }), 300); agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage); view.scene.add(agents);
  const enemies = new THREE.InstancedMesh(new THREE.OctahedronGeometry(.42, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x351010, emissiveIntensity: .75, roughness: .28, metalness: .5, vertexColors: true }), 128); enemies.instanceMatrix.setUsage(THREE.DynamicDrawUsage); view.scene.add(enemies);
  const target = new THREE.Mesh(new THREE.RingGeometry(.28, .36, 30), new THREE.MeshBasicMaterial({ color: 0x50e3ff, side: THREE.DoubleSide })); target.rotation.x = -Math.PI / 2; target.position.y = .04; view.scene.add(target);
  const shield = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.27, 64), new THREE.MeshBasicMaterial({ color: 0x50e3ff, transparent: true, opacity: 0, side: THREE.DoubleSide })); shield.rotation.x = -Math.PI / 2; shield.position.y = .06; view.scene.add(shield);
  const zones = new Map<string, THREE.Mesh>(); const effects = new Map<number, THREE.Mesh>(); const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3(); const position = new THREE.Vector3();
  const resize = new ResizeObserver(([entry]) => {
    if (entry) view.resize(Math.max(1, entry.contentRect.width), Math.max(1, entry.contentRect.height));
  });
  resize.observe(canvas);

  const sync = (state: SwarmCommanderState) => {
    agents.count = Math.min(300, state.agents.length);
    state.agents.slice(0, agents.count).forEach((agent, index) => { position.set(agent.x, .19, agent.y); quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0), -Math.atan2(agent.vy, agent.vx) - Math.PI / 2); scale.setScalar(agent.selected ? 1.28 : 1); matrix.compose(position, quaternion, scale); agents.setMatrixAt(index, matrix); agents.setColorAt(index, new THREE.Color(agent.selected ? 0x50e3ff : 0xf6c15c)); }); agents.instanceMatrix.needsUpdate = true; if (agents.instanceColor) agents.instanceColor.needsUpdate = true;
    const activeEnemies = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0).slice(0, 128); enemies.count = activeEnemies.length;
    activeEnemies.forEach((enemy, index) => { position.set(enemy.x, enemy.type === "artillery" ? .6 : .4, enemy.y); quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0), state.elapsed * (enemy.type === "hive" ? .25 : .8) + index); const size = enemy.type === "hive" ? 2.2 : enemy.type === "tank" ? 1.35 : enemy.type === "splitter" ? .75 : 1; scale.setScalar(size); matrix.compose(position, quaternion, scale); enemies.setMatrixAt(index, matrix); enemies.setColorAt(index, new THREE.Color(ENEMY_COLORS[enemy.type])); }); enemies.instanceMatrix.needsUpdate = true; if (enemies.instanceColor) enemies.instanceColor.needsUpdate = true;
    const zoneIds = new Set(state.terrain.map((zone) => zone.id));
    for (const zone of state.terrain) { let mesh = zones.get(zone.id); if (!mesh) { const color = zone.type === "repair-zone" ? 0xb5ff66 : zone.type === "slow-field" ? 0x80a8ff : 0xc98cff; mesh = new THREE.Mesh(new THREE.RingGeometry(zone.radius * .88, zone.radius, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .22, side: THREE.DoubleSide })); mesh.rotation.x = -Math.PI / 2; zones.set(zone.id, mesh); view.scene.add(mesh); } mesh.position.set(zone.x, .025, zone.y); mesh.rotation.z += .002; }
    for (const [id, mesh] of zones) if (!zoneIds.has(id)) { disposeMesh(view, mesh); zones.delete(id); }
    const effectIds = new Set(state.effects.map((effect) => effect.id));
    for (const effect of state.effects) { let mesh = effects.get(effect.id); if (!mesh) { const color = effect.kind === "loss" ? 0xff355d : effect.kind === "shield" ? 0x50e3ff : 0xf6c15c; mesh = new THREE.Mesh(new THREE.RingGeometry(.12,.2,32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, side: THREE.DoubleSide })); mesh.rotation.x = -Math.PI / 2; effects.set(effect.id, mesh); view.scene.add(mesh); } const life = Math.max(0,1-(state.elapsed-effect.createdAt)/1.1); mesh.position.set(effect.x,.09,effect.y); mesh.scale.setScalar(1+(1-life)*(effect.kind === "pulse" ? 18 : 7)); (mesh.material as THREE.MeshBasicMaterial).opacity = life * .8; }
    for (const [id, mesh] of effects) if (!effectIds.has(id)) { disposeMesh(view,mesh); effects.delete(id); }
    target.position.set(state.target.x,.05,state.target.y); target.rotation.z = state.elapsed * .9; const center = state.agents.length ? state.agents.reduce((sum,agent) => ({ x: sum.x + agent.x, y: sum.y + agent.y }), {x:0,y:0}) : {x:0,y:0}; if (state.agents.length) { center.x /= state.agents.length; center.y /= state.agents.length; } shield.position.set(center.x,.06,center.y); (shield.material as THREE.MeshBasicMaterial).opacity = state.shieldUntil > state.elapsed ? .75 : 0; shield.scale.setScalar(1.8 + Math.sin(state.elapsed * 7) * .08); view.render();
  };
  return { sync, dispose() { resize.disconnect(); zones.forEach((mesh) => disposeMesh(view,mesh)); effects.forEach((mesh) => disposeMesh(view,mesh)); [floor,target,shield,agents,enemies].forEach((mesh) => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }); view.dispose(); } };
}
function disposeMesh(view: Renderer3D101, mesh: THREE.Mesh) { view.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
