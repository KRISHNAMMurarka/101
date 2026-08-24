"use client";

import { BrowserMotionAdapter, isMotionSupported, requestMotionPermission } from "@101/adapter-motion";
import type { InputFrame, InputVector } from "@101/input";
import {
  ControllerActionGesture,
  ControllerInputModel,
  normalizeJoystick,
  resolveControllerSide,
  type ControllerInputSnapshot,
} from "@101/link-controller";
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

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DEFAULT_LAYOUT: ControllerLayout = {
  title: "Classic Controller",
  handedness: "right",
  layout: [
    { type: "dpad", action: "move", label: "MOVE", side: "left", zone: "thumb", size: "large", span: 2, priority: 100 },
    { type: "button", action: "buttonB", label: "B", emphasis: "normal", side: "right", zone: "thumb", size: "small", span: 1, priority: 80 },
    { type: "button", action: "trigger", label: "A", emphasis: "primary", side: "right", zone: "thumb", size: "small", span: 1, priority: 90 },
  ],
};

const STANDBY_LAYOUT: ControllerLayout = { title: "Role Standby", layout: [] };
const HANDEDNESS_STORAGE_KEY = "101-link-handedness";
type Handedness = NonNullable<ControllerLayout["handedness"]>;

export default function Controller({ session, pairCode }: { session: string; pairCode?: string }) {
  const [connected, setConnected] = useState(false);
  const [assigned, setAssigned] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [pairEntry, setPairEntry] = useState("");
  const [deviceId] = useState(() => {
    if (typeof window === "undefined") return "";
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    const storage = standalone ? localStorage : sessionStorage;
    const storageKey = "101-link-device-id";
    const existing = storage.getItem(storageKey);
    const id = existing ?? `link-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    storage.setItem(storageKey, id);
    return id;
  });
  const [assignment, setAssignment] = useState<Assignment>({ gameId: "launcher", role: "classic", playerId: "player-1" });
  const [layout, setLayout] = useState<ControllerLayout>(DEFAULT_LAYOUT);
  const [actions, setActionsState] = useState<Record<string, boolean | number>>({ buttonB: false, trigger: false });
  const [vectors, setVectors] = useState<Record<string, InputVector>>({ move: { x: 0, y: 0 } });
  const [axes, setAxes] = useState<Record<string, number>>({});
  const [handednessOverride, setHandednessOverride] = useState<Handedness>();
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

  useEffect(() => {
    try {
      const saved = localStorage.getItem(HANDEDNESS_STORAGE_KEY);
      if (saved === "left" || saved === "right") setHandednessOverride(saved);
    } catch {
      // Private browsing can deny storage. The author preference remains a complete fallback.
    }
  }, []);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    const captureInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("beforeinstallprompt", captureInstall);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/controller" });
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("beforeinstallprompt", captureInstall);
    };
  }, []);

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
      if (message.channel === "realtime") {
        const payload = message.payload;
        if ("type" in payload && payload.type === "haptic" && payload.deviceId === deviceId) {
          lastHostMessageAt.current = performance.now();
          navigator.vibrate?.(payload.pattern === "warning" ? [50, 35, 50] : payload.pattern === "impact" ? 35 : 15);
        }
        return;
      }
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
        setActionsState({});
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
        setActionsState(transition.current.actions);
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

  const setActions = useCallback((values: Record<string, boolean | number>, owner?: string) => {
    const snapshot = inputRef.current!.setActions(values, owner);
    setActionsState(snapshot.actions);
    publishSnapshot(snapshot);
  }, [publishSnapshot]);

  const setAction = useCallback((action: string, active: boolean | number) => {
    setActions({ [action]: active });
  }, [setActions]);

  const setAxis = useCallback((action: string, value: number) => {
    const snapshot = inputRef.current!.setAxis(action, value);
    setAxes(snapshot.axes);
    publishSnapshot(snapshot);
  }, [publishSnapshot]);

  const setVector = useCallback((action: string, x: number, y: number, source: InputFrame["source"] = "custom") => {
    const snapshot = inputRef.current!.setVector(action, x, y);
    setVectors(snapshot.vectors);
    setAxes(snapshot.axes);
    publishSnapshot(snapshot, source);
  }, [publishSnapshot]);

  const haptic = useCallback(() => navigator.vibrate?.(20), []);

  const authoredHandedness = layout.handedness ?? "right";
  const playerHandedness = handednessOverride ?? authoredHandedness;
  const canFlipHandedness = layout.layout.some((element) => (element.side ?? defaultControlSide(element)) !== "center");
  const flipHandedness = () => {
    const next = playerHandedness === "right" ? "left" : "right";
    setHandednessOverride(next);
    try {
      localStorage.setItem(HANDEDNESS_STORAGE_KEY, next);
    } catch {
      // The in-memory preference still works for this session.
    }
    haptic();
  };

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

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(undefined);
  };

  const connectPairing = () => {
    try {
      const value = pairEntry.trim();
      const code = value.startsWith("http://") || value.startsWith("https://")
        ? new URL(value).searchParams.get("pair")
        : value;
      if (!code) throw new Error("Paste a 101 pairing ticket or URL");
      const ticket = decodePairingTicket(code);
      const target = new URL("/controller", window.location.origin);
      target.searchParams.set("pair", code);
      target.searchParams.set("session", ticket.sessionId);
      window.location.assign(target);
    } catch (error) {
      setReadout({ values: {}, tone: "critical", message: error instanceof Error ? error.message.toUpperCase() : "INVALID PAIRING TICKET" });
    }
  };

  const roleClass = assignment.role.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return (
    // A layout may carry `accent`, and 101 Link deliberately ignores it. Ten games each choosing a
    // hue turns one controller into ten unrelated ones, and a saturated fill under the player's
    // thumb is the last place attention belongs. Emphasis comes from weight instead.
    <main className={`controller-page role-${roleClass}`}>
      <header className="controller-top">
        <div className="wordmark"><span className="mark-block">101</span><span className="mark-label">LINK / {assignment.role.toUpperCase()}</span></div>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? assigned ? "LINKED" : "STANDBY" : "WAITING"}</div>
      </header>
      <section className="controller-session">
        <span>SESSION</span><strong>{session}</strong>
        <small>{connected ? assigned ? `${assignment.gameId.toUpperCase()} · ${assignment.playerId.toUpperCase()}` : `${assignment.gameId.toUpperCase()} · WAITING FOR ROLE` : "Open a 101 game on the host"}</small>
      </section>

      <details className="link-runtime">
        <summary><span className={online ? "runtime-dot online" : "runtime-dot"} />{pairCode ? "LAN WEBRTC" : "SAME-BROWSER"} · {online ? "ONLINE" : "OFFLINE SHELL"}</summary>
        <div className="link-runtime-actions">
          {installPrompt && <button onClick={install}>INSTALL 101 LINK</button>}
          <label>
            <span>PAIRING URL / 101L2 TICKET</span>
            <input value={pairEntry} onChange={(event) => setPairEntry(event.target.value)} placeholder="Paste local pairing link" autoCapitalize="off" autoCorrect="off" />
          </label>
          <button onClick={connectPairing} disabled={!pairEntry.trim()}>CONNECT TO HOST</button>
          <p>Installable assets and controller layouts are cached locally. Pairing secrets are never written to the service-worker cache.</p>
        </div>
      </details>

      <section className="dynamic-controller-heading">
        <div>
          <span>ROLE AUTO-SYNCED</span>
          <h1>{layout.title ?? assignment.role}</h1>
        </div>
        {canFlipHandedness && (
          <button className="handedness-toggle" onClick={flipHandedness} aria-label={`Switch to ${playerHandedness === "right" ? "left" : "right"}-handed layout`}>
            <span>HAND</span><strong>{playerHandedness.toUpperCase()}</strong><i aria-hidden="true">↔</i>
          </button>
        )}
      </section>

      <DynamicControllerDeck
        key={`${assignment.gameId}:${assignment.role}:${layoutRevision}`}
        elements={layout.layout}
        actions={actions}
        vectors={vectors}
        axes={axes}
        authoredHandedness={authoredHandedness}
        playerHandedness={playerHandedness}
        setActions={setActions}
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
  actions,
  vectors,
  axes,
  authoredHandedness,
  playerHandedness,
  setActions,
  setAction,
  setAxis,
  setVector,
  haptic,
}: {
  elements: readonly ControllerElement[];
  actions: Record<string, boolean | number>;
  vectors: Record<string, InputVector>;
  axes: Record<string, number>;
  authoredHandedness: Handedness;
  playerHandedness: Handedness;
  setActions(values: Record<string, boolean | number>, owner?: string): void;
  setAction(action: string, active: boolean | number): void;
  setAxis(action: string, value: number): void;
  setVector(action: string, x: number, y: number): void;
  haptic(): void;
}) {
  const ordered = elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const byPriority = (b.element.priority ?? 50) - (a.element.priority ?? 50);
      return byPriority || a.index - b.index;
    });

  return (
    <section className="dynamic-controller-deck" aria-label="Role controller">
      {ordered.map(({ element, index }) => {
        const key = `${element.type}-${element.action}-${index}`;
        const side = resolveControllerSide(element.side ?? defaultControlSide(element), authoredHandedness, playerHandedness);
        const size = element.size ?? defaultControlSize(element);
        const span = element.span ?? defaultControlSpan(element, size);
        const zone = element.zone ?? defaultControlZone(element);
        const gridColumn = side === "left" ? `1 / span ${span}` : side === "right" ? `span ${span} / -1` : `span ${span}`;
        return (
          <div
            className="dynamic-control"
            data-control={element.type}
            data-side={side}
            data-zone={zone}
            data-size={size}
            data-priority={element.priority ?? 50}
            key={key}
            style={{ gridColumn }}
          >
            {(element.type === "button" || element.type === "shoulder") && (
              <DynamicDigitalAction element={element} owner={key} setActions={setActions} haptic={haptic} />
            )}
            {(element.type === "trigger" || element.type === "analog-button") && (
              <DynamicAnalogAction
                element={element}
                value={typeof actions[element.action] === "number" ? Number(actions[element.action]) : 0}
                setAction={setAction}
                haptic={haptic}
              />
            )}
            {element.type === "slider" && (() => {
              const min = element.min ?? -1;
              const max = element.max ?? 1;
              return (
                <label className="dynamic-slider">
                  <span>{element.label}</span>
                  <input type="range" min={min} max={max} step={element.step ?? .01} value={axes[element.action] ?? (min + max) / 2} onChange={(event) => setAxis(element.action, Number(event.currentTarget.value))} />
                  <small>{element.action}</small>
                </label>
              );
            })()}
            {element.type === "dpad" && <DynamicDpad element={element} setVector={setVector} />}
            {(element.type === "joystick" || element.type === "touch-surface") && (
              <DynamicSurface element={element} vector={vectors[element.action] ?? { x: 0, y: 0 }} setVector={setVector} />
            )}
          </div>
        );
      })}
    </section>
  );
}

type DigitalControllerElement = Extract<ControllerElement, { type: "button" | "shoulder" }>;
type AnalogControllerElement = Extract<ControllerElement, { type: "trigger" | "analog-button" }>;

function DynamicDigitalAction({ element, owner, setActions, haptic }: {
  element: DigitalControllerElement;
  owner: string;
  setActions(values: Record<string, boolean | number>, owner?: string): void;
  haptic(): void;
}) {
  const [active, setActive] = useState(false);
  const gestureRef = useRef<ControllerActionGesture | null>(null);
  const pointerIdRef = useRef<number | undefined>(undefined);
  const keyboardActiveRef = useRef(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const gesture = new ControllerActionGesture(element, {
      emit: (values) => { if (mounted) setActions(values, owner); },
      onActiveChange: (next) => { if (mounted) setActive(next); },
    });
    gestureRef.current = gesture;
    return () => {
      mounted = false;
      gesture.cancel();
      if (gestureRef.current === gesture) gestureRef.current = null;
    };
  }, [element, owner, setActions]);

  const press = () => {
    haptic();
    gestureRef.current?.press();
  };
  const release = () => gestureRef.current?.release();
  const cancel = () => gestureRef.current?.cancel();
  const interaction = element.interaction?.type;

  return (
    <button
      className={`dynamic-action ${element.type === "shoulder" ? "dynamic-shoulder" : ""} action-${element.type === "button" ? element.emphasis ?? "normal" : "normal"} interaction-${interaction ?? "press"}`}
      data-active={active ? "true" : "false"}
      aria-pressed={interaction === "toggle" ? active : undefined}
      onPointerDown={(event) => {
        if (pointerIdRef.current !== undefined) return;
        pointerIdRef.current = event.pointerId;
        suppressClickRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        press();
      }}
      onPointerUp={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        pointerIdRef.current = undefined;
        release();
      }}
      onPointerCancel={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        pointerIdRef.current = undefined;
        suppressClickRef.current = false;
        cancel();
      }}
      onLostPointerCapture={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        pointerIdRef.current = undefined;
        suppressClickRef.current = false;
        cancel();
      }}
      onKeyDown={(event) => {
        if ((event.key !== "Enter" && event.key !== " ") || event.repeat || keyboardActiveRef.current) return;
        event.preventDefault();
        keyboardActiveRef.current = true;
        suppressClickRef.current = true;
        press();
      }}
      onKeyUp={(event) => {
        if ((event.key !== "Enter" && event.key !== " ") || !keyboardActiveRef.current) return;
        event.preventDefault();
        keyboardActiveRef.current = false;
        release();
      }}
      onBlur={() => {
        if (!keyboardActiveRef.current) return;
        keyboardActiveRef.current = false;
        suppressClickRef.current = false;
        cancel();
      }}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        press();
        const delay = interaction === "hold" ? (element.interaction?.thresholdMs ?? 450) + 30 : 0;
        window.setTimeout(release, delay);
      }}
    >
      <span>{element.label}</span>
      <small>{interactionLabel(element)} · {element.action}</small>
    </button>
  );
}

function DynamicAnalogAction({ element, value, setAction, haptic }: {
  element: AnalogControllerElement;
  value: number;
  setAction(action: string, value: number): void;
  haptic(): void;
}) {
  const current = Math.max(0, Math.min(1, value));
  const release = () => setAction(element.action, 0);
  return (
    <label className={`dynamic-analog dynamic-${element.type}`} data-active={current > 0 ? "true" : "false"}>
      <span>{element.label}</span>
      <output>{Math.round(current * 100)}%</output>
      <input
        type="range"
        min={0}
        max={1}
        step={.01}
        value={current}
        aria-label={`${element.label} analog action`}
        onChange={(event) => setAction(element.action, Number(event.currentTarget.value))}
        onPointerDown={haptic}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onBlur={release}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) release();
        }}
      />
      <small>{element.type === "trigger" ? "SPRING TRIGGER" : "ANALOG PRESS"} · {element.action}</small>
    </label>
  );
}

function interactionLabel(element: DigitalControllerElement) {
  const interaction = element.interaction;
  if (!interaction) return "PRESS";
  if (interaction.type === "hold") return `HOLD ${interaction.thresholdMs ?? 450}MS`;
  if (interaction.type === "double-tap") return "DOUBLE TAP";
  if (interaction.type === "toggle") return "TOGGLE";
  return `CHORD ×${interaction.actions.length + 1}`;
}

function defaultControlSide(element: ControllerElement): NonNullable<ControllerElement["side"]> {
  if (element.type === "joystick" || element.type === "dpad" || element.type === "touch-surface") return "left";
  if (element.type === "slider") return "center";
  return "right";
}

function defaultControlZone(element: ControllerElement): NonNullable<ControllerElement["zone"]> {
  if (element.type === "shoulder") return "shoulder";
  if (element.type === "trigger") return "index";
  if (element.type === "slider") return "edge";
  return "thumb";
}

function defaultControlSize(element: ControllerElement): NonNullable<ControllerElement["size"]> {
  if (element.type === "joystick" || element.type === "touch-surface" || element.type === "dpad") return "large";
  if (element.type === "shoulder" || element.type === "trigger") return "small";
  return "medium";
}

function defaultControlSpan(element: ControllerElement, size: NonNullable<ControllerElement["size"]>) {
  // Width is primarily the span hint; size changes the target's depth. These fallbacks keep old
  // two-column layouts ergonomic without letting `large` silently become full-width.
  if (element.type === "joystick" || element.type === "touch-surface" || element.type === "dpad") return 2;
  if (element.type === "shoulder" || element.type === "trigger" || element.type === "analog-button") return 2;
  if (size === "small") return 1;
  return 2;
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
  const update = (event: React.PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const rawX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const rawY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
    const next = element.type === "joystick"
      ? normalizeJoystick(rawX, rawY, element.deadZone ?? .12, element.responseCurve ?? 1)
      : { x: rawX, y: rawY };
    setVector(
      element.action,
      next.x,
      next.y,
    );
  };
  const release = () => setVector(element.action, 0, 0);
  const keyboardVector = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = event.key === "ArrowLeft" ? { x: -1, y: 0 }
      : event.key === "ArrowRight" ? { x: 1, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: -1 }
          : event.key === "ArrowDown" ? { x: 0, y: 1 }
            : undefined;
    if (!next) return;
    event.preventDefault();
    setVector(element.action, next.x, next.y);
  };
  return (
    <button
      type="button"
      className={`dynamic-surface surface-${element.type}`}
      aria-label={`${element.label ?? element.action}. Drag or use arrow keys.`}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); update(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event); }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={keyboardVector}
      onKeyUp={(event) => { if (event.key.startsWith("Arrow")) release(); }}
      onBlur={release}
    >
      <span>{element.label ?? element.action}</span>
      <i className="surface-crosshair" />
      {element.type === "joystick" && <i className="surface-dead-zone" style={{ width: `${(element.deadZone ?? .12) * 100}%` }} />}
      <b style={{ left: `${(vector.x + 1) * 50}%`, top: `${(vector.y + 1) * 50}%` }}>101</b>
      <small>{element.action}</small>
    </button>
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
