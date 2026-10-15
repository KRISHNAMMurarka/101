"use client";

import { BrowserMotionAdapter, requestMotionPermission, type MotionDiagnostics } from "@101/adapter-motion";
import { quaternionFromDeviceOrientation, type MotionSample } from "@101/motion";
import { Renderer3D101, THREE } from "@101/render-3d";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type LabState = "idle" | "active" | "simulated" | "denied" | "unsupported";

const EMPTY_SAMPLE: MotionSample = { timestamp: 0, orientation: [0, 0, 0, 1], acceleration: [0, 0, 0], angularVelocity: [0, 0, 0] };

export default function MotionLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const adapterRef = useRef<BrowserMotionAdapter | null>(null);
  const mounted = useRef(false), generation = useRef(0), permissionReserved = useRef(false);
  const orientationRef = useRef<readonly [number, number, number, number]>([0, 0, 0, 1]);
  const simulatedRef = useRef({ beta: 0, gamma: 0 });
  const [labState, setLabState] = useState<LabState>("idle");
  const [sensitivity, setSensitivity] = useState(1);
  const [diagnostics, setDiagnostics] = useState<MotionDiagnostics | null>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const view = new Renderer3D101({ canvas, quality: "normal" });
    view.renderer.setClearColor(0x090b0b, 1);
    view.camera.position.set(0, 1.1, 5.8);
    view.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const key = new THREE.DirectionalLight(0x50e3ff, 4);
    key.position.set(3, 4, 5);
    view.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff5c35, 3);
    rim.position.set(-4, 0, -2);
    view.scene.add(rim);
    const phone = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.55, 2.9, 0.22), new THREE.MeshStandardMaterial({ color: 0x151a19, metalness: 0.7, roughness: 0.28 }));
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.34, 2.58, 0.035), new THREE.MeshStandardMaterial({ color: 0x101b1d, emissive: 0x0b4450, emissiveIntensity: 1.4 }));
    screen.position.z = 0.13;
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.28, 0.04), new THREE.MeshBasicMaterial({ color: 0xb5ff66 }));
    mark.position.set(0, 0, 0.17);
    phone.add(body, screen, mark);
    view.scene.add(phone);
    const grid = new THREE.GridHelper(12, 18, 0x2a3430, 0x151b19);
    grid.position.y = -2.15;
    view.scene.add(grid);

    let frame = 0;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      view.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const render = () => {
      const [x, y, z, w] = orientationRef.current;
      phone.quaternion.slerp(new THREE.Quaternion(x, y, z, w), 0.22);
      phone.position.y = Math.sin(performance.now() / 850) * 0.04;
      view.render();
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      body.geometry.dispose();
      screen.geometry.dispose();
      mark.geometry.dispose();
      (body.material as THREE.Material).dispose();
      (screen.material as THREE.Material).dispose();
      (mark.material as THREE.Material).dispose();
      view.dispose();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (labState !== "simulated") return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) return;
      event.preventDefault();
      simulatedRef.current.gamma += event.code === "ArrowRight" ? 6 : event.code === "ArrowLeft" ? -6 : 0;
      simulatedRef.current.beta += event.code === "ArrowDown" ? 6 : event.code === "ArrowUp" ? -6 : 0;
      const { beta, gamma } = simulatedRef.current;
      adapterRef.current?.ingest({
        ...EMPTY_SAMPLE,
        timestamp: performance.now(),
        orientation: quaternionFromDeviceOrientation(0, beta, gamma),
        acceleration: [event.code === "ArrowLeft" ? -2 : event.code === "ArrowRight" ? 2 : 0, 0, 0],
        angularVelocity: [0, gamma * 2, beta * 2],
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [labState]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Retire permission work using the latest generation, not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      adapterRef.current?.stop();
    };
  }, []);

  const createAdapter = (sensors = false) => {
    adapterRef.current?.stop();
    const adapter = new BrowserMotionAdapter({
      calibration: { sensitivity },
      onDiagnostics: (next) => {
        if (!mounted.current || adapterRef.current !== adapter) return;
        orientationRef.current = next.filtered.orientation;
        setDiagnostics(next);
      },
    });
    adapterRef.current = adapter;
    if (sensors) adapter.start(() => undefined);
    return adapter;
  };

  const enableSensors = async () => {
    if (permissionReserved.current) return;
    const revision = ++generation.current;
    const current = () => mounted.current && generation.current === revision;
    permissionReserved.current = true; setRequesting(true);
    try {
      const permission = await requestMotionPermission();
      if (!current()) return;
      if (permission !== "granted") {
        adapterRef.current?.stop(); adapterRef.current = null;
        setLabState(permission);
        return;
      }
      createAdapter(true);
      setLabState("active");
    } catch {
      if (!current()) return;
      adapterRef.current?.stop(); adapterRef.current = null;
      setLabState("denied");
    } finally {
      permissionReserved.current = false;
      if (mounted.current) setRequesting(false);
    }
  };

  const startSimulation = () => {
    generation.current++;
    const adapter = createAdapter();
    setLabState("simulated");
    adapter.ingest({ ...EMPTY_SAMPLE, timestamp: performance.now() });
  };

  const updateSensitivity = (value: number) => {
    setSensitivity(value);
    adapterRef.current?.setSensitivity(value);
  };

  const raw = diagnostics?.raw ?? EMPTY_SAMPLE;
  const filtered = diagnostics?.filtered ?? EMPTY_SAMPLE;
  const degrees = (value = 0) => value * 180 / Math.PI;
  const gesture = diagnostics?.gestures.spin ? "SPIN" : diagnostics?.gestures.shake ? "SHAKE" : diagnostics?.gestures.swing ? "SWING" : "—";

  return (
    <main className="motion-page">
      <header className="motion-topbar"><Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">MOTION LAB</span></Link><span className={`motion-state state-${labState}`}><i />{labState.toUpperCase()}</span></header>
      <section className="motion-intro"><p className="eyebrow">Local sensor pipeline · No recording</p><h1>Hold neutral.<br />Then move.</h1><p>Raw device motion becomes corrected orientation, filtered acceleration, deliberate gestures, and finally the same normalized axes every 101 game reads.</p></section>
      <section className="motion-workbench">
        <div className="motion-stage">
          <div className="motion-stagebar"><span>LIVE ORIENTATION MODEL</span><code>Q {filtered.orientation.map((value) => value.toFixed(2)).join(" / ")}</code></div>
          <canvas ref={canvasRef} aria-label="Live 3D model showing the calibrated device orientation" />
          <div className="motion-angle-strip"><span>PITCH <b>{degrees(diagnostics?.pitch).toFixed(1)}°</b></span><span>ROLL <b>{degrees(diagnostics?.roll).toFixed(1)}°</b></span><span>YAW <b>{degrees(diagnostics?.yaw).toFixed(1)}°</b></span><span>GESTURE <b>{gesture}</b></span></div>
        </div>
        <aside className="motion-controls">
          <span className="rail-title">CALIBRATION <i /></span>
          <button className="primary-button" disabled={requesting} aria-describedby="motion-permission-status" onClick={enableSensors}>{requesting ? "Waiting for motion permission…" : "Enable device motion"}</button>
          <button className="outline-button" onClick={startSimulation}>Use keyboard simulation</button>
          <button className="motion-neutral" disabled={labState !== "active" && labState !== "simulated"} onClick={() => adapterRef.current?.calibrateNeutral()}>Set current pose as neutral</button>
          <div className="sensitivity-control"><span>SENSITIVITY</span><div>{[[0.65, "LOW"], [1, "MED"], [1.45, "HIGH"]].map(([value, label]) => <button className={sensitivity === value ? "active" : ""} key={label} onClick={() => updateSensitivity(value as number)}>{label}</button>)}</div></div>
          <p className="motion-permission-copy">Motion Sensors: use phone as steering wheel. Permission is requested only by the button above; samples stay in this browser unless you explicitly connect a game.</p>
          <p id="motion-permission-status" role="status">{requesting ? "Waiting for motion permission. You can use keyboard simulation while you decide." : labState === "denied" ? "Motion access was blocked. Try again or use keyboard simulation." : labState === "unsupported" ? "Motion sensors are unavailable here. Use keyboard simulation." : labState === "simulated" ? "Keyboard simulation uses arrow keys. Device sensors are off." : labState === "active" ? "Device motion is active. Switch to keyboard simulation to turn sensors off." : "Choose device motion or keyboard simulation."}</p>
        </aside>
      </section>
      <section className="sensor-table">
        <SensorRow label="ACCELERATION" raw={raw.acceleration} filtered={filtered.acceleration} unit="m/s²" />
        <SensorRow label="ANGULAR VELOCITY" raw={raw.angularVelocity} filtered={filtered.angularVelocity} unit="°/s" />
      </section>
      <p className="motion-keyboard-hint">Keyboard simulation: use arrow keys to rotate the model. Real games always retain their own keyboard/gamepad fallback.</p>
    </main>
  );
}

function SensorRow({ label, raw, filtered, unit }: { label: string; raw: readonly number[]; filtered: readonly number[]; unit: string }) {
  return <article><span>{label}</span><div><small>RAW</small><code>{raw.map((value) => value.toFixed(2)).join(" / ")}</code></div><div><small>FILTERED</small><code>{filtered.map((value) => value.toFixed(2)).join(" / ")}</code></div><b>{unit}</b></article>;
}
