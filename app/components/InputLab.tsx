"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { PointerAdapter } from "@101/adapter-pointer";
import { Engine101 } from "@101/core";
import { InputDiagnostics, type LatencySnapshot } from "@101/diagnostics";
import type { InputFrame, InputSource } from "@101/input";
import { getBrowserHostTransport } from "@/app/lib/browser-link";
import { LocalSession, SessionHost } from "@101/session";
import { useEffect, useRef, useState } from "react";
import inputLabGame from "@/games/input-lab/src/game";
import { observeCanvasViewport, type CanvasViewport } from "./camera/canvas-viewport";

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
    const transport = getBrowserHostTransport(sessionId);
    const host = new SessionHost({
      gameId: "input-lab",
      roles: [{
        id: "classic",
        label: "Classic Controller",
        playerId: "player-1",
        requiredCapabilities: ["touch"],
        layout: {
          title: "Input Lab",
          layout: [
            { type: "dpad", action: "move", label: "MOVE" },
            { type: "button", action: "trigger", label: "TRIGGER", emphasis: "primary" },
          ],
        },
      }],
      transport,
      session: new LocalSession(sessionId),
      onFrame: (frame) => engine.inputBus.accept(frame),
      onDeviceReset: (deviceId) => engine.inputBus.removeDevice(deviceId),
      onChange: (snapshot) => setLinkedDevices(snapshot.assignments.map((assignment) => assignment.deviceId)),
    });
    let drawHandle = 0;
    let pulse = 0;
    let previousTrigger = false;
    let latestFrame: InputFrame | undefined;
    let flashTimer = 0;
    let viewport: CanvasViewport = { width: 1, height: 1, ratio: 1 };
    const stopSizing = observeCanvasViewport(canvas, (next) => { viewport = next; });

    const unsubscribeInput = engine.inputBus.subscribe((frame) => {
      latestFrame = frame;
      diagnostics.observe(frame);
      if (frame.actions.trigger && !previousTrigger) {
        pulse = 1;
        setFlash(true);
        window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => setFlash(false), 90);
      }
      previousTrigger = Boolean(frame.actions.trigger);
    });

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const { ratio, width: w, height: h } = viewport;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      // The Input Lab is a diagnostic surface of the site, not a game, so it follows the site's
      // monochrome rule. Aim and pointer stay distinguishable by form — an outlined reticle against
      // a filled disc with an inverted core — rather than by hue.
      context.fillStyle = "#0a0a0a";
      context.fillRect(0, 0, w, h);
      context.strokeStyle = "rgba(255, 255, 255, 0.075)";
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

      context.strokeStyle = "rgba(242, 242, 242, 0.5)";
      context.setLineDash([5, 7]);
      context.beginPath(); context.moveTo(px, py); context.lineTo(ax, ay); context.stroke();
      context.setLineDash([]);

      context.strokeStyle = "#f2f2f2";
      context.lineWidth = 1.5;
      context.beginPath(); context.arc(ax, ay, 13, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.moveTo(ax - 20, ay); context.lineTo(ax + 20, ay); context.moveTo(ax, ay - 20); context.lineTo(ax, ay + 20); context.stroke();

      pulse *= 0.925;
      if (pulse > 0.02) {
        context.strokeStyle = `rgba(242, 242, 242, ${pulse * 0.7})`;
        context.lineWidth = 3;
        context.beginPath(); context.arc(px, py, 32 + (1 - pulse) * 90, 0, Math.PI * 2); context.stroke();
      }

      context.fillStyle = "#f2f2f2";
      context.beginPath(); context.arc(px, py, 28, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#0a0a0a";
      context.beginPath(); context.arc(px, py, 10, 0, Math.PI * 2); context.fill();
      context.fillStyle = "rgba(10, 10, 10, 0.9)";
      context.font = "700 9px ui-monospace, monospace";
      context.textAlign = "center";
      context.fillText("101", px, py + 3);

      context.fillStyle = "rgba(242, 242, 242, 0.5)";
      context.textAlign = "left";
      context.font = "600 10px ui-monospace, monospace";
      context.fillText("LOGICAL SPACE 1280×720", 18, h - 18);
      drawHandle = requestAnimationFrame(draw);
    };

    void engine.inputBus.register(keyboard);
    void engine.inputBus.register(pointer);
    void engine.inputBus.register(gamepad);
    void host.start();
    void engine.start();
    canvas.focus();
    drawHandle = requestAnimationFrame(draw);

    const metricTimer = window.setInterval(() => {
      setMetrics(diagnostics.snapshot());
      if (latestFrame) setLatestSource(latestFrame.source);
    }, 240);

    return () => {
      window.clearInterval(metricTimer);
      window.clearTimeout(flashTimer);
      stopSizing();
      cancelAnimationFrame(drawHandle);
      unsubscribeInput();
      void host.stop();
      engine.stop();
      void engine.inputBus.destroy();
    };
  }, [sessionId]);

  return (
    <section className={`lab-page ${flash ? "is-triggered" : ""}`}>
      <div className="lab-heading">
        <div>
          <button className="back-button" onClick={onExit}>← Games</button>
          <p className="eyebrow">Input normalization</p>
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
          <p className="privacy-note"><strong>PRIVATE PATH</strong> Input stays on BroadcastChannel or a direct LAN WebRTC channel. The local Hub only exchanges short-lived pairing descriptions.</p>
        </aside>
      </div>
    </section>
  );
}
