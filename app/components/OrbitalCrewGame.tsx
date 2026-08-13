"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { Engine101 } from "@101/core";
import { getBrowserHostTransport } from "@/app/lib/browser-link";
import { LocalSession, SessionHost, type SessionSnapshot } from "@101/session";
import { useEffect, useRef, useState } from "react";
import { createOrbitalCrewGame, type OrbitalCrewState } from "@/games/orbitalcrew/src/game";
import { ORBITAL_CREW_ROLES } from "@/games/orbitalcrew/src/roles";

interface OrbitalHud {
  elapsed: number;
  sector: number;
  energy: number;
  heat: number;
  shields: number;
  hull: number;
  score: number;
  combo: number;
  activeThreats: number;
  emergencyCooldown: number;
  lastEvent: string;
  gameOver: boolean;
  events: Array<{ id: number; label: string; progress: number; remaining: number; roles: readonly string[]; bearing: number }>;
}

const INITIAL_HUD: OrbitalHud = {
  elapsed: 0,
  sector: 1,
  energy: 100,
  heat: 12,
  shields: 100,
  hull: 100,
  score: 0,
  combo: 0,
  activeThreats: 0,
  emergencyCooldown: 0,
  lastEvent: "CREW STATIONS READY",
  gameOver: false,
  events: [],
};

export default function OrbitalCrewGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<OrbitalHud>(INITIAL_HUD);
  const [session, setSession] = useState<SessionSnapshot>(() => emptySession(sessionId));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine101(createOrbitalCrewGame(`orbitalcrew-${run}`));
    const keyboard = new KeyboardAdapter();
    const gamepad = new GamepadAdapter();
    const transport = getBrowserHostTransport(sessionId);
    const host = new SessionHost({
      gameId: "orbitalcrew",
      roles: ORBITAL_CREW_ROLES,
      transport,
      session: new LocalSession(sessionId),
      onFrame: (frame) => engine.inputBus.accept(frame),
      onDeviceReset: (deviceId) => engine.inputBus.removeDevice(deviceId),
      onChange: setSession,
    });
    const announcedThreats = new Set<number>();
    let drawHandle = 0;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (context) renderShip(context, canvas, engine.context.state);
      drawHandle = requestAnimationFrame(draw);
    };

    void engine.inputBus.register(keyboard);
    void engine.inputBus.register(gamepad);
    void host.start();
    void engine.start();
    canvas.focus();
    drawHandle = requestAnimationFrame(draw);

    const hudTimer = window.setInterval(() => {
      const state = engine.context.state;
      const active = state.events.filter((event) => !event.resolved && event.startAt <= state.elapsed);
      setHud({
        elapsed: state.elapsed,
        sector: state.sector,
        energy: state.energy,
        heat: state.heat,
        shields: state.shields,
        hull: state.hull,
        score: state.score,
        combo: state.combo,
        activeThreats: state.activeThreats,
        emergencyCooldown: state.emergencyCooldown,
        lastEvent: state.lastEvent,
        gameOver: state.gameOver,
        events: active.map((event) => ({
          id: event.id,
          label: event.label,
          progress: event.progress,
          remaining: Math.max(0, event.startAt + event.duration - state.elapsed),
          roles: event.requiredRoles,
          bearing: event.bearing,
        })),
      });

      const primary = active[0];
      const bearing = primary ? bearingLabel(primary.bearing) : "CLEAR";
      const tone = state.hull < 30 ? "critical" as const : state.activeThreats > 1 ? "warning" as const : "normal" as const;
      host.sendControllerState("pilot", { SECTOR: state.sector, HULL: state.hull, BEARING: bearing }, { message: primary?.label ?? "FLIGHT PATH CLEAR", tone });
      host.sendControllerState("weapons", { ENERGY: state.energy, HEAT: state.heat, TARGET: bearing }, { message: primary?.label ?? "NO TARGET", tone });
      host.sendControllerState("shields", { SHIELDS: state.shields, HULL: state.hull, THREATS: state.activeThreats }, { message: primary?.label ?? "SHIELDS NOMINAL", tone });
      host.sendControllerState("reactor", { ENERGY: state.energy, HEAT: state.heat, OUTPUT: state.reactorPower * 100 }, { message: state.heat > 75 ? "VENT RECOMMENDED" : "REACTOR STABLE", tone: state.heat > 75 ? "warning" : tone });
      host.sendControllerState("emergency", { HULL: state.hull, SHIELDS: state.shields, COOLDOWN: state.emergencyCooldown }, { message: state.emergencyCooldown > 0 ? "RECHARGING" : "EMERGENCY READY", tone });

      for (const event of active) {
        if (announcedThreats.has(event.id)) continue;
        announcedThreats.add(event.id);
        event.requiredRoles.forEach((role) => host.haptic(role, "warning"));
        host.haptic("emergency", "warning");
      }
    }, 120);

    return () => {
      window.clearInterval(hudTimer);
      cancelAnimationFrame(drawHandle);
      void host.stop();
      engine.stop();
      void engine.inputBus.destroy();
    };
  }, [run, sessionId]);

  const restart = () => {
    setHud(INITIAL_HUD);
    setRun((value) => value + 1);
  };

  const assignments = new Map(session.assignments.map((assignment) => [assignment.roleId, assignment]));
  return (
    <section className="orbital-page">
      <header className="orbital-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Playable asymmetric co-op · Seed orbitalcrew-{run}</p><h1>Orbital Crew <span>101</span></h1></div>
        <div className="orbital-score"><span>SCORE</span><strong>{hud.score.toString().padStart(7, "0")}</strong><small>SECTOR {String(hud.sector).padStart(2, "0")} · CHAIN ×{hud.combo}</small></div>
      </header>

      <div className="orbital-layout">
        <div className="orbital-stage">
          <div className="orbital-statusbar"><span><i className="status-dot" /> SESSION HOST / ROLE ROUTING ACTIVE</span><b>{hud.activeThreats ? `${hud.activeThreats} ACTIVE THREAT${hud.activeThreats > 1 ? "S" : ""}` : "LOCAL SPACE CLEAR"}</b></div>
          <canvas ref={canvasRef} tabIndex={0} aria-label="Orbital Crew ship view. Use WASD or arrows to pilot, Space to fire, Q and E to rotate shields, C to fortify, V to vent, and R for emergency recall." />
          <div className="orbital-alert"><span>{hud.activeThreats ? "CREW ACTION REQUIRED" : "SHIP STATUS"}</span><strong>{hud.lastEvent}</strong></div>
          {hud.events.length > 0 && <div className="orbital-threat-stack">{hud.events.map((event) => <article key={event.id}><div><span>{bearingLabel(event.bearing)}</span><strong>{event.label}</strong><small>{event.roles.join(" + ").toUpperCase()}</small></div><b>{event.remaining.toFixed(1)}s</b><i><em style={{ width: `${event.progress * 100}%` }} /></i></article>)}</div>}
          {hud.gameOver && <div className="game-over-panel"><p>SHIP LOST</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL CREW SCORE</span><button className="primary-button" onClick={restart}>Launch another seed ↗</button></div>}
        </div>

        <aside className="orbital-rail">
          <section className="ship-vitals">
            <h2>SHIP VITALS</h2>
            <Vital label="HULL" value={hud.hull} tone="danger" />
            <Vital label="SHIELDS" value={hud.shields} tone="shield" />
            <Vital label="ENERGY" value={hud.energy} tone="energy" />
            <Vital label="HEAT" value={hud.heat} tone="heat" />
          </section>
          <section className="crew-roster">
            <div><h2>CREW ROUTER</h2><button onClick={onConnect}>{session.assignments.length ? "ADD DEVICE" : "CONNECT CREW"} ↗</button></div>
            {ORBITAL_CREW_ROLES.map((role) => {
              const assigned = assignments.get(role.id);
              return <article key={role.id} className={assigned ? "is-assigned" : ""}><i /><div><strong>{role.label}</strong><span>{assigned ? assigned.deviceId : "Keyboard captain fallback"}</span></div><b>{assigned ? "LINKED" : "OPEN"}</b></article>;
            })}
          </section>
          <p className="orbital-local-note"><b>NO DEVICE REQUIRED</b> One keyboard or gamepad can operate every station. Connected phones receive independent panels automatically.</p>
        </aside>
      </div>

      <div className="orbital-instructions"><span><b>PILOT</b> WASD / arrows</span><span><b>WEAPONS</b> Aim + Space</span><span><b>SHIELDS</b> Q / E + C</span><span><b>REACTOR</b> V vent · F overdrive</span><span><b>EMERGENCY</b> R</span></div>
    </section>
  );
}

function Vital({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`vital vital-${tone}`}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>;
}

function renderShip(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, state: OrbitalCrewState) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = bounds.width;
  const h = bounds.height;
  context.fillStyle = "#040809";
  context.fillRect(0, 0, w, h);

  for (let index = 0; index < 90; index += 1) {
    const x = ((index * 83 + state.elapsed * (6 + index % 4)) % (w + 20)) - 10;
    const y = (index * 47) % Math.max(1, h);
    context.globalAlpha = .18 + (index % 5) * .11;
    context.fillStyle = index % 7 ? "#eff1e8" : "#50e3ff";
    context.fillRect(x, y, index % 3 ? 1 : 2, index % 3 ? 1 : 2);
  }
  context.globalAlpha = 1;

  const cx = w * .5 + state.shipX * w * .18;
  const cy = h * .55 + state.shipY * h * .2;
  for (const event of state.events.filter((candidate) => !candidate.resolved && candidate.startAt <= state.elapsed)) {
    const distance = Math.min(w, h) * (.32 + .035 * (event.id % 3));
    const x = cx + Math.cos(event.bearing) * distance;
    const y = cy + Math.sin(event.bearing) * distance;
    context.strokeStyle = "rgba(255,92,53,.42)";
    context.lineWidth = 1;
    context.setLineDash([5, 7]);
    context.beginPath(); context.moveTo(cx, cy); context.lineTo(x, y); context.stroke();
    context.setLineDash([]);
    context.fillStyle = event.kind === "storm" ? "#d368ff" : event.kind === "drones" ? "#f8d96a" : "#ff5c35";
    context.beginPath(); context.arc(x, y, 7 + event.severity * 10, 0, Math.PI * 2); context.fill();
  }

  context.strokeStyle = `rgba(181,255,102,${.18 + state.shields / 150})`;
  context.lineWidth = 5;
  context.beginPath(); context.arc(cx, cy, 72, state.shieldAngle - .78, state.shieldAngle + .78); context.stroke();
  context.save();
  context.translate(cx, cy);
  context.rotate(state.heading + Math.PI / 2);
  context.fillStyle = "#eff1e8";
  context.strokeStyle = "#50e3ff";
  context.lineWidth = 2;
  context.beginPath(); context.moveTo(0, -42); context.lineTo(27, 29); context.lineTo(0, 19); context.lineTo(-27, 29); context.closePath(); context.fill(); context.stroke();
  context.fillStyle = "#101b1d";
  context.beginPath(); context.arc(0, -3, 11, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#ff5c35";
  context.fillRect(-16, 28, 9, 18 + Math.sin(state.elapsed * 12) * 4);
  context.fillStyle = "#50e3ff";
  context.fillRect(7, 28, 9, 18 + Math.cos(state.elapsed * 11) * 4);
  context.restore();
}

function bearingLabel(angle: number) {
  const degrees = Math.round(((angle * 180 / Math.PI) + 360) % 360);
  return `${String(degrees).padStart(3, "0")}°`;
}

function emptySession(code: string): SessionSnapshot {
  return { code, gameId: "orbitalcrew", revision: 0, devices: [], assignments: [], openRoles: [...ORBITAL_CREW_ROLES] };
}
