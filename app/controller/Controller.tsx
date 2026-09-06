"use client";

import { BrowserMotionAdapter, isMotionSupported, requestMotionPermission } from "@101/adapter-motion";
import type { InputFrame, InputVector } from "@101/input";
import {
  ControllerActionGesture,
  ControllerInputModel,
  normalizeJoystick,
  type ControllerInputSnapshot,
  defaultControlSide,
  planControllerDeck,
  type DeckCluster,
  type PlacedControl,
} from "@101/link-controller";
import { HttpControllerSignalingClient, SignaledLinkTransport } from "@101/pairing";
import {
  BroadcastChannelTransport,
  INPUT_Q1_FORMAT,
  PROTOCOL_VERSION,
  decodePairingTicket,
  type ControllerElement,
  type ControllerLayout,
  type LinkTransport,
  type StatefulLinkTransport,
} from "@101/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserControllerSpeaker } from "./controller-speaker";

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
  // The worker runtime also exposes `navigator`, but not a meaningful `onLine`. Keep the server and
  // first browser render identical, then measure real connectivity after hydration.
  const [online, setOnline] = useState(true);
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
  const [speakerAudio, setSpeakerAudio] = useState<"locked" | "ready">("locked");
  const [speakerEnableFailed, setSpeakerEnableFailed] = useState(false);
  const [lastSpeakerCue, setLastSpeakerCue] = useState<number>();
  const transportRef = useRef<LinkTransport | null>(null);
  const motionAdapterRef = useRef<BrowserMotionAdapter | null>(null);
  const speakerRef = useRef<BrowserControllerSpeaker | null>(null);
  const speakerAudioRef = useRef<"locked" | "ready">("locked");
  const announceRef = useRef<() => void>(() => undefined);
  const playerIdRef = useRef("player-1");
  const layoutRef = useRef(layout);
  const inputRef = useRef<ControllerInputModel | null>(null);
  if (inputRef.current == null) inputRef.current = new ControllerInputModel(DEFAULT_LAYOUT);
  const configurationRef = useRef("");
  const lastHostMessageAt = useRef(0);
  const sequence = useRef(0);

  useEffect(() => { layoutRef.current = layout; }, [layout]);

  useEffect(() => {
    // A cue that fails to sound demotes the speaker and re-announces, so the host takes this role's
    // audio back onto the television instead of leaving the player in silence.
    const speaker = new BrowserControllerSpeaker(undefined, undefined, () => {
      speakerAudioRef.current = "locked";
      setSpeakerAudio("locked");
      announceRef.current();
    });
    speakerRef.current = speaker;
    return () => {
      speaker.dispose();
      speakerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const updateAvailability = () => {
      const next = speakerRef.current?.state ?? "locked";
      speakerAudioRef.current = next;
      setSpeakerAudio(next);
      announceRef.current();
    };
    document.addEventListener("visibilitychange", updateAvailability);
    updateAvailability();
    return () => document.removeEventListener("visibilitychange", updateAvailability);
  }, []);

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
    updateOnline();
    if ("serviceWorker" in navigator) {
      /*
       * Caught, not floated. `void` on a rejecting promise is still an unhandled rejection: /sw.js
       * only exists in a production build, so every dev session opened the controller behind a
       * full-screen error overlay covering the thing being worked on. Offline caching is an
       * enhancement — the controller works without it, and a failure here is not the player's news.
       */
      navigator.serviceWorker.register("/sw.js", { scope: "/controller" }).catch(() => {});
    }
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
      speaker: true,
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
        if ("type" in payload && payload.type === "speaker.cue" && payload.deviceId === deviceId) {
          lastHostMessageAt.current = performance.now();
          if (speakerRef.current?.receive(payload)) setLastSpeakerCue(payload.sequence);
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
        if (configurationRef.current === configuration) {
          publishSnapshot(inputRef.current!.snapshot());
          return;
        }
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
      features: {
        inputFormats: [INPUT_Q1_FORMAT],
        speakerAudio: speakerAudioRef.current,
      },
    });
    announceRef.current = hello;
    const removeState = isStateful(transport) ? transport.onStateChange((state) => {
      if (state === "connected") hello();
      if (state === "failed" || state === "disconnected") {
        setConnected(false);
        setReadout({ values: {}, tone: "warning", message: "LINK INTERRUPTED · RECONNECTING" });
      }
    }) : () => undefined;
    let connectCancelled = false;
    let connectRetryTimer: number | undefined;
    let connectFailures = 0;
    const connectTransport = async () => {
      connectRetryTimer = undefined;
      try {
        await transport.connect();
        if (connectCancelled) return;
        connectFailures = 0;
        hello();
      } catch {
        if (connectCancelled) return;
        setConnected(false);
        setReadout({ values: {}, tone: "critical", message: "LINK TRANSPORT UNAVAILABLE · RETRYING" });
        const delay = Math.min(10_000, 600 * 2 ** Math.min(connectFailures, 4));
        connectFailures += 1;
        connectRetryTimer = window.setTimeout(() => void connectTransport(), delay);
      }
    };
    void connectTransport();
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
      connectCancelled = true;
      if (connectRetryTimer !== undefined) window.clearTimeout(connectRetryTimer);
      window.clearInterval(helloTimer);
      window.clearInterval(watchdogTimer);
      publishSnapshot(inputRef.current!.releaseAll());
      removeListener();
      removeState();
      void transport.disconnect();
      void motionAdapterRef.current?.stop();
      motionAdapterRef.current = null;
      transportRef.current = null;
      announceRef.current = () => undefined;
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

  const enableSpeaker = async () => {
    const ready = await speakerRef.current?.enable();
    if (!ready) {
      setSpeakerEnableFailed(true);
      return;
    }
    const availability = speakerRef.current?.state ?? "locked";
    speakerAudioRef.current = availability;
    setSpeakerAudio(availability);
    setSpeakerEnableFailed(false);
    announceRef.current();
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
        <div className="wordmark"><span className="mark-block">101</span><span className="mark-label">{assignment.role}</span></div>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? assigned ? "LINKED" : "STANDBY" : "WAITING"}</div>
      </header>
      <section className="controller-session">
        <span>Room</span><strong>{session}</strong>
        <small>{connected ? assigned ? `${assignment.gameId.toUpperCase()} · ${assignment.playerId.toUpperCase()}` : `${assignment.gameId.toUpperCase()} · WAITING FOR ROLE` : "Open a 101 game on the host"}</small>
      </section>

      <details className="link-runtime">
        <summary><span className={online ? "runtime-dot online" : "runtime-dot"} />{online ? "Connected" : "Reconnecting…"}</summary>
        <div className="link-runtime-actions">
          {installPrompt && <button onClick={install}>INSTALL 101 LINK</button>}
          <label>
            <span>Connection link</span>
            <input value={pairEntry} onChange={(event) => setPairEntry(event.target.value)} placeholder="Paste local pairing link" autoCapitalize="off" autoCorrect="off" />
          </label>
          <button onClick={connectPairing} disabled={!pairEntry.trim()}>CONNECT TO HOST</button>
          <p>Installable assets and controller layouts are cached locally. Pairing secrets are never written to the service-worker cache.</p>
        </div>
      </details>

      <section className={`controller-speaker${speakerAudio === "ready" ? " ready" : ""}`}>
        <div>
          <span>Sound on this phone</span>
          <strong aria-live="polite">{speakerAudio === "ready"
            ? lastSpeakerCue === undefined ? "On — waiting for the game" : "Playing"
            : speakerEnableFailed ? "Couldn't start — tap again" : "Off"}</strong>
        </div>
        <button onClick={enableSpeaker} disabled={speakerAudio === "ready"}>{speakerAudio === "ready" ? "Sound on" : "Turn on sound"}</button>
      </section>

      <section className="dynamic-controller-heading">
        <div>
          <span>Ready</span>
          <h1>{layout.title ?? assignment.role}</h1>
        </div>
        {canFlipHandedness && (
          <button className="handedness-toggle" onClick={flipHandedness} aria-label={`Switch to ${playerHandedness === "right" ? "left" : "right"}-handed layout`}>
            <span>Thumb</span><strong>{playerHandedness === "right" ? "Right" : "Left"}</strong><i aria-hidden="true">↔</i>
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

    </main>
  );
}

function isStateful(transport: LinkTransport): transport is StatefulLinkTransport {
  return "onStateChange" in transport && typeof transport.onStateChange === "function";
}

/**
 * Exported for tests: rendering the real deck and inspecting the markup is the only way to prove a
 * layout actually produces controls. The contract tests for this used to be regexes over this
 * file's source, which pass on any file that merely mentions the right string.
 */
export function DynamicControllerDeck({
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
  /*
   * Placement is decided by the planner, not here.
   *
   * This used to write an inline `grid-column` per element — left controls starting at line 1, right
   * controls ending at line -1 — so two controls on the same side always claimed overlapping tracks
   * and drew on top of each other. Shadow Arena's d-pad plus six buttons became a deck about 1400px
   * tall on an 812px screen.
   *
   * The deck now renders three clusters of three groups and decides nothing. That also moves the
   * arrangement somewhere testable: this file cannot be imported by the test runner, and the planner
   * can.
   */
  const plan = planControllerDeck(elements, { authoredHandedness, playerHandedness });

  const renderControl = (placed: PlacedControl, index: number) => {
    const element = placed.element;
    const key = `${element.type}-${element.action}-${index}`;
    return (
      <div
        className="dynamic-control"
        data-control={element.type}
        data-side={placed.side}
        data-zone={placed.zone}
        data-size={placed.size}
        data-priority={element.priority ?? 50}
        key={key}
        style={placed.span > 1 ? ({ gridColumn: `span ${placed.span}` } as React.CSSProperties) : undefined}
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
            </label>
          );
        })()}
        {element.type === "dpad" && <DynamicDpad element={element} setVector={setVector} />}
        {(element.type === "joystick" || element.type === "touch-surface") && (
          <DynamicSurface element={element} vector={vectors[element.action] ?? { x: 0, y: 0 }} setVector={setVector} />
        )}
      </div>
    );
  };

  const renderCluster = (cluster: DeckCluster) => {
    if (cluster.count === 0) return null;
    return (
      <div className="deck-cluster" data-side={cluster.side} style={{ "--cluster-weight": cluster.weight } as React.CSSProperties}>
        {cluster.bars.length > 0 && <div className="deck-bars">{cluster.bars.map(renderControl)}</div>}
        {cluster.pads.length > 0 && <div className="deck-pads">{cluster.pads.map(renderControl)}</div>}
        {cluster.keys.length > 0 && <div className="deck-keys">{cluster.keys.map(renderControl)}</div>}
      </div>
    );
  };

  return (
    <section
      className="dynamic-controller-deck"
      aria-label="Role controller"
      style={{
        "--left-track": plan.left.count ? `${plan.left.weight}fr` : "0px",
        "--right-track": plan.right.count ? `${plan.right.weight}fr` : "0px",
      } as React.CSSProperties}
    >
      {renderCluster(plan.center)}
      {renderCluster(plan.left)}
      {renderCluster(plan.right)}
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
      <small>{interactionLabel(element)}</small>
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
      <small>{element.type === "trigger" ? "Spring" : "Pressure"}</small>
    </label>
  );
}

/** How to use the button, in the words someone holding it would use. */
function interactionLabel(element: DigitalControllerElement) {
  const interaction = element.interaction;
  if (!interaction) return "Tap";
  if (interaction.type === "hold") return `Hold ${Math.round((interaction.thresholdMs ?? 450) / 100) / 10}s`;
  if (interaction.type === "double-tap") return "Double tap";
  if (interaction.type === "toggle") return "Toggle";
  return `Tap ${interaction.actions.length + 1} together`;
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
      <div><span>Status</span><strong>{readout.message ?? "Waiting for the game"}</strong></div>
      {values.length > 0 && <dl>{values.slice(0, 6).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{typeof value === "number" ? Math.round(value) : String(value)}</dd></div>)}</dl>}
    </section>
  );
}
