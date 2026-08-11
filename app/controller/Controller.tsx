"use client";

import { BrowserMotionAdapter, isMotionSupported, requestMotionPermission } from "@101/adapter-motion";
import type { InputFrame, InputVector } from "@101/input";
import {
  BroadcastChannelTransport,
  PROTOCOL_VERSION,
  type ControllerElement,
  type ControllerLayout,
} from "@101/protocol";
import { useEffect, useId, useRef, useState } from "react";

interface ControllerState {
  actions: Record<string, boolean | number>;
  axes: Record<string, number>;
  vectors: Record<string, InputVector>;
}

interface Assignment {
  gameId: string;
  role: string;
  playerId: string;
}

interface ControllerReadout {
  values: Record<string, string | number | boolean>;
  message?: string;
  tone: "normal" | "warning" | "critical";
}

const DEFAULT_LAYOUT: ControllerLayout = {
  title: "Classic Controller",
  accent: "#b5ff66",
  layout: [
    { type: "dpad", action: "move", label: "MOVE" },
    { type: "button", action: "buttonB", label: "B", emphasis: "normal" },
    { type: "button", action: "trigger", label: "A", emphasis: "primary" },
  ],
};

export default function Controller({ session }: { session: string }) {
  const [connected, setConnected] = useState(false);
  const [assignment, setAssignment] = useState<Assignment>({ gameId: "launcher", role: "classic", playerId: "player-1" });
  const [layout, setLayout] = useState<ControllerLayout>(DEFAULT_LAYOUT);
  const [vectors, setVectors] = useState<Record<string, InputVector>>({ move: { x: 0, y: 0 } });
  const [readout, setReadout] = useState<ControllerReadout>({ values: {}, tone: "normal" });
  const [motionState, setMotionState] = useState<"idle" | "active" | "denied" | "unsupported">("idle");
  const transportRef = useRef<BroadcastChannelTransport | null>(null);
  const motionAdapterRef = useRef<BrowserMotionAdapter | null>(null);
  const playerIdRef = useRef("player-1");
  const layoutRef = useRef(layout);
  const inputRef = useRef<ControllerState>({ actions: {}, axes: {}, vectors: {} });
  const sequence = useRef(0);
  const reactId = useId();
  const deviceId = `link-${reactId.replace(/[^a-z0-9]/gi, "").toLowerCase() || "controller"}`;

  useEffect(() => { layoutRef.current = layout; }, [layout]);

  useEffect(() => {
    const transport = new BroadcastChannelTransport(session);
    transportRef.current = transport;
    const removeListener = transport.onMessage((message) => {
      if (message.channel !== "control") return;
      const payload = message.payload;
      if (payload.type === "player.assign" && payload.deviceId === deviceId) {
        playerIdRef.current = payload.playerId;
        setAssignment({ gameId: payload.gameId, role: payload.role, playerId: payload.playerId });
        setConnected(true);
      }
      if (payload.type === "controller.configure" && payload.deviceId === deviceId) {
        setLayout(payload.layout);
        setReadout({ values: {}, tone: "normal", message: `${payload.role.toUpperCase()} PANEL READY` });
      }
      if (payload.type === "controller.state" && payload.deviceId === deviceId) {
        setReadout({ values: payload.values, message: payload.message, tone: payload.tone ?? "normal" });
      }
      if (payload.type === "haptic" && payload.deviceId === deviceId) {
        navigator.vibrate?.(payload.pattern === "warning" ? [50, 35, 50] : payload.pattern === "impact" ? 35 : 15);
      }
    });
    const hello = () => transport.sendReliable({
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId,
      device: "101 Link browser controller",
      capabilities: {
        touch: true,
        haptics: "vibrate" in navigator,
        accelerometer: isMotionSupported(),
        gyroscope: isMotionSupported(),
      },
    });
    void transport.connect().then(hello);
    const helloTimer = window.setInterval(hello, 1_600);
    return () => {
      window.clearInterval(helloTimer);
      removeListener();
      void transport.disconnect();
      transportRef.current = null;
    };
  }, [deviceId, session]);

  useEffect(() => () => { void motionAdapterRef.current?.stop(); }, []);

  const publish = (source: InputFrame["source"] = "custom") => {
    const current = inputRef.current;
    transportRef.current?.sendRealtime({
      deviceId,
      playerId: playerIdRef.current,
      sequence: ++sequence.current,
      timestamp: performance.now(),
      source,
      actions: { ...current.actions },
      axes: { ...current.axes },
      vectors: Object.fromEntries(Object.entries(current.vectors).map(([name, vector]) => [name, { ...vector }])),
    });
  };

  const setAction = (action: string, active: boolean | number) => {
    inputRef.current.actions[action] = active;
    publish();
  };

  const setAxis = (action: string, value: number) => {
    inputRef.current.axes[action] = clamp(value);
    publish();
  };

  const setVector = (action: string, x: number, y: number, source: InputFrame["source"] = "custom") => {
    const vector = { x: clamp(x), y: clamp(y) };
    inputRef.current.vectors[action] = vector;
    inputRef.current.axes[action] = vector.x;
    inputRef.current.axes[`${action}X`] = vector.x;
    inputRef.current.axes[`${action}Y`] = vector.y;
    if (action === "move") {
      inputRef.current.axes.moveX = vector.x;
      inputRef.current.axes.moveY = vector.y;
    }
    if (action === "steer") inputRef.current.axes.steer = vector.x;
    setVectors((current) => ({ ...current, [action]: vector }));
    publish(source);
  };

  const haptic = () => navigator.vibrate?.(20);

  const enableMotion = async () => {
    const permission = await requestMotionPermission();
    if (permission !== "granted") {
      setMotionState(permission);
      return;
    }
    await motionAdapterRef.current?.stop();
    const adapter = new BrowserMotionAdapter({ deviceId, playerId: playerIdRef.current });
    motionAdapterRef.current = adapter;
    adapter.start((frame) => {
      const motion = layoutRef.current.motion;
      const tilt = frame.vectors?.tilt;
      if (!motion || !tilt) return;
      inputRef.current.actions = { ...inputRef.current.actions, ...frame.actions };
      inputRef.current.axes = { ...inputRef.current.axes, ...frame.axes };
      setVector(motion.action, tilt.x, tilt.y, "phone-motion");
    });
    adapter.calibrateNeutral();
    setMotionState("active");
  };

  const calibrate = () => {
    motionAdapterRef.current?.calibrateNeutral();
    haptic();
  };

  const roleClass = assignment.role.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return (
    <main className={`controller-page role-${roleClass}`} style={{ "--controller-accent": layout.accent ?? "#b5ff66" } as React.CSSProperties}>
      <header className="controller-top">
        <div className="wordmark"><span className="mark-block">101</span><span className="mark-label">LINK / {assignment.role.toUpperCase()}</span></div>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? "LINKED" : "WAITING"}</div>
      </header>
      <section className="controller-session">
        <span>SESSION</span><strong>{session}</strong>
        <small>{connected ? `${assignment.gameId.toUpperCase()} · ${assignment.playerId.toUpperCase()}` : "Open a 101 game on the host"}</small>
      </section>

      <section className="dynamic-controller-heading">
        <span>ROLE AUTO-SYNCED</span>
        <h1>{layout.title ?? assignment.role}</h1>
      </section>

      <DynamicControllerDeck
        elements={layout.layout}
        vectors={vectors}
        setAction={setAction}
        setAxis={setAxis}
        setVector={setVector}
        haptic={haptic}
      />

      {layout.motion && (
        <section className="motion-permission">
          <button onClick={motionState === "active" ? calibrate : enableMotion}>{motionState === "active" ? "SET NEUTRAL" : "ENABLE MOTION"}</button>
          <p>{motionState === "active" ? `${layout.motion.label ?? "Motion"} is processed locally and mapped to ${layout.motion.action}.` : motionState === "denied" ? "Motion permission was not granted. Touch controls remain available." : motionState === "unsupported" ? "Motion is unavailable here. Touch controls remain available." : `${layout.motion.label ?? "Motion Sensors"}: optional ${layout.motion.mode} control.`}</p>
        </section>
      )}

      <ControllerStatus readout={readout} />
      <p className="controller-footnote">The host can replace this JSON-defined panel without reconnecting. Games receive normalized 101 input only.</p>
    </main>
  );
}

function DynamicControllerDeck({
  elements,
  vectors,
  setAction,
  setAxis,
  setVector,
  haptic,
}: {
  elements: readonly ControllerElement[];
  vectors: Record<string, InputVector>;
  setAction(action: string, active: boolean | number): void;
  setAxis(action: string, value: number): void;
  setVector(action: string, x: number, y: number): void;
  haptic(): void;
}) {
  return (
    <section className="dynamic-controller-deck" aria-label="Role controller">
      {elements.map((element, index) => {
        const key = `${element.type}-${element.action}-${index}`;
        if (element.type === "button") {
          return (
            <button
              key={key}
              className={`dynamic-action action-${element.emphasis ?? "normal"}`}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); haptic(); setAction(element.action, true); }}
              onPointerUp={() => setAction(element.action, false)}
              onPointerCancel={() => setAction(element.action, false)}
            >
              <span>{element.label}</span><small>{element.action}</small>
            </button>
          );
        }
        if (element.type === "slider") {
          const min = element.min ?? -1;
          const max = element.max ?? 1;
          return (
            <label className="dynamic-slider" key={key}>
              <span>{element.label}</span>
              <input type="range" min={min} max={max} step={element.step ?? .01} defaultValue={(min + max) / 2} onChange={(event) => setAxis(element.action, Number(event.currentTarget.value))} />
              <small>{element.action}</small>
            </label>
          );
        }
        if (element.type === "dpad") {
          return <DynamicDpad key={key} element={element} setVector={setVector} />;
        }
        return <DynamicSurface key={key} element={element} vector={vectors[element.action] ?? { x: 0, y: 0 }} setVector={setVector} />;
      })}
    </section>
  );
}

function DynamicDpad({ element, setVector }: { element: Extract<ControllerElement, { type: "dpad" }>; setVector(action: string, x: number, y: number): void }) {
  const release = () => setVector(element.action, 0, 0);
  return (
    <div className="dynamic-dpad" aria-label={element.label ?? element.action}>
      <span>{element.label ?? element.action}</span>
      <button className="up" aria-label="Up" onPointerDown={() => setVector(element.action, 0, -1)} onPointerUp={release} onPointerLeave={release}>▲</button>
      <button className="left" aria-label="Left" onPointerDown={() => setVector(element.action, -1, 0)} onPointerUp={release} onPointerLeave={release}>◀</button>
      <i />
      <button className="right" aria-label="Right" onPointerDown={() => setVector(element.action, 1, 0)} onPointerUp={release} onPointerLeave={release}>▶</button>
      <button className="down" aria-label="Down" onPointerDown={() => setVector(element.action, 0, 1)} onPointerUp={release} onPointerLeave={release}>▼</button>
    </div>
  );
}

function DynamicSurface({ element, vector, setVector }: {
  element: Extract<ControllerElement, { type: "joystick" | "touch-surface" }>;
  vector: InputVector;
  setVector(action: string, x: number, y: number): void;
}) {
  const update = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setVector(
      element.action,
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
    );
  };
  const release = () => setVector(element.action, 0, 0);
  return (
    <div
      className={`dynamic-surface surface-${element.type}`}
      role="group"
      aria-label={element.label ?? element.action}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); update(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event); }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span>{element.label ?? element.action}</span>
      <i className="surface-crosshair" />
      <b style={{ left: `${(vector.x + 1) * 50}%`, top: `${(vector.y + 1) * 50}%` }}>101</b>
      <small>{element.action}</small>
    </div>
  );
}

function ControllerStatus({ readout }: { readout: ControllerReadout }) {
  const values = Object.entries(readout.values);
  return (
    <section className={`controller-role-status status-${readout.tone}`} aria-live="polite">
      <div><span>SHIP FEED</span><strong>{readout.message ?? "AWAITING HOST DATA"}</strong></div>
      {values.length > 0 && <dl>{values.slice(0, 6).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{typeof value === "number" ? Math.round(value) : String(value)}</dd></div>)}</dl>}
    </section>
  );
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}
