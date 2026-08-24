"use client";

import type { InputFrame } from "@101/input";
import { BroadcastChannelTransport, parseControllerLayout, type ControllerLayout } from "@101/protocol";
import { LocalSession, SessionHost, type SessionSnapshot } from "@101/session";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const SESSION = "CTRL01";
const PRESETS: Record<string, ControllerLayout> = {
  classic: {
    title: "Classic Controller",
    layout: [
      { type: "dpad", action: "move", label: "MOVE" },
      { type: "button", action: "trigger", label: "TRIGGER", emphasis: "primary" },
    ],
  },
  flight: {
    title: "Flight Console",
    motion: { action: "flight", mode: "tilt", label: "Phone tilt" },
    layout: [
      { type: "joystick", action: "flight", label: "FLIGHT VECTOR" },
      { type: "button", action: "boost", label: "BOOST", emphasis: "primary" },
    ],
  },
  reactor: {
    title: "Reactor Console",
    layout: [
      { type: "slider", action: "power", label: "OUTPUT", min: .2, max: 1, step: .01 },
      { type: "button", action: "vent", label: "VENT" },
      { type: "button", action: "scram", label: "SCRAM", emphasis: "danger" },
    ],
  },
  gamepad: {
    title: "Full Gamepad",
    handedness: "right",
    layout: [
      { type: "joystick", action: "move", label: "MOVE", side: "left", zone: "thumb", size: "large", span: 2, priority: 100, deadZone: .14, responseCurve: 1.4 },
      { type: "shoulder", action: "guard", label: "LB · HOLD", side: "left", zone: "shoulder", interaction: { type: "hold", thresholdMs: 450 } },
      { type: "trigger", action: "throttle", label: "RT", side: "right", zone: "index", size: "large", priority: 100 },
      { type: "analog-button", action: "brake", label: "PRESSURE", side: "right", zone: "thumb", size: "large", priority: 90 },
      { type: "button", action: "dash", label: "DOUBLE DASH", side: "right", zone: "thumb", interaction: { type: "double-tap", intervalMs: 300 } },
      { type: "button", action: "lock", label: "LOCK", side: "center", zone: "edge", size: "small", interaction: { type: "toggle" } },
      { type: "button", action: "special", label: "CHORD", side: "right", zone: "thumb", interaction: { type: "chord", actions: ["guard", "focus"] } },
    ],
  },
};

export default function ControllerLab() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({ code: SESSION, gameId: "controller-lab", revision: 0, devices: [], assignments: [], openRoles: [] });
  const [latest, setLatest] = useState<InputFrame>();
  const [json, setJson] = useState(() => JSON.stringify(PRESETS.classic, null, 2));
  const [error, setError] = useState("");
  const [applied, setApplied] = useState("classic");
  const hostRef = useRef<SessionHost | null>(null);

  useEffect(() => {
    const transport = new BroadcastChannelTransport(SESSION);
    const host = new SessionHost({
      gameId: "controller-lab",
      roles: [labRole(PRESETS.classic!)],
      transport,
      session: new LocalSession(SESSION),
      onFrame: setLatest,
      onDeviceReset: () => setLatest(undefined),
      onChange: setSnapshot,
    });
    hostRef.current = host;
    void host.start();
    return () => { hostRef.current = null; void host.stop(); };
  }, []);

  const choosePreset = (name: string) => {
    const preset = PRESETS[name];
    if (!preset) return;
    setJson(JSON.stringify(preset, null, 2));
    applyLayout(preset, name);
  };

  const applyJson = () => {
    try {
      applyLayout(parseControllerLayout(JSON.parse(json) as unknown), "custom");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid controller layout JSON");
    }
  };

  const applyLayout = (layout: ControllerLayout, label: string) => {
    hostRef.current?.setGame("controller-lab", [labRole(layout)]);
    setApplied(label);
    setError("");
  };

  const connected = snapshot.assignments.length > 0;
  return (
    <main className="controller-lab-page">
      <header className="controller-lab-topbar">
        <Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">CONTROLLER LAB</span></Link>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? "DEVICE LINKED" : "WAITING FOR LINK"}</div>
      </header>

      <section className="controller-lab-intro">
        <p className="eyebrow">Diagnostic 05 · Dynamic controller schema</p>
        <h1>Design the panel.<br />Watch the bus.</h1>
        <p>Apply a validated JSON layout to 101 Link, then inspect the normalized actions, axes, and vectors it emits. No game-specific phone code is involved.</p>
      </section>

      <section className="controller-lab-workbench">
        <div className="layout-editor">
          <div className="controller-lab-section-title"><span>CONTROLLER LAYOUT</span><b>{applied.toUpperCase()}</b></div>
          <div className="preset-row">{Object.keys(PRESETS).map((name) => <button className={applied === name ? "active" : ""} key={name} onClick={() => choosePreset(name)}>{name}</button>)}</div>
          <textarea value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} aria-label="Controller layout JSON" />
          <button className="primary-button" onClick={applyJson}>Validate + apply layout ↗</button>
          {error && <p className="controller-layout-error" role="alert">{error}</p>}
        </div>

        <div className="controller-lab-preview">
          <div className="controller-lab-section-title"><span>LIVE LINK</span><b>SESSION {SESSION}</b></div>
          <div className="controller-lab-link-card">
            <span>01</span><div><strong>Open the controller</strong><p>The active layout replaces the phone panel immediately.</p></div>
            <a href={`/controller?session=${SESSION}`} target="_blank" rel="noreferrer">OPEN LINK ↗</a>
          </div>
          <div className="controller-lab-link-card">
            <span>02</span><div><strong>Interact with it</strong><p>Buttons, analog triggers, shoulders, sticks, sliders, surfaces, D-pads, and optional motion publish the same frame contract.</p></div>
            <b>{connected ? snapshot.assignments[0]?.deviceId : "NO DEVICE"}</b>
          </div>
          <div className="frame-inspector">
            <div><span>LATEST NORMALIZED FRAME</span><b>{latest?.source?.toUpperCase() ?? "WAITING"}</b></div>
            <dl>
              <FrameGroup label="ACTIONS" value={latest?.actions} />
              <FrameGroup label="AXES" value={latest?.axes} />
              <FrameGroup label="VECTORS" value={latest?.vectors} />
            </dl>
          </div>
        </div>
      </section>
      <p className="controller-lab-note"><b>SCHEMA BOUNDARY</b> Layouts validate element types, action names, analog ranges, gesture semantics, placement hints, stick tuning, handedness, colors, and optional motion mappings before the host sends them.</p>
    </main>
  );
}

function FrameGroup({ label, value }: { label: string; value: unknown }) {
  return <div><dt>{label}</dt><dd><code>{value ? JSON.stringify(value, null, 2) : "—"}</code></dd></div>;
}

function labRole(layout: ControllerLayout) {
  return {
    id: "designer",
    label: "Layout Preview",
    playerId: "player-1",
    requiredCapabilities: ["touch" as const],
    preferredCapabilities: ["gyroscope" as const],
    layout,
  };
}
