"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { PointerAdapter } from "@101/adapter-pointer";
import { Engine101 } from "@101/core";
import { InputDiagnostics, type LatencySnapshot } from "@101/diagnostics";
import type { InputFrame, InputSource } from "@101/input";
import { BroadcastChannelTransport, PROTOCOL_VERSION } from "@101/protocol";
import { useEffect, useRef, useState } from "react";
import inputLabGame from "@/games/input-lab/src/game";

const ZERO_METRICS: LatencySnapshot = { inputHz: 0, frameAgeMs: 0, droppedPercent: 0, samples: 0 };

export default function InputLab({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [latestSource, setLatestSource] = useState<InputSource | "waiting">("waiting");
  const [metrics, setMetrics] = useState<LatencySnapshot>(ZERO_METRICS);
  const [linkedDevices, setLinkedDevices] = useState<string[]>([]);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine101(inputLabGame);
    const keyboard = new KeyboardAdapter();
    const pointer = new PointerAdapter(canvas);
    const gamepad = new GamepadAdapter();
    const diagnostics = new InputDiagnostics();
    const transport = new BroadcastChannelTransport(sessionId);
    let drawHandle = 0;
    let pulse = 0;
    let previousTrigger = false;
    let latestFrame: InputFrame | undefined;

    const unsubscribeInput = engine.inputBus.subscribe((frame) => {
      latestFrame = frame;
      diagnostics.observe(frame);
      if (frame.actions.trigger && !previousTrigger) {
        pulse = 1;
        setFlash(true);
        window.setTimeout(() => setFlash(false), 90);
      }
      previousTrigger = Boolean(frame.actions.trigger);
    });

    const unsubscribeLink = transport.onMessage((message) => {
      if (message.channel === "realtime") engine.inputBus.accept(message.payload);
      if (message.channel === "control" && message.payload.type === "hello") {
        const device = message.payload;
        setLinkedDevices((current) => current.includes(device.deviceId) ? current : [...current, device.deviceId]);
        transport.sendReliable({ type: "player.assign", deviceId: device.deviceId, playerId: "player-1" });
      }
    });

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const w = bounds.width;
      const h = bounds.height;

      context.fillStyle = "#090c0c";
      context.fillRect(0, 0, w, h);
      context.strokeStyle = "rgba(222, 235, 224, 0.075)";
      context.lineWidth = 1;
      const grid = Math.max(36, Math.round(w / 16));
      for (let x = grid; x < w; x += grid) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, h); context.stroke(); }
      for (let y = grid; y < h; y += grid) { context.beginPath(); context.moveTo(0, y); context.lineTo(w, y); context.stroke(); }

      const state = engine.context.state;
      const px = w / 2 + state.x * w * 0.34;
      const py = h / 2 + state.y * h * 0.34;
      const aim = engine.inputBus.vector("aim");
      const ax = w / 2 + aim.x * w / 2;
      const ay = h / 2 + aim.y * h / 2;

      context.strokeStyle = "rgba(181, 255, 102, 0.5)";
      context.setLineDash([5, 7]);
      context.beginPath(); context.moveTo(px, py); context.lineTo(ax, ay); context.stroke();
      context.setLineDash([]);

      context.strokeStyle = "#b5ff66";
      context.lineWidth = 1.5;
      context.beginPath(); context.arc(ax, ay, 13, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.moveTo(ax - 20, ay); context.lineTo(ax + 20, ay); context.moveTo(ax, ay - 20); context.lineTo(ax, ay + 20); context.stroke();

      pulse *= 0.925;
      if (pulse > 0.02) {
        context.strokeStyle = `rgba(255, 92, 53, ${pulse * 0.7})`;
        context.lineWidth = 3;
        context.beginPath(); context.arc(px, py, 32 + (1 - pulse) * 90, 0, Math.PI * 2); context.stroke();
      }

      context.fillStyle = "#f1f2e8";
      context.beginPath(); context.arc(px, py, 28, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#ff5c35";
      context.beginPath(); context.arc(px, py, 10, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(9, 12, 12, 0.9)";
      context.font = "700 9px ui-monospace, monospace";
      context.textAlign = "center";
      context.fillText("101", px, py + 3);

      context.fillStyle = "rgba(241, 242, 232, 0.5)";
      context.textAlign = "left";
      context.font = "600 10px ui-monospace, monospace";
      context.fillText("LOGICAL SPACE 1280×720", 18, h - 18);
      drawHandle = requestAnimationFrame(draw);
    };

    void engine.inputBus.register(keyboard);
    void engine.inputBus.register(pointer);
    void engine.inputBus.register(gamepad);
    void transport.connect().then(() => transport.sendReliable({
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId: "host-browser",
      device: "browser-host",
      capabilities: { touch: true, gamepad: true },
    }));
    void engine.start();
    canvas.focus();
    drawHandle = requestAnimationFrame(draw);

    const metricTimer = window.setInterval(() => {
      setMetrics(diagnostics.snapshot());
      if (latestFrame) setLatestSource(latestFrame.source);
    }, 240);

    return () => {
      window.clearInterval(metricTimer);
      cancelAnimationFrame(drawHandle);
      unsubscribeInput();
      unsubscribeLink();
      void transport.disconnect();
      engine.stop();
      void engine.inputBus.destroy();
    };
  }, [sessionId]);

  return (
    <section className={`lab-page ${flash ? "is-triggered" : ""}`}>
      <div className="lab-heading">
        <div>
          <button className="back-button" onClick={onExit}>← Games</button>
          <p className="eyebrow">Diagnostic 01 · Input normalization</p>
          <h1>101 Input Lab</h1>
        </div>
        <div className="session-readout"><span>SESSION</span><strong>{sessionId}</strong><i>LOCAL</i></div>
      </div>

      <div className="lab-layout">
        <div className="arena-shell">
          <div className="arena-bar">
            <span><i className="status-dot" /> INPUT BUS ACTIVE</span>
            <span>WASD / ARROWS · POINTER · CLICK / SPACE</span>
          </div>
          <canvas ref={canvasRef} tabIndex={0} aria-label="Interactive 101 input test arena. Use arrow keys or WASD to move, pointer to aim, and click or Space to trigger." />
          <div className="arena-hint"><span>MOVE</span> WASD / D-PAD <b>·</b> <span>AIM</span> POINTER / STICK <b>·</b> <span>TRIGGER</span> CLICK / A</div>
        </div>

        <aside className="diagnostic-rail">
          <div className="rail-title"><span>LIVE TELEMETRY</span><i /></div>
          <dl className="metric-list">
            <div><dt>INPUT</dt><dd>{metrics.inputHz}<small>Hz</small></dd></div>
            <div><dt>FRAME AGE</dt><dd>{metrics.frameAgeMs}<small>ms</small></dd></div>
            <div><dt>DROPPED</dt><dd>{metrics.droppedPercent}<small>%</small></dd></div>
            <div><dt>SAMPLES</dt><dd>{metrics.samples}</dd></div>
          </dl>
          <div className="source-card">
            <span>LATEST SOURCE</span>
            <strong>{latestSource === "waiting" ? "Waiting for input" : latestSource.replaceAll("-", " ")}</strong>
            <div className="source-bars"><i /><i /><i /><i /><i /></div>
          </div>
          <div className="linked-card">
            <div><span>LINKED DEVICES</span><b>{linkedDevices.length}</b></div>
            {linkedDevices.length ? linkedDevices.map((device) => <p key={device}><i className="status-dot" />{device}</p>) : <p className="muted">No browser controller yet</p>}
            <button className="outline-button" onClick={onConnect}>{linkedDevices.length ? "Add another" : "Connect controller"} →</button>
          </div>
          <p className="privacy-note"><strong>PRIVATE PATH</strong> Input data stays inside this browser session. The test controller does not use a backend.</p>
        </aside>
      </div>
    </section>
  );
}
