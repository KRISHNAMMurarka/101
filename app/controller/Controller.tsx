"use client";

import { BrowserMotionAdapter, isMotionSupported, requestMotionPermission } from "@101/adapter-motion";
import type { InputFrame, InputVector } from "@101/input";
import { ControllerInputModel, type ControllerInputSnapshot } from "@101/link-controller";
import { HttpControllerSignalingClient, SignaledLinkTransport } from "@101/pairing";
import {
  BroadcastChannelTransport,
  PROTOCOL_VERSION,
  decodePairingTicket,
  type ControllerElement,
  type ControllerLayout,
  type LinkTransport,
  type StatefulLinkTransport,
} from "@101/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

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

const STANDBY_LAYOUT: ControllerLayout = { title: "Role Standby", accent: "#8d9791", layout: [] };

export default function Controller({ session, pairCode }: { session: string; pairCode?: string }) {
  const [connected, setConnected] = useState(false);
  const [assigned, setAssigned] = useState(false);
  const [deviceId] = useState(() => {
    if (typeof window === "undefined") return "";
    const storageKey = "101-link-device-id";
    const existing = sessionStorage.getItem(storageKey);
    const id = existing ?? `link-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    sessionStorage.setItem(storageKey, id);
    return id;
  });
  const [assignment, setAssignment] = useState<Assignment>({ gameId: "launcher", role: "classic", playerId: "player-1" });
  const [layout, setLayout] = useState<ControllerLayout>(DEFAULT_LAYOUT);
  const [vectors, setVectors] = useState<Record<string, InputVector>>({ move: { x: 0, y: 0 } });
  const [axes, setAxes] = useState<Record<string, number>>({});
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [readout, setReadout] = useState<ControllerReadout>({ values: {}, tone: "normal" });
  const [motionState, setMotionState] = useState<"idle" | "active" | "denied" | "unsupported">("idle");
  const transportRef = useRef<LinkTransport | null>(null);
  const motionAdapterRef = useRef<BrowserMotionAdapter | null>(null);
  const playerIdRef = useRef("player-1");
  const layoutRef = useRef(layout);
  const inputRef = useRef<ControllerInputModel | null>(null);
  if (inputRef.current == null) inputRef.current = new ControllerInputModel(DEFAULT_LAYOUT);
  const configurationRef = useRef("");
  const lastHostMessageAt = useRef(0);
  const sequence = useRef(0);

  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const publishSnapshot = useCallback((current: ControllerInputSnapshot, source: InputFrame["source"] = "custom") => {
    transportRef.current?.sendRealtime({
      deviceId,
      playerId: playerIdRef.current,
      sequence: ++sequence.current,
      timestamp: performance.now(),
      source,
      actions: current.actions,
      axes: current.axes,
      vectors: current.vectors,
    });
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) return;
    const capabilities = {
      touch: true,
      haptics: "vibrate" in navigator,
      accelerometer: isMotionSupported(),
      gyroscope: isMotionSupported(),
    };
    let transport: LinkTransport;
    try {
      transport = pairCode
        ? new SignaledLinkTransport({
            signaling: new HttpControllerSignalingClient(decodePairingTicket(pairCode)),
            device: { deviceId, label: "101 Link browser controller", capabilities },
          })
        : new BroadcastChannelTransport(session);
    } catch (error) {
      queueMicrotask(() => setReadout({ values: {}, tone: "critical", message: error instanceof Error ? error.message.toUpperCase() : "INVALID PAIRING TICKET" }));
      return;
    }
    transportRef.current = transport;
    const removeListener = transport.onMessage((message) => {
      if (message.channel !== "control") return;
      const payload = message.payload;
      if (payload.type === "player.assign" && payload.deviceId === deviceId) {
        lastHostMessageAt.current = performance.now();
        playerIdRef.current = payload.playerId;
        setAssignment({ gameId: payload.gameId, role: payload.role, playerId: payload.playerId });
        setConnected(true);
        setAssigned(true);
      }
      if (payload.type === "player.wait" && payload.deviceId === deviceId) {
        lastHostMessageAt.current = performance.now();
        publishSnapshot(inputRef.current!.releaseAll());
        configurationRef.current = "";
        layoutRef.current = STANDBY_LAYOUT;
        setLayout(STANDBY_LAYOUT);
        setVectors({});
        setAxes({});
        setAssignment({ gameId: payload.gameId, role: "standby", playerId: "unassigned" });
        setConnected(true);
        setAssigned(false);
        if (motionAdapterRef.current) void motionAdapterRef.current.stop();
        motionAdapterRef.current = null;
        setMotionState("idle");
        setReadout({ values: {}, tone: "normal", message: "CONNECTED · WAITING FOR AN OPEN ROLE" });
      }
      if (payload.type === "controller.configure" && payload.deviceId === deviceId) {
        lastHostMessageAt.current = performance.now();
        setConnected(true);
        setAssigned(true);
        const configuration = `${payload.gameId}:${payload.role}:${payload.revision}`;
        if (configurationRef.current === configuration) return;
        configurationRef.current = configuration;
        const transition = inputRef.current!.transition(payload.layout);
        publishSnapshot(transition.release);
        publishSnapshot(transition.current);
        layoutRef.current = payload.layout;
        setLayout(payload.layout);
        setVectors(transition.current.vectors);
        setAxes(transition.current.axes);
        setLayoutRevision(payload.revision);
        if (!payload.layout.motion && motionAdapterRef.current) {
          void motionAdapterRef.current.stop();
          motionAdapterRef.current = null;
          setMotionState("idle");
        }
        setReadout({ values: {}, tone: "normal", message: `${payload.role.toUpperCase()} PANEL READY` });
      }
      if (payload.type === "controller.state" && payload.deviceId === deviceId) {
        lastHostMessageAt.current = performance.now();
        setReadout({ values: payload.values, message: payload.message, tone: payload.tone ?? "normal" });
      }
      if (payload.type === "haptic" && payload.deviceId === deviceId) {
        lastHostMessageAt.current = performance.now();
        navigator.vibrate?.(payload.pattern === "warning" ? [50, 35, 50] : payload.pattern === "impact" ? 35 : 15);
      }
    });
    const hello = () => transport.sendReliable({
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId,
      device: "101 Link browser controller",
      capabilities,
    });
    const removeState = isStateful(transport) ? transport.onStateChange((state) => {
      if (state === "connected") hello();
      if (state === "failed" || state === "disconnected") {
        setConnected(false);
        setReadout({ values: {}, tone: "warning", message: "LINK INTERRUPTED · RECONNECTING" });
      }
    }) : () => undefined;
    void transport.connect().then(hello).catch(() => {
      setConnected(false);
      setReadout({ values: {}, tone: "critical", message: "LINK TRANSPORT UNAVAILABLE" });
    });
    const helloTimer = window.setInterval(hello, 1_600);
    const watchdogTimer = window.setInterval(() => {
      if (!lastHostMessageAt.current || performance.now() - lastHostMessageAt.current <= 4_800) return;
      setConnected((wasConnected) => {
        if (!wasConnected) return false;
        publishSnapshot(inputRef.current!.releaseAll());
        configurationRef.current = "";
        setAssigned(false);
        setReadout({ values: {}, tone: "warning", message: "HOST SIGNAL LOST · RECONNECTING" });
        return false;
      });
    }, 800);
    return () => {
      window.clearInterval(helloTimer);
      window.clearInterval(watchdogTimer);
      publishSnapshot(inputRef.current!.releaseAll());
      removeListener();
      removeState();
      void transport.disconnect();
      void motionAdapterRef.current?.stop();
      motionAdapterRef.current = null;
      transportRef.current = null;
    };
  }, [deviceId, pairCode, publishSnapshot, session]);

  const setAction = (action: string, active: boolean | number) => {
    publishSnapshot(inputRef.current!.setAction(action, active));
  };

  const setAxis = (action: string, value: number) => {
    const snapshot = inputRef.current!.setAxis(action, value);
    setAxes(snapshot.axes);
    publishSnapshot(snapshot);
  };

  const setVector = (action: string, x: number, y: number, source: InputFrame["source"] = "custom") => {
    const snapshot = inputRef.current!.setVector(action, x, y);
    setVectors(snapshot.vectors);
    setAxes(snapshot.axes);
    publishSnapshot(snapshot, source);
  };

  const haptic = () => navigator.vibrate?.(20);

  const enableMotion = async () => {
    try {
      const permission = await requestMotionPermission();
      if (permission !== "granted") {
        setMotionState(permission);
        return;
      }
      await motionAdapterRef.current?.stop();
      let awaitingNeutralSample = true;
      const adapter = new BrowserMotionAdapter({ deviceId, playerId: playerIdRef.current });
      motionAdapterRef.current = adapter;
      adapter.start((frame) => {
        if (awaitingNeutralSample) {
          adapter.calibrateNeutral();
          awaitingNeutralSample = false;
          return;
        }
        const motion = layoutRef.current.motion;
        const tilt = frame.vectors?.tilt;
        if (!motion || !tilt) return;
        const actions = { ...frame.actions };
        for (const [gesture, action] of Object.entries(motion.gestures ?? {})) {
          if (action) actions[action] = Boolean(frame.actions[gesture]);
        }
        inputRef.current!.mergeMotion(actions, frame.axes);
        setVector(motion.action, tilt.x, tilt.y, "phone-motion");
      });
      setMotionState("active");
    } catch {
      setMotionState("denied");
    }
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
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? assigned ? "LINKED" : "STANDBY" : "WAITING"}</div>
      </header>
      <section className="controller-session">
        <span>SESSION</span><strong>{session}</strong>
        <small>{connected ? assigned ? `${assignment.gameId.toUpperCase()} · ${assignment.playerId.toUpperCase()}` : `${assignment.gameId.toUpperCase()} · WAITING FOR ROLE` : "Open a 101 game on the host"}</small>
      </section>

      <section className="dynamic-controller-heading">
        <span>ROLE AUTO-SYNCED</span>
        <h1>{layout.title ?? assignment.role}</h1>
      </section>

      <DynamicControllerDeck
        key={`${assignment.gameId}:${assignment.role}:${layoutRevision}`}
        elements={layout.layout}
        vectors={vectors}
        axes={axes}
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

function isStateful(transport: LinkTransport): transport is StatefulLinkTransport {
  return "onStateChange" in transport && typeof transport.onStateChange === "function";
}

function DynamicControllerDeck({
  elements,
  vectors,
  axes,
  setAction,
  setAxis,
  setVector,
  haptic,
}: {
  elements: readonly ControllerElement[];
  vectors: Record<string, InputVector>;
  axes: Record<string, number>;
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
              onLostPointerCapture={() => setAction(element.action, false)}
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
              <input type="range" min={min} max={max} step={element.step ?? .01} value={axes[element.action] ?? (min + max) / 2} onChange={(event) => setAxis(element.action, Number(event.currentTarget.value))} />
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
      <button className="up" aria-label="Up" onPointerDown={() => setVector(element.action, 0, -1)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>▲</button>
      <button className="left" aria-label="Left" onPointerDown={() => setVector(element.action, -1, 0)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>◀</button>
      <i />
      <button className="right" aria-label="Right" onPointerDown={() => setVector(element.action, 1, 0)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>▶</button>
      <button className="down" aria-label="Down" onPointerDown={() => setVector(element.action, 0, 1)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>▼</button>
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
      onLostPointerCapture={release}
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
      <div><span>ROLE FEED</span><strong>{readout.message ?? "AWAITING HOST DATA"}</strong></div>
      {values.length > 0 && <dl>{values.slice(0, 6).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{typeof value === "number" ? Math.round(value) : String(value)}</dd></div>)}</dl>}
    </section>
  );
}
