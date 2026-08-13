"use client";

import { BrowserHandAdapter, type HandAdapterDiagnostics } from "@101/adapter-camera";
import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Audio101 } from "@101/audio";
import { Engine101 } from "@101/core";
import { BroadcastChannelTransport } from "@101/protocol";
import { Renderer3D101, THREE } from "@101/render-3d";
import { LocalSession, SessionHost } from "@101/session";
import { useEffect, useRef, useState } from "react";
import { createSpellcasterGame, type ArcaneEnemy, type SpellcasterState } from "@/games/spellcaster/src/game";
import type { SpellId } from "@/games/spellcaster/src/director";
import { SPELLCASTER_ROLES } from "@/games/spellcaster/src/roles";

type CameraState = "idle" | "loading" | "active" | "denied" | "error";

interface SpellHud {
  score: number;
  combo: number;
  health: number;
  mana: number;
  charge: number;
  wave: number;
  enemies: number;
  shield: boolean;
  event: string;
  lastCast: SpellId;
  gameOver: boolean;
}

const INITIAL_HUD: SpellHud = { score: 0, combo: 0, health: 100, mana: 100, charge: 0, wave: 1, enemies: 0, shield: false, event: "THE VEIL IS OPENING", lastCast: "projectile", gameOver: false };

export default function SpellcasterGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<Engine101<SpellcasterState> | null>(null);
  const cameraRef = useRef<BrowserHandAdapter | null>(null);
  const audioEnabledRef = useRef(false);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<SpellHud>(INITIAL_HUD);
  const [linked, setLinked] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraConfidence, setCameraConfidence] = useState(0);
  const [gesture, setGesture] = useState("SHOW A HAND");
  const [cameraError, setCameraError] = useState("");

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine101(createSpellcasterGame(`spellcaster-${run}`));
    const keyboard = new KeyboardAdapter();
    const gamepad = new GamepadAdapter();
    const audio = createSpellAudio();
    const host = new SessionHost({
      gameId: "spellcaster",
      roles: SPELLCASTER_ROLES,
      transport: new BroadcastChannelTransport(sessionId),
      session: new LocalSession(sessionId),
      onFrame: (frame) => engine.inputBus.accept(frame),
      onDeviceReset: (deviceId) => engine.inputBus.removeDevice(deviceId),
      onChange: (snapshot) => setLinked(snapshot.assignments.length),
    });
    const view = createSpellView(canvas);
    let drawHandle = 0;
    let previousCast = 0;
    let previousImpact = 0;
    engineRef.current = engine;

    const render = () => {
      const state = engine.context.state;
      view.sync(state);
      if (state.castSequence !== previousCast) {
        previousCast = state.castSequence;
        if (audioEnabledRef.current) audio.play(state.lastCast, { volume: .62, pan: state.aim.x * .5 });
        host.haptic("sorcerer", state.lastCast === "vortex" || state.lastCast === "blade" ? "impact" : "tap");
      }
      if (state.impactSequence !== previousImpact) {
        previousImpact = state.impactSequence;
        if (audioEnabledRef.current) audio.play("impact", { volume: .58 });
      }
      drawHandle = requestAnimationFrame(render);
    };

    void engine.inputBus.register(keyboard);
    void engine.inputBus.register(gamepad);
    void host.start();
    void engine.start();
    canvas.focus();
    drawHandle = requestAnimationFrame(render);
    const hudTimer = window.setInterval(() => {
      const state = engine.context.state;
      const activeEnemies = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0).length;
      const nextHud: SpellHud = {
        score: state.score,
        combo: state.combo,
        health: state.health,
        mana: state.mana,
        charge: state.charge,
        wave: state.wave,
        enemies: activeEnemies,
        shield: state.shieldUntil > state.elapsed,
        event: state.lastEvent,
        lastCast: state.lastCast,
        gameOver: state.gameOver,
      };
      setHud(nextHud);
      host.sendControllerState("sorcerer", {
        WAVE: state.wave,
        MANA: state.mana,
        HEALTH: state.health,
        COMBO: state.combo,
      }, {
        message: state.lastEvent,
        tone: state.health < 30 ? "critical" : state.mana < 20 ? "warning" : "normal",
      });
    }, 100);

    return () => {
      window.clearInterval(hudTimer);
      cancelAnimationFrame(drawHandle);
      void host.stop();
      engine.stop();
      void engine.inputBus.destroy();
      audio.unload();
      view.dispose();
      engineRef.current = null;
      cameraRef.current = null;
    };
  }, [run, sessionId]);

  const enableCamera = async () => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video) return;
    setCameraState("loading");
    setCameraError("");
    const adapter = new BrowserHandAdapter({
      video,
      mirror: true,
      classifier: { stableFrames: 3, gestureCooldownMs: 430 },
      onDiagnostics: (diagnostics: HandAdapterDiagnostics) => {
        setCameraConfidence(diagnostics.signals.confidence);
        const active = diagnostics.signals.activated.at(-1);
        if (active) setGesture(handGestureLabel(active));
        else if (!diagnostics.signals.hand) setGesture("SHOW A HAND");
      },
      onError: (error) => setCameraError(error.message),
    });
    cameraRef.current = adapter;
    try {
      await engine.inputBus.register(adapter);
      setCameraState("active");
    } catch (cause) {
      await engine.inputBus.unregister(adapter);
      cameraRef.current = null;
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
      setCameraState(denied ? "denied" : "error");
      setCameraError(denied ? "Camera permission was not granted. Keyboard, gamepad, and Link remain active." : cause instanceof Error ? cause.message : "Local hand tracking could not start.");
    }
  };

  const restart = () => {
    setHud(INITIAL_HUD);
    setCameraState("idle");
    setCameraConfidence(0);
    setGesture("SHOW A HAND");
    setRun((value) => value + 1);
  };

  return (
    <section className="spell-page">
      <header className="spell-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Playable gesture survival · Seed spellcaster-{run}</p><h1>Spellcaster <span>101</span></h1></div>
        <div className="spell-stats"><div><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong></div><div><span>WAVE</span><strong>{hud.wave}</strong></div><div><span>CHAIN</span><strong>×{hud.combo}</strong></div><div><span>THREATS</span><strong>{hud.enemies}</strong></div></div>
      </header>
      <div className="spell-arena">
        <div className="spell-statusbar"><span><i className="status-dot" /> TEMPORAL GESTURE STATE MACHINE</span><span>{linked ? `${linked} LINK CASTER` : cameraState === "active" ? `LOCAL HAND · ${Math.round(cameraConfidence * 100)}%` : "KEYBOARD · GAMEPAD"}</span><b>{cameraState === "active" ? gesture : "CAMERA OPTIONAL"}</b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="Spellcaster arena. Aim with arrows, WASD, or a gamepad stick. Cast projectile with Space, shield with Q, grab with E, charge with C, blade with Shift or X, and vortex with R." />
        {/* Camera capture is muted, requests no audio, and remains on this device. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className={cameraState === "active" ? "spell-camera active" : "spell-camera"} ref={videoRef} aria-label="Local mirrored hand tracking preview" />
        <div className="spell-event"><span>ARCANE FEED</span><strong>{hud.event}</strong><small>LAST CAST · {hud.lastCast.toUpperCase()}</small></div>
        <div className="spell-vitals"><Meter label="HEALTH" value={hud.health} tone="health" /><Meter label="MANA" value={hud.mana} tone="mana" /><div className="spell-charge"><span>CHARGE</span><strong>{"◆".repeat(hud.charge)}{"◇".repeat(3 - hud.charge)}</strong></div></div>
        <div className="spell-actions">
          {!audioEnabled && <button onClick={() => { setAudioEnabled(true); audioEnabledRef.current = true; }}>ENABLE AUDIO</button>}
          {cameraState === "active" ? <button disabled>HAND CAMERA ACTIVE</button> : <button onClick={enableCamera}>{cameraState === "loading" ? "LOADING LOCAL MODEL…" : "ENABLE HAND CAMERA"}</button>}
          <button onClick={onConnect}>{linked ? "ADD CASTER" : "CONNECT MOTION"}</button>
        </div>
        {(cameraState === "denied" || cameraState === "error") && <p className="spell-camera-error">{cameraError}</p>}
        {hud.gameOver && <div className="game-over-panel"><p>THE CIRCLE FELL</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL ARCANE SCORE</span><button className="primary-button" onClick={restart}>Open another veil ↗</button></div>}
      </div>
      <div className="spell-instructions"><span><b>PROJECTILE</b> Space · two fingers</span><span><b>SHIELD</b> Q · open palm</span><span><b>GRAB</b> E · pinch</span><span><b>CHARGE</b> C · fist</span><span><b>BLADE</b> Shift/X · swipe</span><span><b>VORTEX</b> R · circle</span></div>
      <p className="spell-privacy"><strong>Optional camera:</strong> the bundled hand model runs here, converts landmarks into stable spell events, and discards frames. Video is not uploaded or recorded. Every spell also has a keyboard/gamepad fallback.</p>
    </section>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`spell-meter spell-meter-${tone}`}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>;
}

function handGestureLabel(gesture: string) {
  const labels: Record<string, string> = { openPalm: "OPEN PALM · SHIELD", fist: "FIST · CHARGE", pinch: "PINCH · GRAB", twoFingers: "TWO FINGERS · PROJECTILE", swipeLeft: "SWIPE · BLADE", swipeRight: "SWIPE · BLADE", circle: "CIRCLE · VORTEX", point: "POINT · AIM", grab: "GRAB" };
  return labels[gesture] ?? gesture.toUpperCase();
}

function createSpellAudio() {
  const audio = new Audio101();
  audio.registerTone("projectile", { frequency: 680, duration: .09, wave: "square", release: .06 });
  audio.registerTone("shield", { frequency: 310, duration: .22, wave: "sine", release: .14 });
  audio.registerTone("grab", { frequency: 190, duration: .16, wave: "triangle", release: .1 });
  audio.registerTone("charge", { frequency: 430, duration: .18, wave: "sine", release: .08 });
  audio.registerTone("blade", { frequency: 920, duration: .08, wave: "triangle", release: .045 });
  audio.registerTone("vortex", { frequency: 145, duration: .38, wave: "sine", release: .2 });
  audio.registerTone("impact", { frequency: 82, duration: .11, wave: "square", release: .08 });
  return audio;
}

const ENEMY_COLORS: Record<ArcaneEnemy["type"], number> = { wisp: 0x7dfbd7, golem: 0xff8d68, specter: 0xb899ff, swarm: 0xf8d96a, warden: 0xff4f78 };
const SPELL_COLORS: Record<SpellId | "impact", number> = { shield: 0x7dfbd7, grab: 0xb899ff, vortex: 0x7c5cff, projectile: 0xeff1e8, charge: 0xf8d96a, blade: 0xff6fa9, impact: 0xff5c35 };

function createSpellView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.renderer.setClearColor(0x07060d, 1);
  view.scene.fog = new THREE.FogExp2(0x07060d, .035);
  view.camera.position.set(0, 9.5, 10.5);
  view.camera.lookAt(0, 0, -3.8);
  view.scene.add(new THREE.AmbientLight(0xb6a9ff, 1.4));
  const key = new THREE.PointLight(0x7dfbd7, 36, 35); key.position.set(0, 5, 1); view.scene.add(key);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshStandardMaterial({ color: 0x090812, roughness: .82, metalness: .18 }));
  floor.rotation.x = -Math.PI / 2; floor.position.z = -3; view.scene.add(floor);
  const circle = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.36, 64), new THREE.MeshBasicMaterial({ color: 0x7dfbd7, transparent: true, opacity: .55, side: THREE.DoubleSide }));
  circle.rotation.x = -Math.PI / 2; circle.position.set(0, .025, 1.2); view.scene.add(circle);
  const aim = new THREE.Mesh(new THREE.RingGeometry(.2, .28, 24), new THREE.MeshBasicMaterial({ color: 0xeff1e8, side: THREE.DoubleSide }));
  aim.rotation.x = -Math.PI / 2; aim.position.y = .08; view.scene.add(aim);
  const enemies = new Map<string, THREE.Mesh>();
  const effects = new Map<number, THREE.Mesh>();

  const sync = (state: SpellcasterState) => {
    const bounds = canvas.getBoundingClientRect();
    view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    const enemyIds = new Set(state.enemies.map((enemy) => enemy.id));
    for (const enemy of state.enemies) {
      let mesh = enemies.get(enemy.id);
      if (!mesh) {
        mesh = createEnemyMesh(enemy);
        enemies.set(enemy.id, mesh);
        view.scene.add(mesh);
      }
      mesh.visible = enemy.spawnAt <= state.elapsed;
      const radial = enemy.radius * .7;
      mesh.position.set(Math.sin(enemy.angle) * radial, .5 + (enemy.id.length % 3) * .16, 1.2 - Math.cos(enemy.angle) * radial);
      mesh.rotation.x += .012;
      mesh.rotation.y += enemy.type === "warden" ? .008 : .025;
      const pulse = 1 + Math.sin(state.elapsed * 4 + enemy.id.length) * .08;
      mesh.scale.setScalar(pulse * (enemy.type === "warden" ? 1.55 : enemy.type === "swarm" ? .65 : 1));
    }
    for (const [id, mesh] of enemies) if (!enemyIds.has(id)) { disposeMesh(view, mesh); enemies.delete(id); }

    const effectIds = new Set(state.effects.map((effect) => effect.id));
    for (const effect of state.effects) {
      let mesh = effects.get(effect.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.RingGeometry(.12, .2, 48), new THREE.MeshBasicMaterial({ color: SPELL_COLORS[effect.spell], transparent: true, opacity: .9, side: THREE.DoubleSide }));
        mesh.rotation.x = -Math.PI / 2;
        effects.set(effect.id, mesh);
        view.scene.add(mesh);
      }
      const radial = effect.radius * .7;
      mesh.position.set(Math.sin(effect.angle) * radial, .12, 1.2 - Math.cos(effect.angle) * radial);
      const life = Math.max(0, 1 - (state.elapsed - effect.createdAt) / 1.25);
      mesh.scale.setScalar((1 + (1 - life) * 8) * effect.strength);
      (mesh.material as THREE.MeshBasicMaterial).opacity = life * .8;
    }
    for (const [id, mesh] of effects) if (!effectIds.has(id)) { disposeMesh(view, mesh); effects.delete(id); }
    aim.position.set(state.aim.x * 6, .08, -4 - state.aim.y * 3);
    aim.rotation.z = state.elapsed * .8;
    circle.scale.setScalar(state.shieldUntil > state.elapsed ? 1.15 + Math.sin(state.elapsed * 8) * .06 : 1);
    (circle.material as THREE.MeshBasicMaterial).opacity = state.shieldUntil > state.elapsed ? .95 : .35;
    view.render();
  };
  return {
    sync,
    dispose() {
      enemies.forEach((mesh) => disposeMesh(view, mesh));
      effects.forEach((mesh) => disposeMesh(view, mesh));
      [floor, circle, aim].forEach((mesh) => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); });
      view.dispose();
    },
  };
}

function createEnemyMesh(enemy: ArcaneEnemy) {
  const geometry = enemy.type === "golem" ? new THREE.DodecahedronGeometry(.62) : enemy.type === "specter" ? new THREE.ConeGeometry(.52, 1.25, 6) : enemy.type === "warden" ? new THREE.OctahedronGeometry(.82, 1) : new THREE.IcosahedronGeometry(enemy.type === "swarm" ? .38 : .5, 0);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: ENEMY_COLORS[enemy.type], emissive: ENEMY_COLORS[enemy.type], emissiveIntensity: enemy.armored ? .55 : 1.1, metalness: enemy.armored ? .8 : .2, roughness: .28 }));
}

function disposeMesh(view: Renderer3D101, mesh: THREE.Mesh) {
  view.scene.remove(mesh);
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}
