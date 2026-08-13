"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Engine101 } from "@101/core";
import { getBrowserHostTransport } from "@/app/lib/browser-link";
import { Renderer3D101, THREE } from "@101/render-3d";
import { LocalSession, SessionHost } from "@101/session";
import { useEffect, useRef, useState } from "react";
import { createTiltDriftGame, type TiltDriftState } from "@/games/tiltdrift/src/game";
import { roadCenterAt, type RoadEnvironment, type RoadSegment } from "@/games/tiltdrift/src/director";
import { TILTDRIFT_ROLES } from "@/games/tiltdrift/src/roles";

interface DriftHud {
  speed: number;
  score: number;
  integrity: number;
  boost: number;
  combo: number;
  environment: RoadEnvironment;
  lastEvent: string;
  gameOver: boolean;
}

const INITIAL_HUD: DriftHud = { speed: 27, score: 0, integrity: 100, boost: 100, combo: 0, environment: "city", lastEvent: "GRID READY", gameOver: false };

export default function TiltDriftGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [run, setRun] = useState(1);
  const [linked, setLinked] = useState(0);
  const [hud, setHud] = useState<DriftHud>(INITIAL_HUD);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine101(createTiltDriftGame(`tiltdrift-${run}`));
    const keyboard = new KeyboardAdapter();
    const gamepad = new GamepadAdapter();
    const transport = getBrowserHostTransport(sessionId);
    const host = new SessionHost({
      gameId: "tiltdrift",
      roles: TILTDRIFT_ROLES,
      transport,
      session: new LocalSession(sessionId),
      onFrame: (frame) => engine.inputBus.accept(frame),
      onDeviceReset: (deviceId) => engine.inputBus.removeDevice(deviceId),
      onChange: (snapshot) => setLinked(snapshot.assignments.length),
    });
    const view = createDriftView(canvas);
    let renderHandle = 0;

    const render = () => {
      view.sync(engine.context.state);
      renderHandle = requestAnimationFrame(render);
    };
    void engine.inputBus.register(keyboard);
    void engine.inputBus.register(gamepad);
    void host.start();
    void engine.start();
    canvas.focus();
    renderHandle = requestAnimationFrame(render);
    const hudTimer = window.setInterval(() => {
      const state = engine.context.state;
      setHud({ speed: state.speed, score: state.score, integrity: state.integrity, boost: state.boost, combo: state.combo, environment: state.environment, lastEvent: state.lastEvent, gameOver: state.gameOver });
    }, 90);

    return () => {
      window.clearInterval(hudTimer);
      cancelAnimationFrame(renderHandle);
      void host.stop();
      engine.stop();
      void engine.inputBus.destroy();
      view.dispose();
    };
  }, [run, sessionId]);

  const restart = () => {
    setHud(INITIAL_HUD);
    setRun((value) => value + 1);
  };

  return (
    <section className="drift-page">
      <header className="drift-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Playable 3D vertical slice · Seed tiltdrift-{run}</p><h1>TiltDrift <span>101</span></h1></div>
        <div className="drift-stats"><div><span>SPEED</span><strong>{Math.round(hud.speed * 3.6)}</strong><small>KM/H</small></div><div><span>SCORE</span><strong>{hud.score.toString().padStart(6, "0")}</strong></div><div><span>CHAIN</span><strong>×{(1 + hud.combo * .08).toFixed(1)}</strong></div></div>
      </header>
      <div className="drift-arena">
        <div className="drift-statusbar"><span><i className="status-dot" /> INPUT BUS / STEER ACTIVE</span><span>{linked ? `${linked} LINK DEVICE${linked > 1 ? "S" : ""}` : "KEYBOARD · GAMEPAD"}</span><b>{hud.environment.toUpperCase()} SECTOR</b></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="TiltDrift play field. Steer with left and right arrows, boost with Space, brake with Down, and drift with Shift." />
        <div className="drift-overlay">
          <div className="drift-meter"><span>INTEGRITY</span><i><b style={{ width: `${hud.integrity}%` }} /></i><strong>{Math.round(hud.integrity)}%</strong></div>
          <div className="drift-event">{hud.lastEvent}</div>
          <button onClick={onConnect}>{linked ? "ADD DRIVER" : "CONNECT WHEEL"} ↗</button>
        </div>
        <div className="boost-meter"><span>BOOST</span><i><b style={{ width: `${hud.boost}%` }} /></i></div>
        {hud.gameOver && <div className="game-over-panel"><p>VEHICLE OFFLINE</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL SCORE</span><button className="primary-button" onClick={restart}>Run another seed ↗</button></div>}
      </div>
      <div className="slash-instructions"><span><b>STEER</b> Arrow keys / A D / gamepad / phone tilt</span><span><b>BOOST + DRIFT</b> Space + Shift</span><span><b>BRAKE</b> Down arrow / S / Link pedal</span></div>
    </section>
  );
}

function createDriftView(canvas: HTMLCanvasElement) {
  const view = new Renderer3D101({ canvas, quality: "normal" });
  view.camera.position.set(0, 3.7, 7.8);
  view.camera.lookAt(0, -0.45, -17);
  view.scene.fog = new THREE.Fog(0x071013, 26, 190);
  const ambient = new THREE.AmbientLight(0xffffff, 1.25);
  const key = new THREE.DirectionalLight(0x50e3ff, 3.4);
  key.position.set(4, 8, 5);
  view.scene.add(ambient, key);

  const car = new THREE.Group();
  const carBody = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.42, 2.55), new THREE.MeshStandardMaterial({ color: 0xff5c35, metalness: 0.65, roughness: 0.24 }));
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.42, 1.15), new THREE.MeshStandardMaterial({ color: 0x101a1c, emissive: 0x0c3340, emissiveIntensity: 1.2 }));
  cockpit.position.set(0, 0.38, -0.1);
  car.add(carBody, cockpit);
  car.position.set(0, -0.65, 2.1);
  view.scene.add(car);

  const roadGroups = new Map<number, THREE.Group>();
  const trafficMeshes = new Map<number, THREE.Mesh>();
  let lastEnvironment: RoadEnvironment | undefined;

  const sync = (state: TiltDriftState) => {
    const bounds = canvas.getBoundingClientRect();
    view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    if (state.environment !== lastEnvironment) {
      const color = environmentColor(state.environment);
      view.renderer.setClearColor(color.background, 1);
      view.scene.fog = new THREE.Fog(color.background, 30, 210);
      lastEnvironment = state.environment;
    }
    car.position.x += (state.lateral - car.position.x) * 0.16;
    car.rotation.z += ((-state.lateralVelocity * 0.045) - car.rotation.z) * 0.12;
    cockpit.position.y = 0.38 + Math.sin(performance.now() / 70) * Math.min(0.025, state.speed / 3000);

    const activeRoads = new Set(state.segments.map((segment) => segment.id));
    for (const segment of state.segments) {
      let group = roadGroups.get(segment.id);
      if (!group) {
        group = createRoadMesh(segment);
        roadGroups.set(segment.id, group);
        view.scene.add(group);
      }
      const middle = segment.startDistance + segment.length / 2;
      group.position.set((segment.startX + segment.endX) / 2 - state.roadCenter, -1.08 + segment.elevation * .12, -(middle - state.distance));
      group.rotation.y = -Math.atan2(segment.endX - segment.startX, segment.length);
    }
    for (const [id, group] of roadGroups) {
      if (activeRoads.has(id)) continue;
      view.scene.remove(group);
      disposeObject(group);
      roadGroups.delete(id);
    }

    const activeTraffic = new Set(state.traffic.map((traffic) => traffic.id));
    for (const traffic of state.traffic) {
      let mesh = trafficMeshes.get(traffic.id);
      if (!mesh) {
        const color = traffic.kind === "barrier" ? 0xff5c35 : traffic.kind === "drone" ? 0xb5ff66 : 0x50e3ff;
        mesh = new THREE.Mesh(new THREE.BoxGeometry(traffic.kind === "barrier" ? 2.5 : 1.25, traffic.kind === "drone" ? .3 : .65, traffic.kind === "barrier" ? .45 : 2), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .24, metalness: .5, roughness: .3 }));
        trafficMeshes.set(traffic.id, mesh);
        view.scene.add(mesh);
      }
      const road = state.segments.find((segment) => traffic.distance >= segment.startDistance && traffic.distance < segment.startDistance + segment.length);
      if (!road) continue;
      mesh.position.set(roadCenterAt(road, traffic.distance) - state.roadCenter + traffic.lane * road.width * .42, traffic.kind === "drone" ? .5 : -.7, -(traffic.distance - state.distance));
    }
    for (const [id, mesh] of trafficMeshes) {
      if (activeTraffic.has(id)) continue;
      view.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      trafficMeshes.delete(id);
    }
    view.render();
  };

  return {
    sync,
    dispose() {
      for (const group of roadGroups.values()) disposeObject(group);
      for (const mesh of trafficMeshes.values()) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      carBody.geometry.dispose(); cockpit.geometry.dispose();
      (carBody.material as THREE.Material).dispose(); (cockpit.material as THREE.Material).dispose();
      view.dispose();
    },
  };
}

function createRoadMesh(segment: RoadSegment) {
  const group = new THREE.Group();
  const color = environmentColor(segment.environment);
  const road = new THREE.Mesh(new THREE.BoxGeometry(segment.width, .15, segment.length), new THREE.MeshStandardMaterial({ color: color.road, roughness: .72, metalness: .18 }));
  group.add(road);
  for (const lane of [-.25, .25]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(.07, .025, segment.length * .92), new THREE.MeshBasicMaterial({ color: color.accent }));
    stripe.position.set(segment.width * lane, .09, 0);
    group.add(stripe);
  }
  for (const edge of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(.12, .18, segment.length), new THREE.MeshBasicMaterial({ color: edge < 0 ? 0x50e3ff : 0xff5c35 }));
    rail.position.set(edge * segment.width * .51, .14, 0);
    group.add(rail);
  }
  return group;
}

function environmentColor(environment: RoadEnvironment) {
  const colors: Record<RoadEnvironment, { background: number; road: number; accent: number }> = {
    city: { background: 0x071013, road: 0x1a2122, accent: 0xd8ded7 },
    tunnel: { background: 0x030505, road: 0x131817, accent: 0xff5c35 },
    desert: { background: 0x1d0f0a, road: 0x3a2920, accent: 0xf8d96a },
    neon: { background: 0x10051a, road: 0x21172b, accent: 0xd368ff },
    ice: { background: 0x07171d, road: 0x27444d, accent: 0xb6f2ff },
    industrial: { background: 0x11120f, road: 0x252720, accent: 0xb5ff66 },
    space: { background: 0x02040b, road: 0x10182a, accent: 0x50e3ff },
  };
  return colors[environment];
}

function disposeObject(group: THREE.Object3D) {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}
