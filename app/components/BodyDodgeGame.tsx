"use client";

import GameControllerOverlay from "./GameControllerOverlay";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import type { GameHost101 } from "@101/game-host";
import { cameraStatusLabel, useCameraInput } from "../lib/use-camera-input";
import { playerColour, type TrackedPerson } from "@101/vision";
import GameOverPanel from "./GameOverPanel";
import { Renderer3D101, THREE } from "@101/render-3d";
import { defineGamePackage } from "@101/sdk";
import FullscreenButton from "@/app/components/FullscreenButton";
import { Icon } from "@/app/components/Icon";
import { describeSources } from "@/app/lib/input-readiness";
import { useGameHost } from "@/app/lib/use-game-host";
import BODYDODGE_INPUT from "@/games/bodydodge/input.manifest.json";
import BODYDODGE_MANIFEST from "@/games/bodydodge/manifest.json";
import { useRef, useState } from "react";
import { createBodyDodgeGame, type BodyDodgeState } from "@/games/bodydodge/src/game";
import type { DodgeGate, DodgeRequirement } from "@/games/bodydodge/src/director";
import { BODYDODGE_ROLES } from "@/games/bodydodge/src/roles";


interface BodyHud {
  score: number;
  combo: number;
  integrity: number;
  wave: number;
  distance: number;
  next: DodgeRequirement;
  nextDistance: number;
  lastEvent: string;
  gameOver: boolean;
  players: number;
}

const INITIAL_HUD: BodyHud = { score: 0, combo: 0, integrity: 100, wave: 1, distance: 0, next: "center", nextDistance: 0, lastEvent: "MOVE TO BEGIN", gameOver: false, players: 1 };

export default function BodyDodgeGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<GameHost101 | null>(null);
  const peopleRef = useRef<readonly TrackedPerson[]>([]);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<BodyHud>(INITIAL_HUD);
  const camera = useCameraInput({ kind: "body", sessionId, video: videoRef, host: hostRef, runKey: run, maxPeople: BODYDODGE_MANIFEST.players.max, onDiagnostics: (diagnostics) => { peopleRef.current = diagnostics.people; } });

  const { linked, readiness, controllerHost } = useGameHost<BodyDodgeState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: BODYDODGE_MANIFEST,
      input: BODYDODGE_INPUT,
      controllers: BODYDODGE_ROLES,
      game: createBodyDodgeGame(`bodydodge-${run}`),
    }),
    adapters: () => [new KeyboardAdapter(), new GamepadAdapter()],
    onReady: ({ context, host }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const view = createBodyView(canvas);
      hostRef.current = host;
      let renderHandle = 0;

      const render = () => {
        view.sync(context.state, peopleRef.current);
        renderHandle = requestAnimationFrame(render);
      };
      canvas.focus({ preventScroll: true });
      renderHandle = requestAnimationFrame(render);
      const hudTimer = window.setInterval(() => {
        const state = context.state;
        const next = state.gates.find((gate) => !gate.resolved) ?? state.gates[0];
        setHud({ score: state.score, combo: state.combo, integrity: state.integrity, wave: state.wave, distance: state.distance, next: next?.requirement ?? "center", nextDistance: Math.max(0, (next?.distance ?? state.distance) - state.distance), lastEvent: state.lastEvent, gameOver: state.gameOver, players: state.players.filter((player) => player.active).length });
      }, 80);
      return () => {
        window.clearInterval(hudTimer);
        cancelAnimationFrame(renderHandle);
        hostRef.current = null;
        peopleRef.current = [];
        view.dispose();
      };
    },
  });

  const restart = () => {
    setHud(INITIAL_HUD);
    setRun((value) => value + 1);
  };

  const nextLabel = label(hud.next);
  return (
    <section className="body-page">
      <header className="body-heading">
        <div><button className="back-button" onClick={onExit}><Icon name="back" size={16} />Back</button><h1>BodyDodge <span>101</span></h1></div>
        <div className="body-stats"><div><span>RUN</span><strong>{run}</strong></div><div><span>SCORE</span><strong>{hud.score.toString().padStart(6, "0")}</strong></div><div><span>WAVE</span><strong>{hud.wave.toString().padStart(2, "0")}</strong></div><div><span>CHAIN</span><strong>×{hud.combo}</strong></div></div>
      </header>

      <GameControllerOverlay binding={controllerHost} runComplete={hud.gameOver}>
        <div className="body-arena">
        <div className="body-statusbar"><FullscreenButton /><span>{linked ? "101 LINK · MOVEMENT PANEL" : camera.state === "on" ? cameraStatusLabel(camera.state, "body") : describeSources(readiness)}</span><b></b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="BodyDodge play field. Move with Left and Right, duck with Down, jump with Up or Space, and raise arms with E." />
        {/* Camera capture is always muted and requests no audio track. */}
        <video className={camera.state === "on" ? "body-camera-preview active" : "body-camera-preview"} ref={videoRef} playsInline muted aria-hidden={camera.state !== "on"} aria-label="Mirrored camera preview of your body" />
        <div className="body-next"><span>NEXT SHAPE</span><strong>{nextLabel}</strong><small>{hud.nextDistance.toFixed(0)} M</small></div>
        <div className="body-overlay"><div className="drift-meter"><span>INTEGRITY</span><i><b style={{ width: `${hud.integrity}%` }} /></i><strong>{Math.round(hud.integrity)}%</strong></div><div className="body-event">{hud.lastEvent}</div><div className="body-camera-actions">{camera.state === "on" ? <button onClick={camera.recentre}>Stand still, then tap</button> : <button onClick={camera.enable}>{camera.state === "starting" ? "Starting…" : "Use the camera"}</button>}<button onClick={onConnect}>{linked ? "LINKED" : "CONNECT PANEL"}</button></div></div>
        {camera.state === "failed" && <p className="camera-notice">{camera.message} <span>{camera.fix}</span></p>}
        {hud.gameOver && <GameOverPanel title="Run complete" score={hud.score} detail="Final score" onRestart={restart} />}
      </div>
      </GameControllerOverlay>
      <div className="slash-instructions"><span><b>MOVE / LEAN</b> Left + Right / A + D</span><span><b>DUCK / JUMP</b> Down + Up or Space</span><span><b>ARMS UP</b> E / gamepad Y</span></div>
      {hud.players > 1 && <p>Players 1 and 2 share the run. Clear each shape together; every miss uses shared integrity.</p>}
      <p className="body-privacy"><strong>Camera:</strong> play this with your body if you want to. The picture is read on this device and never leaves it — nothing is uploaded, nothing is recorded. Keys and a gamepad work just as well.</p>
    </section>
  );
}

function createBodyView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.renderer.setClearColor(0x07100d, 1);
  view.scene.fog = new THREE.Fog(0x07100d, 25, 150);
  view.camera.position.set(0, 2.5, 7.5);
  view.camera.lookAt(0, 1.4, -17);
  view.scene.add(new THREE.AmbientLight(0xffffff, 1.45));
  const key = new THREE.DirectionalLight(0xb5ff66, 3.4); key.position.set(4, 8, 4); view.scene.add(key);
  const rim = new THREE.DirectionalLight(0x50e3ff, 2.2); rim.position.set(-5, 3, -4); view.scene.add(rim);
  const grid = new THREE.GridHelper(80, 50, 0x31513a, 0x17231b); grid.position.y = 0; view.scene.add(grid);
  const rails = [-3.7, 3.7].map((x) => { const rail = new THREE.Mesh(new THREE.BoxGeometry(.08, .08, 100), new THREE.MeshBasicMaterial({ color: x < 0 ? 0x50e3ff : 0xff5c35 })); rail.position.set(x, .05, -42); view.scene.add(rail); return rail; });

  const createPlayer = (slot: number) => {
    const player = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xeef1e8, emissive: 0x2e3b32, emissiveIntensity: .35, roughness: .5 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(.32, 18, 14), bodyMaterial); head.position.y = 2.3;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(.72, 1.25, .34), bodyMaterial); torso.position.y = 1.45;
    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(.22, 1.15, .22), bodyMaterial); leftArm.position.set(-.55, 1.53, 0); leftArm.rotation.z = -.2;
    const rightArm = leftArm.clone(); rightArm.position.x = .55; rightArm.rotation.z = .2;
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(.26, 1.05, .28), bodyMaterial); leftLeg.position.set(-.23, .55, 0);
    const rightLeg = leftLeg.clone(); rightLeg.position.x = .23;
    player.add(head, torso, leftArm, rightArm, leftLeg, rightLeg); player.position.z = 2; view.scene.add(player);
    bodyMaterial.color.set(playerColour(slot));
    bodyMaterial.emissive.set(playerColour(slot));
    const number = playerNumber(slot); player.add(number);
    return { player, bodyMaterial, head, torso, leftArm, rightArm, leftLeg, rightLeg, number };
  };
  const players = new Map<number, ReturnType<typeof createPlayer>>();
  const resize = new ResizeObserver(([entry]) => { if (entry) view.resize(Math.max(1, entry.contentRect.width), Math.max(1, entry.contentRect.height)); });
  resize.observe(canvas);
  const gateGroups = new Map<number, THREE.Group>();

  const sync = (state: BodyDodgeState, people: readonly TrackedPerson[]) => {
    const tracked = new Set(people.map((person) => person.slot));
    const activeCount = state.players.filter((player) => player.active).length;
    for (const body of state.players) {
      let avatar = players.get(body.slot);
      if (!avatar) { avatar = createPlayer(body.slot); players.set(body.slot, avatar); }
      const { player, torso, head, leftArm, rightArm } = avatar;
      player.visible = body.active;
      if (!body.active) continue;
      // Both teammates fit within one opening and remain distinguishable while moving together.
      player.scale.setScalar(activeCount > 1 ? .82 : 1);
      player.position.z = 2;
      const offset = activeCount > 1 ? (body.slot === 1 ? -.26 : .26) : 0;
      player.position.x += (body.playerX * 2.25 + offset - player.position.x) * .2;
      player.position.y += (body.lift * 1.05 - player.position.y) * .22;
      player.rotation.z += ((-body.lean * .28) - player.rotation.z) * .18;
      torso.scale.y = 1 - body.crouch * .45; torso.position.y = 1.45 - body.crouch * .37;
      head.position.y = 2.3 - body.crouch * .78;
      leftArm.rotation.z += ((body.arms > .5 ? 2.75 : -.2) - leftArm.rotation.z) * .18;
      rightArm.rotation.z += ((body.arms > .5 ? -2.75 : .2) - rightArm.rotation.z) * .18;
      avatar.bodyMaterial.emissiveIntensity = tracked.has(body.slot) ? .5 : .35;
    }

    const active = new Set(state.gates.map((gate) => gate.id));
    for (const gate of state.gates) {
      let group = gateGroups.get(gate.id);
      if (!group) { group = createGateMesh(gate); gateGroups.set(gate.id, group); view.scene.add(group); }
      const distance = gate.distance - state.distance;
      group.position.z = -distance;
      group.position.x = gate.modifier === "moving" ? Math.sin(state.elapsed * 1.5 + gate.phase) * .55 : 0;
      const pulse = gate.modifier === "pulse" ? 1 + Math.sin(state.elapsed * 3 + gate.phase) * .05 : 1;
      group.scale.set(pulse, pulse, 1);
      group.visible = distance > -8;
      group.traverse((child) => { if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) child.material.emissiveIntensity = gate.resolved ? gate.passed ? 1.1 : 1.7 : .35; });
    }
    for (const [id, group] of gateGroups) {
      if (active.has(id)) continue;
      view.scene.remove(group); disposeObject(group); gateGroups.delete(id);
    }
    view.render();
  };
  return {
    sync,
    dispose() {
      resize.disconnect();
      for (const group of gateGroups.values()) disposeObject(group);
      for (const avatar of players.values()) {
        [avatar.head, avatar.torso, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg].forEach((mesh) => mesh.geometry.dispose());
        avatar.bodyMaterial.dispose(); avatar.number.material.map?.dispose(); avatar.number.material.dispose();
      }
      rails.forEach((rail) => { rail.geometry.dispose(); (rail.material as THREE.Material).dispose(); });
      view.dispose();
    },
  };
}

function createGateMesh(gate: DodgeGate) {
  const group = new THREE.Group();
  const outer = { left: -3.6, right: 3.6, bottom: 0, top: 4.5 };
  const opening = gateOpening(gate.requirement, gate.modifier === "narrow");
  const color = gate.requirement === "duck" ? 0xff5c35 : gate.requirement === "jump" ? 0x50e3ff : gate.requirement === "arms" ? 0xf8d96a : 0xb5ff66;
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .35, transparent: true, opacity: .82, metalness: .25, roughness: .5 });
  addBar(group, material, outer.left, opening.left, outer.bottom, outer.top);
  addBar(group, material, opening.right, outer.right, outer.bottom, outer.top);
  addBar(group, material, opening.left, opening.right, outer.bottom, opening.bottom);
  addBar(group, material, opening.left, opening.right, opening.top, outer.top);
  material.dispose();
  return group;
}

function addBar(group: THREE.Group, material: THREE.Material, left: number, right: number, bottom: number, top: number) {
  if (right - left <= .02 || top - bottom <= .02) return;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(right - left, top - bottom, .34), material.clone());
  mesh.position.set((left + right) / 2, (bottom + top) / 2, 0); group.add(mesh);
}

function gateOpening(requirement: DodgeRequirement, narrow: boolean) {
  const shrink = narrow ? .22 : 0;
  if (requirement === "left") return rect(-2.25, 1.7 - shrink, 1.8, 2.8);
  if (requirement === "right") return rect(2.25, 1.7 - shrink, 1.8, 2.8);
  if (requirement === "duck") return rect(0, 2.2 - shrink, .7, 1.2 - shrink);
  if (requirement === "jump") return rect(0, 2.1 - shrink, 2.85, 1.25 - shrink);
  if (requirement === "arms") return rect(0, 3.2 - shrink, 2.2, 3.7 - shrink);
  if (requirement === "lean-left") return rect(-1.15, 1.45 - shrink, 1.8, 3);
  if (requirement === "lean-right") return rect(1.15, 1.45 - shrink, 1.8, 3);
  return rect(0, 1.9 - shrink, 1.8, 3);
}

function rect(x: number, width: number, y: number, height: number) {
  return { left: x - width / 2, right: x + width / 2, bottom: y - height / 2, top: y + height / 2 };
}

function disposeObject(group: THREE.Object3D) {
  group.traverse((child) => { if (child instanceof THREE.Mesh) { child.geometry.dispose(); const materials = Array.isArray(child.material) ? child.material : [child.material]; materials.forEach((material) => material.dispose()); } });
}

function label(requirement: DodgeRequirement) {
  return requirement.replace("-", " ").toUpperCase();
}


function playerNumber(slot: number) {
  const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#101010"; context.beginPath(); context.arc(48, 48, 42, 0, Math.PI * 2); context.fill();
  context.strokeStyle = playerColour(slot); context.lineWidth = 7; context.stroke();
  context.fillStyle = "#ffffff"; context.font = "bold 56px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(slot), 48, 49);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  label.position.y = 3.1; label.scale.set(.65, .65, 1); label.renderOrder = 10;
  return label;
}
