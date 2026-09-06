"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { PointerAdapter } from "@101/adapter-pointer";
import { defineGamePackage } from "@101/sdk";
import { describeReadiness, describeSources } from "@/app/lib/input-readiness";
import { useGameHost } from "@/app/lib/use-game-host";
import SLASHSTORM_INPUT from "@/games/slashstorm/input.manifest.json";
import SLASHSTORM_MANIFEST from "@/games/slashstorm/manifest.json";
import { useRef, useState } from "react";
import { createSlashstormGame, type SlashstormState } from "@/games/slashstorm/src/game";
import type { SlashTarget } from "@/games/slashstorm/src/director";
import { SLASHSTORM_ROLES } from "@/games/slashstorm/src/roles";

interface SlashHud {
  score: number;
  combo: number;
  lives: number;
  wave: number;
  gameOver: boolean;
  lastHit: string;
}

const INITIAL_HUD: SlashHud = { score: 0, combo: 0, lives: 3, wave: 1, gameOver: false, lastHit: "" };

export default function SlashstormGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<SlashHud>(INITIAL_HUD);

  const { linked, readiness } = useGameHost<SlashstormState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: SLASHSTORM_MANIFEST,
      input: SLASHSTORM_INPUT,
      controllers: SLASHSTORM_ROLES,
      game: createSlashstormGame(`slashstorm-${run}`),
    }),
    adapters: () => {
      const canvas = canvasRef.current;
      return canvas
        ? [new KeyboardAdapter(), new PointerAdapter(canvas), new GamepadAdapter()]
        : [new KeyboardAdapter(), new GamepadAdapter()];
    },
    onReady: ({ context }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      let drawHandle = 0;

      const draw = () => {
        const surface = canvas.getContext("2d");
        if (!surface) return;
        const bounds = canvas.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(bounds.width * ratio));
        const height = Math.max(1, Math.round(bounds.height * ratio));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        surface.setTransform(ratio, 0, 0, ratio, 0, 0);
        renderSlashstorm(surface, bounds.width, bounds.height, context.state);
        drawHandle = requestAnimationFrame(draw);
      };

      canvas.focus();
      drawHandle = requestAnimationFrame(draw);

      const hudTimer = window.setInterval(() => {
        const state = context.state;
        setHud({ score: state.score, combo: state.combo, lives: state.lives, wave: state.wave, gameOver: state.gameOver, lastHit: state.lastHit });
      }, 100);

      return () => {
        window.clearInterval(hudTimer);
        cancelAnimationFrame(drawHandle);
      };
    },
  });

  const readinessNotice = readiness ? describeReadiness(readiness) : null;

  const restart = () => {
    setHud(INITIAL_HUD);
    setRun((current) => current + 1);
  };

  return (
    <section className="slash-page">
      <header className="slash-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Run {run}</p><h1>Slashstorm <span>101</span></h1></div>
        <div className="slash-stats"><div><span>SCORE</span><strong>{hud.score.toString().padStart(6, "0")}</strong></div><div><span>WAVE</span><strong>{hud.wave.toString().padStart(2, "0")}</strong></div><div><span>COMBO</span><strong>×{hud.combo}</strong></div></div>
      </header>

      {/* Outside the arena: the arena hosts absolutely positioned overlays, so a notice placed
          inside it is drawn under the lives meter. */}
      {readinessNotice && <p className={`input-readiness${readiness?.playable === false ? " blocked" : ""}`} role={readiness?.playable === false ? "status" : undefined}>{readinessNotice}</p>}

      <div className="slash-arena">
        {/* The right-hand slot used to be the fixed string "POINTER · TOUCH · GAMEPAD · KEYBOARD",
            which claimed a gamepad whether or not one was plugged in. It now reports what the input
            manifest actually resolved against the hardware present. */}
        <div className="slash-statusbar"><span><i className="status-dot" /></span><span>{linked ? `${linked} LINK CONTROLLER` : describeSources(readiness)}</span></div>
        <canvas ref={canvasRef} tabIndex={0} aria-label="Slashstorm play field. Drag or move the pointer while clicking to slice targets. Arrow keys aim and Space slashes." />
        <div className="slash-overlay-top"><div className="life-meter"><span>LIVES</span>{[0, 1, 2].map((life) => <i key={life} className={life < hud.lives ? "alive" : ""} />)}</div><div className="hit-callout">{hud.lastHit}</div><button onClick={onConnect}>{linked ? "ADD SWORD" : "CONNECT SWORD"} ↗</button></div>
        {hud.gameOver && <div className="game-over-panel"><p>RUN COMPLETE</p><h2>{hud.score.toLocaleString()}</h2><span>FINAL SCORE</span><button className="primary-button" onClick={restart}>Play another seed ↗</button></div>}
      </div>
      <div className="slash-instructions"><span><b>POINTER / TOUCH</b> Hold and slice through targets</span><span><b>KEYBOARD</b> Arrows to aim · Space to slash</span><span><b>WARNING</b> Avoid orange overload bombs</span></div>
    </section>
  );
}

function renderSlashstorm(context: CanvasRenderingContext2D, width: number, height: number, state: SlashstormState) {
  context.fillStyle = "#090b0b";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(239,241,232,.05)";
  context.lineWidth = 1;
  const horizon = height * 0.74;
  for (let index = 0; index < 15; index += 1) {
    const x = (index / 14) * width;
    context.beginPath(); context.moveTo(width / 2, horizon); context.lineTo(x, height); context.stroke();
  }
  for (let index = 0; index < 6; index += 1) {
    const amount = index / 5;
    const y = horizon + amount * amount * (height - horizon);
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }

  for (const particle of state.particles) {
    const point = toScreen(particle.x, particle.y, width, height);
    context.globalAlpha = Math.min(1, particle.life * 2);
    context.fillStyle = particle.color;
    context.fillRect(point.x - 3, point.y - 3, 6, 6);
  }
  context.globalAlpha = 1;
  for (const target of state.targets) drawTarget(context, target, width, height);

  drawBlade(context, state.previousBlade, state.blade, width, height, "#ff5c35", "rgba(255,92,53,.25)");
  if (state.playerTwoActive) drawBlade(context, state.previousBladeTwo, state.bladeTwo, width, height, "#50e3ff", "rgba(80,227,255,.25)");
}

function drawBlade(context: CanvasRenderingContext2D, previousBlade: { x: number; y: number }, currentBlade: { x: number; y: number }, width: number, height: number, color: string, glow: string) {
  const previous = toScreen(previousBlade.x, previousBlade.y, width, height);
  const blade = toScreen(currentBlade.x, currentBlade.y, width, height);
  context.strokeStyle = glow;
  context.lineWidth = 14;
  context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(blade.x, blade.y); context.stroke();
  context.strokeStyle = "#eff1e8";
  context.lineWidth = 3;
  context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(blade.x, blade.y); context.stroke();
  context.fillStyle = color;
  context.beginPath(); context.arc(blade.x, blade.y, 7, 0, Math.PI * 2); context.fill();
}

function drawTarget(context: CanvasRenderingContext2D, target: SlashTarget, width: number, height: number) {
  const point = toScreen(target.x, target.y, width, height);
  const radius = target.radius * Math.min(width, height) * 0.52;
  context.save();
  context.translate(point.x, point.y);
  context.rotate(target.rotation);
  if (target.kind === "bomb") {
    context.fillStyle = "#21100c"; context.strokeStyle = "#ff5c35"; context.lineWidth = 3;
    polygon(context, 8, radius); context.fill(); context.stroke();
    context.beginPath(); context.moveTo(-radius * .45, -radius * .45); context.lineTo(radius * .45, radius * .45); context.moveTo(radius * .45, -radius * .45); context.lineTo(-radius * .45, radius * .45); context.stroke();
  } else if (target.kind === "crystal") {
    context.fillStyle = "#16343b"; context.strokeStyle = "#50e3ff"; context.lineWidth = 2;
    polygon(context, 6, radius); context.fill(); context.stroke();
  } else if (target.kind === "bonus") {
    context.fillStyle = "#b5ff66"; context.rotate(Math.PI / 4); context.fillRect(-radius * .7, -radius * .7, radius * 1.4, radius * 1.4);
  } else {
    context.fillStyle = target.kind === "armored" ? "#292b28" : "#ecebdc";
    context.strokeStyle = target.kind === "armored" ? "#f8d96a" : "#50e3ff";
    context.lineWidth = target.kind === "armored" ? 5 : 2;
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = target.kind === "armored" ? "#f8d96a" : "#ff5c35";
    context.beginPath(); context.arc(0, 0, radius * .34, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

function polygon(context: CanvasRenderingContext2D, sides: number, radius: number) {
  context.beginPath();
  for (let side = 0; side < sides; side += 1) {
    const angle = (side / sides) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (side === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.closePath();
}

function toScreen(x: number, y: number, width: number, height: number) {
  return { x: (x + 1) * width / 2, y: (y + 1) * height / 2 };
}
