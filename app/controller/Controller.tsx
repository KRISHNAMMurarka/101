"use client";

import { BrowserMotionAdapter, isMotionSupported, requestMotionPermission } from "@101/adapter-motion";
import type { InputFrame } from "@101/input";
import { BroadcastChannelTransport, PROTOCOL_VERSION } from "@101/protocol";
import { useEffect, useId, useRef, useState } from "react";

type ControllerRole = "classic" | "sword" | "steering" | "sensor";

interface ManualInput {
  x?: number;
  y?: number;
  trigger?: boolean;
  buttonB?: boolean;
  boost?: boolean;
  brake?: boolean;
  drift?: boolean;
  slash?: boolean;
}

export default function Controller({ session }: { session: string }) {
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<ControllerRole>("classic");
  const [playerId, setPlayerId] = useState("player-1");
  const [motion, setMotion] = useState({ x: 0, y: 0 });
  const [motionState, setMotionState] = useState<"idle" | "active" | "denied" | "unsupported">("idle");
  const transportRef = useRef<BroadcastChannelTransport | null>(null);
  const motionAdapterRef = useRef<BrowserMotionAdapter | null>(null);
  const playerIdRef = useRef("player-1");
  const sequence = useRef(0);
  const reactId = useId();
  const deviceId = `link-${reactId.replace(/[^a-z0-9]/gi, "").toLowerCase() || "controller"}`;

  useEffect(() => {
    const transport = new BroadcastChannelTransport(session);
    transportRef.current = transport;
    const removeListener = transport.onMessage((message) => {
      if (message.channel !== "control") return;
      if (message.payload.type === "player.assign" && message.payload.deviceId === deviceId) {
        playerIdRef.current = message.payload.playerId;
        setPlayerId(message.payload.playerId);
        setConnected(true);
      }
      if (message.payload.type === "controller.configure") {
        const nextRole = message.payload.role;
        setRole(["classic", "sword", "steering", "sensor"].includes(nextRole) ? nextRole as ControllerRole : "classic");
      }
      if (message.payload.type === "haptic") {
        navigator.vibrate?.(message.payload.pattern === "warning" ? [50, 35, 50] : message.payload.pattern === "impact" ? 35 : 15);
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
    const helloTimer = window.setInterval(hello, 1600);
    return () => {
      window.clearInterval(helloTimer);
      removeListener();
      void transport.disconnect();
      transportRef.current = null;
    };
  }, [deviceId, session]);

  useEffect(() => () => { void motionAdapterRef.current?.stop(); }, []);

  const send = (options: ManualInput) => {
    const x = options.x ?? motion.x;
    const y = options.y ?? motion.y;
    setMotion({ x, y });
    const frame: InputFrame = {
      deviceId,
      playerId: playerIdRef.current,
      sequence: ++sequence.current,
      timestamp: performance.now(),
      source: "custom",
      actions: {
        trigger: options.trigger ?? false,
        buttonA: options.trigger ?? options.boost ?? false,
        buttonB: options.buttonB ?? false,
        slash: options.slash ?? options.trigger ?? false,
        boost: options.boost ?? false,
        brake: options.brake ?? false,
        drift: options.drift ?? false,
      },
      axes: { moveX: x, moveY: y, steer: x },
      vectors: { move: { x, y }, aim: { x, y }, slash: { x, y } },
    };
    transportRef.current?.sendRealtime(frame);
  };

  const release = () => send({ x: 0, y: 0 });
  const haptic = () => { navigator.vibrate?.(20); };

  const enableMotion = async () => {
    const permission = await requestMotionPermission();
    if (permission !== "granted") {
      setMotionState(permission);
      return;
    }
    await motionAdapterRef.current?.stop();
    const adapter = new BrowserMotionAdapter({
      deviceId: `${deviceId}-motion`,
      playerId: playerIdRef.current,
      onDiagnostics: ({ roll, pitch }) => setMotion({ x: Math.max(-1, Math.min(1, roll / 0.75)), y: Math.max(-1, Math.min(1, pitch / 0.75)) }),
    });
    motionAdapterRef.current = adapter;
    adapter.start((frame) => transportRef.current?.sendRealtime(frame));
    adapter.calibrateNeutral();
    setMotionState("active");
  };

  const calibrate = () => {
    motionAdapterRef.current?.calibrateNeutral();
    haptic();
  };

  return (
    <main className={`controller-page role-${role}`}>
      <header className="controller-top">
        <div className="wordmark"><span className="mark-block">101</span><span className="mark-label">LINK / {role.toUpperCase()}</span></div>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? "LINKED" : "WAITING"}</div>
      </header>
      <section className="controller-session"><span>SESSION</span><strong>{session}</strong><small>{connected ? `${playerId.toUpperCase()} · ROLE AUTO-SYNCED` : "Open a 101 game on the host"}</small></section>

      {role === "steering" ? (
        <section className="steering-deck">
          <button className="steer-touch steer-left" aria-label="Steer left" onPointerDown={() => send({ x: -1 })} onPointerUp={release} onPointerLeave={release}>←</button>
          <div className="steering-wheel" style={{ transform: `rotate(${motion.x * 62}deg)` }}><span>101</span><i /><b /></div>
          <button className="steer-touch steer-right" aria-label="Steer right" onPointerDown={() => send({ x: 1 })} onPointerUp={release} onPointerLeave={release}>→</button>
          <div className="pedal-row">
            <button onPointerDown={() => { haptic(); send({ brake: true }); }} onPointerUp={release}>BRAKE</button>
            <button onPointerDown={() => { haptic(); send({ drift: true }); }} onPointerUp={release}>DRIFT</button>
            <button className="boost-pedal" onPointerDown={() => { haptic(); send({ boost: true }); }} onPointerUp={release}>BOOST</button>
          </div>
        </section>
      ) : role === "sword" ? (
        <section className="sword-deck" aria-label="Sword touch surface" onPointerDown={(event) => sendSword(event, true, send)} onPointerMove={(event) => { if (event.buttons) sendSword(event, true, send); }} onPointerUp={release} onPointerLeave={release}>
          <div className="sword-reticle" style={{ left: `${(motion.x + 1) * 50}%`, top: `${(motion.y + 1) * 50}%` }}><i /></div>
          <span>HOLD + SWIPE TO SLASH</span>
          <button className="sword-trigger" onPointerDown={(event) => { event.stopPropagation(); haptic(); send({ trigger: true, slash: true }); }} onPointerUp={release}>SLASH</button>
        </section>
      ) : (
        <ClassicDeck send={send} release={release} haptic={haptic} />
      )}

      {(role === "steering" || role === "sword" || role === "sensor") && (
        <section className="motion-permission">
          <button onClick={motionState === "active" ? calibrate : enableMotion}>{motionState === "active" ? "SET NEUTRAL" : "ENABLE MOTION"}</button>
          <p>{motionState === "active" ? "Motion is processed locally and sent as tiny normalized frames." : motionState === "denied" ? "Motion permission was not granted. Touch controls remain available." : motionState === "unsupported" ? "Motion is unavailable here. Touch controls remain available." : "Motion Sensors: use phone as steering wheel or sword."}</p>
        </section>
      )}
      <section className="controller-readout"><span>{role.toUpperCase()} VECTOR</span><code>X {motion.x.toFixed(2)} / Y {motion.y.toFixed(2)}</code></section>
      <p className="controller-footnote">The host selects this panel without reconnecting. Games receive only normalized 101 input.</p>
    </main>
  );
}

function ClassicDeck({ send, release, haptic }: { send: (input: ManualInput) => void; release: () => void; haptic: () => void }) {
  return (
    <section className="controller-deck">
      <div className="dpad" aria-label="Movement pad">
        <button className="up" aria-label="Move up" onPointerDown={() => send({ x: 0, y: -1 })} onPointerUp={release} onPointerLeave={release}>▲</button>
        <button className="left" aria-label="Move left" onPointerDown={() => send({ x: -1, y: 0 })} onPointerUp={release} onPointerLeave={release}>◀</button>
        <span className="dpad-center" />
        <button className="right" aria-label="Move right" onPointerDown={() => send({ x: 1, y: 0 })} onPointerUp={release} onPointerLeave={release}>▶</button>
        <button className="down" aria-label="Move down" onPointerDown={() => send({ x: 0, y: 1 })} onPointerUp={release} onPointerLeave={release}>▼</button>
      </div>
      <div className="action-cluster">
        <button className="button-b" onPointerDown={() => { haptic(); send({ buttonB: true }); }} onPointerUp={release}><span>B</span><small>ALT</small></button>
        <button className="button-a" onPointerDown={() => { haptic(); send({ trigger: true }); }} onPointerUp={release}><span>A</span><small>TRIGGER</small></button>
      </div>
    </section>
  );
}

function sendSword(event: React.PointerEvent<HTMLElement>, active: boolean, send: (input: ManualInput) => void) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
  const y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1));
  send({ x, y, slash: active, trigger: active });
}
