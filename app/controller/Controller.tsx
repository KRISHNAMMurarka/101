"use client";

import type { InputFrame } from "@101/input";
import { BroadcastChannelTransport, PROTOCOL_VERSION } from "@101/protocol";
import { useEffect, useId, useRef, useState } from "react";

export default function Controller({ session }: { session: string }) {
  const [connected, setConnected] = useState(false);
  const [motion, setMotion] = useState({ x: 0, y: 0 });
  const transportRef = useRef<BroadcastChannelTransport | null>(null);
  const sequence = useRef(0);
  const reactId = useId();
  const deviceId = `link-${reactId.replace(/[^a-z0-9]/gi, "").toLowerCase() || "controller"}`;
  const assigned = useRef(false);

  useEffect(() => {
    const transport = new BroadcastChannelTransport(session);
    transportRef.current = transport;
    const removeListener = transport.onMessage((message) => {
      if (message.channel === "control" && message.payload.type === "player.assign" && message.payload.deviceId === deviceId) {
        assigned.current = true;
        setConnected(true);
      }
    });
    const hello = () => transport.sendReliable({
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId,
      device: "101 Link browser controller",
      capabilities: { touch: true, haptics: "vibrate" in navigator },
    });
    void transport.connect().then(hello);
    const helloTimer = window.setInterval(() => { if (!assigned.current) hello(); }, 1500);
    return () => {
      window.clearInterval(helloTimer);
      removeListener();
      void transport.disconnect();
    };
  }, [deviceId, session]);

  const send = (options: { x?: number; y?: number; trigger?: boolean; buttonB?: boolean }) => {
    const x = options.x ?? motion.x;
    const y = options.y ?? motion.y;
    setMotion({ x, y });
    const frame: InputFrame = {
      deviceId,
      playerId: "player-1",
      sequence: ++sequence.current,
      timestamp: performance.now(),
      source: "custom",
      actions: { trigger: options.trigger ?? false, buttonA: options.trigger ?? false, buttonB: options.buttonB ?? false },
      axes: { moveX: x, moveY: y, steer: x },
      vectors: { move: { x, y }, aim: { x, y } },
    };
    transportRef.current?.sendRealtime(frame);
  };

  const release = () => send({ x: 0, y: 0 });
  const haptic = () => { navigator.vibrate?.(20); };

  return (
    <main className="controller-page">
      <header className="controller-top">
        <div className="wordmark"><span className="mark-block">101</span><span className="mark-label">LINK / CLASSIC</span></div>
        <div className={connected ? "controller-status online" : "controller-status"}><i />{connected ? "LINKED" : "WAITING"}</div>
      </header>
      <section className="controller-session"><span>SESSION</span><strong>{session}</strong><small>{connected ? "PLAYER 1" : "Open Input Lab on the host"}</small></section>
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
      <section className="controller-readout">
        <span>MOVE VECTOR</span><code>X {motion.x.toFixed(2)} / Y {motion.y.toFixed(2)}</code>
      </section>
      <p className="controller-footnote">Touch events become normalized <code>move</code> and <code>trigger</code> frames before the game sees them.</p>
    </main>
  );
}
