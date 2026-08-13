"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Audio101 } from "@101/audio";
import { Engine101 } from "@101/core";
import { canTravel, type MazeDirection } from "@101/maze";
import { BroadcastChannelTransport } from "@101/protocol";
import { Renderer3D101, THREE } from "@101/render-3d";
import { LocalSession, SessionHost } from "@101/session";
import { useEffect, useRef, useState } from "react";
import { createEchoMazeGame, type EchoMazeState } from "@/games/echomaze/src/game";
import { ECHO_MAZE_ROLES } from "@/games/echomaze/src/roles";

interface EchoHud {
  score: number;
  floor: number;
  theme: string;
  modifier: string;
  fragments: number;
  fragmentTotal: number;
  health: number;
  battery: number;
  flashlight: boolean;
  event: string;
  clue: EchoMazeState["clue"];
  gameOver: boolean;
}

const INITIAL_HUD: EchoHud = { score: 0, floor: 1, theme: "archive", modifier: "still", fragments: 0, fragmentTotal: 2, health: 100, battery: 100, flashlight: true, event: "THE SCANNER HEARS TWO FRAGMENTS", clue: { target: "fragment", bearing: 0, compass: "N", distance: 0, signal: 0, echoDistance: 99, exitLocked: true }, gameOver: false };

export default function EchoMazeGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioEnabledRef = useRef(false);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<EchoHud>(INITIAL_HUD);
  const [linked, setLinked] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine101(createEchoMazeGame(`echomaze-${run}`));
    const keyboard = new KeyboardAdapter();
    const gamepad = new GamepadAdapter();
    const audio = createEchoAudio();
    const host = new SessionHost({
      gameId: "echomaze",
      roles: ECHO_MAZE_ROLES,
      transport: new BroadcastChannelTransport(sessionId),
      session: new LocalSession(sessionId),
      onFrame: (frame) => engine.inputBus.accept(frame),
      onDeviceReset: (deviceId) => engine.inputBus.removeDevice(deviceId),
      onChange: (snapshot) => setLinked(snapshot.assignments.length),
    });
    const view = createEchoView(canvas);
    let drawHandle = 0;
    let previousScan = 0;
    let previousImpact = 0;
    let previousFloor = 0;

    const render = () => {
      const state = engine.context.state;
      view.sync(state);
      if (state.scanSequence !== previousScan) {
        previousScan = state.scanSequence;
        if (audioEnabledRef.current) audio.play("ping", { volume: .55, pan: Math.sin(state.clue.bearing) * .7 });
        host.haptic("scanner", state.clue.echoDistance <= 2 ? "warning" : "tap");
      }
      if (state.impactSequence !== previousImpact) {
        previousImpact = state.impactSequence;
        if (audioEnabledRef.current) audio.play("echo", { volume: .75 });
        host.haptic("scanner", "impact");
      }
      if (state.floorSequence !== previousFloor) {
        previousFloor = state.floorSequence;
        if (audioEnabledRef.current) audio.play("threshold", { volume: .64 });
        host.haptic("scanner", "warning");
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
      setHud({
        score: state.score,
        floor: state.floorNumber,
        theme: state.floor.theme,
        modifier: state.floor.modifier,
        fragments: state.collected.length,
        fragmentTotal: state.floor.fragments.length,
        health: state.health,
        battery: state.battery,
        flashlight: state.flashlight,
        event: state.lastEvent,
        clue: { ...state.clue },
        gameOver: state.gameOver,
      });
      host.sendControllerState("scanner", {
        TARGET: state.clue.target.toUpperCase(),
        BEARING: state.clue.compass,
        DISTANCE: `${state.clue.distance} CELLS`,
        SIGNAL: `${state.clue.signal}%`,
        ECHO: state.clue.echoDistance > 8 ? "DISTANT" : `${state.clue.echoDistance} CELLS`,
        BATTERY: `${Math.round(state.battery)}%`,
      }, {
        message: state.clue.echoDistance <= 2 ? "ECHO PROXIMITY" : state.clue.exitLocked ? "RECOVER ALL FRAGMENTS" : "EXIT SIGNATURE OPEN",
        tone: state.clue.echoDistance <= 2 ? "critical" : state.battery < 20 ? "warning" : "normal",
      });
    }, 110);

    return () => {
      window.clearInterval(hudTimer);
      cancelAnimationFrame(drawHandle);
      void host.stop();
      engine.stop();
      void engine.inputBus.destroy();
      audio.unload();
      view.dispose();
    };
  }, [run, sessionId]);

  const restart = () => { setHud(INITIAL_HUD); setRun((value) => value + 1); };

  return (
    <section className="echo-page">
      <header className="echo-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Playable private-display exploration · Seed echomaze-{run}</p><h1>Echo Maze <span>101</span></h1></div>
        <div className="echo-stats"><div><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong></div><div><span>FLOOR</span><strong>{hud.floor}</strong></div><div><span>FRAGMENTS</span><strong>{hud.fragments}/{hud.fragmentTotal}</strong></div><div><span>LIGHT</span><strong>{Math.round(hud.battery)}%</strong></div></div>
      </header>
      <div className="echo-layout">
        <div className="echo-stage">
          <div className="echo-statusbar"><span><i className="status-dot" /> SEEDED MAZE / LOCAL COMPANION CHANNEL</span><span>{hud.theme.toUpperCase()} · {hud.modifier.toUpperCase()}</span><b>{linked ? "PRIVATE CLUE ROUTED TO LINK" : "FALLBACK CLUE VISIBLE"}</b></div>
          <canvas ref={canvasRef} tabIndex={0} aria-label="Echo Maze top-down dark maze. Move with WASD, arrows, or gamepad. Press R or Space to scan and F to toggle the flashlight." />
          <div className="echo-event"><span>FIELD LOG</span><strong>{hud.event}</strong></div>
          {!linked && <CompanionClue clue={hud.clue} fallback />}
          <div className="echo-actions">{!audioEnabled && <button onClick={() => { setAudioEnabled(true); audioEnabledRef.current = true; }}>ENABLE AUDIO</button>}<button onClick={onConnect}>{linked ? "ADD SCANNER" : "CONNECT PRIVATE SCANNER"}</button></div>
          {hud.gameOver && <div className="game-over-panel"><p>YOUR ECHO REMAINS</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL EXPEDITION SCORE</span><button className="primary-button" onClick={restart}>Enter another maze ↗</button></div>}
        </div>
        <aside className="echo-rail">
          <section className="echo-vitals"><h2>EXPLORER STATUS</h2><EchoMeter label="HEALTH" value={hud.health} tone="health" /><EchoMeter label="BATTERY" value={hud.battery} tone="battery" /><p className={hud.flashlight ? "light-on" : ""}><i />FLASHLIGHT {hud.flashlight ? "OPEN" : "CLOSED"}</p></section>
          {linked ? <section className="echo-private"><span>101 LINK / PRIVATE</span><h2>THE PHONE KNOWS MORE.</h2><p>Precise target bearing, path distance, signal strength, and echo proximity are visible only on the assigned scanner.</p><b>SCANNER LINKED</b></section> : <section className="echo-private"><span>CONVENTIONAL FALLBACK</span><h2>NO PHONE REQUIRED.</h2><p>The same necessary clue is shown over the maze until a scanner connects. The game never gates progress on special hardware.</p><button onClick={onConnect}>CONNECT SCANNER ↗</button></section>}
          <section className="echo-objective"><span>CURRENT OBJECTIVE</span><strong>{hud.fragments < hud.fragmentTotal ? `RECOVER ${hud.fragmentTotal - hud.fragments} MEMORY FRAGMENT${hud.fragmentTotal - hud.fragments === 1 ? "" : "S"}` : "REACH THE OPEN EXIT"}</strong><small>Floors continue from the same deterministic expedition seed.</small></section>
        </aside>
      </div>
      <div className="echo-instructions"><span><b>MOVE</b> WASD · arrows · left stick</span><span><b>SCAN</b> R/Space · gamepad A · phone ping</span><span><b>FLASHLIGHT</b> F · gamepad Y · Link</span><span><b>PRIVATE DISPLAY</b> phone receives clues, never required</span></div>
      <p className="echo-privacy"><strong>Local by design:</strong> the companion receives tiny role-targeted state messages—not video, microphone, location, or account data. This slice makes no microphone request.</p>
    </section>
  );
}

function CompanionClue({ clue, fallback }: { clue: EchoMazeState["clue"]; fallback?: boolean }) {
  return <div className={`echo-clue${fallback ? " fallback" : ""}`}><span>{fallback ? "HOST FALLBACK CLUE" : "PRIVATE SCANNER"}</span><div><strong>{clue.compass}</strong><i style={{ transform: `rotate(${clue.bearing}rad)` }}>↑</i></div><dl><div><dt>TARGET</dt><dd>{clue.target.toUpperCase()}</dd></div><div><dt>PATH</dt><dd>{clue.distance}</dd></div><div><dt>SIGNAL</dt><dd>{clue.signal}%</dd></div><div><dt>ECHO</dt><dd>{clue.echoDistance > 8 ? "FAR" : clue.echoDistance}</dd></div></dl></div>;
}

function EchoMeter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`echo-meter echo-meter-${tone}`}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>;
}

function createEchoAudio() {
  const audio = new Audio101();
  audio.registerTone("ping", { frequency: 640, duration: .22, wave: "sine", release: .16 });
  audio.registerTone("echo", { frequency: 58, duration: .48, wave: "square", release: .32 });
  audio.registerTone("threshold", { frequency: 260, duration: .55, wave: "sine", release: .4 });
  return audio;
}

const DIRECTIONS: readonly MazeDirection[] = ["north", "east", "south", "west"];

function createEchoView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.renderer.setClearColor(0x030609, 1);
  view.scene.fog = new THREE.FogExp2(0x030609, .075);
  view.scene.add(new THREE.AmbientLight(0x7c91bb, .75));
  const light = new THREE.PointLight(0xd8e7ff, 22, 8, 1.8); view.scene.add(light);
  const player = new THREE.Mesh(new THREE.CylinderGeometry(.22, .28, .7, 8), new THREE.MeshStandardMaterial({ color: 0xeff1e8, emissive: 0x80a8ff, emissiveIntensity: .7 })); view.scene.add(player);
  const scan = new THREE.Mesh(new THREE.RingGeometry(.2, .24, 48), new THREE.MeshBasicMaterial({ color: 0x80a8ff, transparent: true, opacity: 0, side: THREE.DoubleSide })); scan.rotation.x = -Math.PI / 2; view.scene.add(scan);
  const floorGroup = new THREE.Group(); view.scene.add(floorGroup);
  let floorNumber = -1;
  let scanSequence = 0;
  let scanStartedAt = -10;

  const rebuild = (state: EchoMazeState) => {
    while (floorGroup.children.length) disposeObject(floorGroup.children[0]!);
    const floor = state.floor;
    const wallMaterial = new THREE.MeshStandardMaterial({ color: themeColor(floor.theme), emissive: 0x101728, emissiveIntensity: .35, roughness: .72 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(floor.width, floor.height), new THREE.MeshStandardMaterial({ color: 0x070b11, roughness: .95 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, -.04, 0); floorGroup.add(ground);
    for (const cell of floor.cells) {
      const x = cell.x - floor.width / 2 + .5;
      const z = cell.y - floor.height / 2 + .5;
      for (const direction of DIRECTIONS) {
        const boundary = direction === "north" || direction === "west" || (direction === "east" && cell.x === floor.width - 1) || (direction === "south" && cell.y === floor.height - 1);
        if (!boundary || canTravel(floor, cell, direction)) continue;
        const horizontal = direction === "north" || direction === "south";
        const wall = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? 1.04 : .08, 1.2, horizontal ? .08 : 1.04), wallMaterial.clone());
        wall.position.set(x + (direction === "east" ? .5 : direction === "west" ? -.5 : 0), .6, z + (direction === "south" ? .5 : direction === "north" ? -.5 : 0));
        floorGroup.add(wall);
      }
    }
    for (const fragment of floor.fragments) {
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(.2), new THREE.MeshStandardMaterial({ color: 0x80a8ff, emissive: 0x80a8ff, emissiveIntensity: 2 }));
      mesh.name = `fragment:${fragment.x},${fragment.y}`; mesh.position.set(fragment.x - floor.width / 2 + .5, .36, fragment.y - floor.height / 2 + .5); floorGroup.add(mesh);
    }
    const exit = new THREE.Mesh(new THREE.RingGeometry(.22, .36, 24), new THREE.MeshBasicMaterial({ color: 0xb5ff66, side: THREE.DoubleSide }));
    exit.rotation.x = -Math.PI / 2; exit.position.set(floor.exit.x - floor.width / 2 + .5, .04, floor.exit.y - floor.height / 2 + .5); floorGroup.add(exit);
    for (const echo of floor.echoes) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.22, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5c35, transparent: true, opacity: .16 }));
      mesh.name = `echo:${echo.x},${echo.y}`; mesh.position.set(echo.x - floor.width / 2 + .5, .35, echo.y - floor.height / 2 + .5); floorGroup.add(mesh);
    }
    view.camera.position.set(0, Math.max(10, floor.height * 1.05), floor.height * .62);
    view.camera.lookAt(0, 0, 0);
  };

  const sync = (state: EchoMazeState) => {
    const bounds = canvas.getBoundingClientRect();
    view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    if (floorNumber !== state.floorNumber) { floorNumber = state.floorNumber; rebuild(state); }
    const x = state.player.x - state.floor.width / 2 + .5;
    const z = state.player.y - state.floor.height / 2 + .5;
    player.position.set(x, .36, z);
    player.rotation.y = ({ north: Math.PI, east: -Math.PI / 2, south: 0, west: Math.PI / 2 } as Record<MazeDirection, number>)[state.facing];
    light.position.set(x, .7, z);
    light.intensity = state.flashlight ? 18 + state.battery * .08 : 2.5;
    light.distance = state.flashlight ? 5 + state.floor.visibility * 4 : 1.8;
    for (const child of floorGroup.children) {
      if (child.name.startsWith("fragment:")) child.visible = !state.collected.includes(child.name.slice(9));
      if (child.name.startsWith("echo:")) child.visible = !state.clearedEchoes.includes(child.name.slice(5));
      if (child.name.startsWith("echo:") && child instanceof THREE.Mesh) (child.material as THREE.MeshBasicMaterial).opacity = .06 + state.floor.echoPressure * .12;
      if (child.name.startsWith("fragment:")) child.rotation.y += .025;
    }
    if (scanSequence !== state.scanSequence) { scanSequence = state.scanSequence; scanStartedAt = state.elapsed; }
    const scanLife = Math.max(0, 1 - (state.elapsed - scanStartedAt) / .8);
    scan.position.set(x, .05, z);
    scan.scale.setScalar(1 + (1 - scanLife) * 18);
    (scan.material as THREE.MeshBasicMaterial).opacity = scanLife * .75;
    view.render();
  };
  return {
    sync,
    dispose() {
      while (floorGroup.children.length) disposeObject(floorGroup.children[0]!);
      player.geometry.dispose(); (player.material as THREE.Material).dispose();
      scan.geometry.dispose(); (scan.material as THREE.Material).dispose();
      view.dispose();
    },
  };
}

function disposeObject(object: THREE.Object3D) {
  object.parent?.remove(object);
  if (object instanceof THREE.Mesh) { object.geometry.dispose(); (object.material as THREE.Material).dispose(); }
  object.children.slice().forEach(disposeObject);
}

function themeColor(theme: string) {
  return ({ archive: 0x172033, cistern: 0x112c31, observatory: 0x241b39, "deep-vault": 0x2c2421 } as Record<string, number>)[theme] ?? 0x172033;
}
