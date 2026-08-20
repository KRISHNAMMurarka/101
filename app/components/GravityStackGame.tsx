"use client";

import { GamepadAdapter } from "@101/adapter-gamepad";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { defineGamePackage } from "@101/sdk";
import { describeReadiness, describeSources } from "@/app/lib/input-readiness";
import { useGameHost } from "@/app/lib/use-game-host";
import GRAVITYSTACK_INPUT from "@/games/gravitystack/input.manifest.json";
import GRAVITYSTACK_MANIFEST from "@/games/gravitystack/manifest.json";
import { useRef, useState } from "react";
import { createGravityStackGame, type GravityStackState } from "@/games/gravitystack/src/game";
import type { StackShapeSpec } from "@/games/gravitystack/src/director";
import { GRAVITYSTACK_ROLES } from "@/games/gravitystack/src/roles";

type PhaserModule = typeof import("phaser");
type Renderer2DConstructor = typeof import("@101/render-2d")["Renderer2D101"];

const INITIAL_PREVIEW: StackShapeSpec = {
  id: 1,
  kind: "block",
  material: "steady",
  width: 1.3,
  height: 1,
  density: .9,
  friction: .82,
  restitution: .05,
  rotation: 0,
  color: "#9e8cff",
};

interface StackHud {
  ready: boolean;
  score: number;
  height: number;
  stability: number;
  integrity: number;
  pieces: number;
  gravity: { x: number; y: number };
  placementX: number;
  preview: StackShapeSpec;
  lastEvent: string;
  gameOver: boolean;
}

function initialHud(preview: StackShapeSpec): StackHud {
  return { ready: false, score: 0, height: 0, stability: 100, integrity: 100, pieces: 0, gravity: { x: 0, y: 9.81 }, placementX: 0, preview, lastEvent: "INITIALIZING PHYSICS", gameOver: false };
}

export default function GravityStackGame({ sessionId, onConnect, onExit }: { sessionId: string; onConnect: () => void; onExit: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(1);
  const [hud, setHud] = useState<StackHud>(() => initialHud(INITIAL_PREVIEW));

  const { linked, session, readiness } = useGameHost<GravityStackState>({
    sessionId,
    deps: [run],
    build: () => defineGamePackage({
      manifest: GRAVITYSTACK_MANIFEST,
      input: GRAVITYSTACK_INPUT,
      controllers: GRAVITYSTACK_ROLES,
      game: createGravityStackGame(`gravitystack-${run}`),
    }),
    adapters: () => [new KeyboardAdapter(), new GamepadAdapter()],
    onReady: ({ context, host }) => {
      const stage = stageRef.current;
      if (!stage) return;
      let cancelled = false;
      let view: { destroy: () => void } | undefined;
      let previousLost = 0;

      // Phaser touches browser globals while its module loads, so the facade is
      // resolved only after hydration. Game and physics code remain unchanged.
      void (async () => {
        const { Phaser, Renderer2D101 } = await import("@101/render-2d");
        if (cancelled) return;
        view = createStackView(stage, () => context.state, Phaser, Renderer2D101);
      })();

      const hudTimer = window.setInterval(() => {
        const state = context.state;
        setHud({
          ready: state.ready,
          score: state.score,
          height: state.towerHeight,
          stability: state.stability,
          integrity: state.integrity,
          pieces: state.pieces.filter((piece) => !piece.lost).length,
          gravity: { ...state.gravity },
          placementX: state.placementX,
          preview: { ...state.preview },
          lastEvent: state.lastEvent,
          gameOver: state.gameOver,
        });
        host.sendControllerState("gravity", {
          X: state.gravity.x,
          Y: state.gravity.y,
          STABILITY: state.stability,
          HEIGHT: state.towerHeight,
        }, { message: state.lastEvent, tone: state.stability < 35 ? "warning" : "normal" });
        host.sendControllerState("builder", {
          POSITION: state.placementX,
          NEXT: state.preview.kind,
          MATERIAL: state.preview.material,
          INTEGRITY: state.integrity,
        }, { message: state.dropCooldown > 0 ? "CRANE CYCLING" : "DROP READY", tone: state.integrity < 30 ? "critical" : "normal" });
        if (state.lostPieces > previousLost) {
          previousLost = state.lostPieces;
          host.haptic("gravity", "warning");
          host.haptic("builder", "impact");
        }
      }, 100);

      return () => {
        cancelled = true;
        window.clearInterval(hudTimer);
        view?.destroy();
      };
    },
  });

  const readinessNotice = readiness ? describeReadiness(readiness) : null;

  const restart = () => {
    setHud(initialHud(INITIAL_PREVIEW));
    setRun((value) => value + 1);
  };

  const gravityAngle = Math.atan2(hud.gravity.y, hud.gravity.x) * 180 / Math.PI;
  return (
    <section className="gravity-page">
      <header className="gravity-heading">
        <div><button className="back-button" onClick={onExit}>← Games</button><p className="eyebrow">Playable Rapier physics · Seed gravitystack-{run}</p><h1>GravityStack <span>101</span></h1></div>
        <div className="gravity-stats"><div><span>SCORE</span><strong>{hud.score.toString().padStart(6, "0")}</strong></div><div><span>HEIGHT</span><strong>{hud.height.toFixed(1)}<small>M</small></strong></div><div><span>PIECES</span><strong>{hud.pieces}</strong></div></div>
      </header>

      <div className="gravity-layout">
        <div className="gravity-stage-shell">
          <div className="gravity-statusbar"><span><i className="status-dot" /> RAPIER / VARIABLE GRAVITY ACTIVE</span><span>{linked ? `${linked} LINK ROLE${linked > 1 ? "S" : ""}` : describeSources(readiness)}</span><b>{hud.ready ? "SIMULATION READY" : "LOADING WASM"}</b></div>
          {readinessNotice && <p className={`input-readiness${readiness?.playable === false ? " blocked" : ""}`} role={readiness?.playable === false ? "status" : undefined}>{readinessNotice}</p>}

          <div className="gravity-stage" ref={stageRef} role="img" aria-label="GravityStack physics world. Arrow keys change gravity, A and D move the drop position, and Space drops the next shape." />
          <div className="gravity-vector" style={{ transform: `rotate(${gravityAngle - 90}deg)` }}><i /><span>G</span></div>
          <div className="gravity-drop-guide" style={{ left: `${50 + hud.placementX / 10 * 100}%` }}><i /><span>DROP</span></div>
          <div className="gravity-event">{hud.lastEvent}</div>
          {hud.gameOver && <div className="game-over-panel"><p>TOWER LOST</p><h2>{hud.score.toLocaleString()}</h2><span>{hud.height.toFixed(1)} M PEAK</span><button className="primary-button" onClick={restart}>Build another seed ↗</button></div>}
        </div>

        <aside className="gravity-rail">
          <section className="gravity-vitals">
            <h2>STRUCTURE</h2>
            <StackMeter label="STABILITY" value={hud.stability} tone="stable" />
            <StackMeter label="INTEGRITY" value={hud.integrity} tone="integrity" />
          </section>
          <section className="next-shape-card">
            <div><span>NEXT SHAPE</span><b>#{String(hud.preview.id).padStart(3, "0")}</b></div>
            <ShapePreview shape={hud.preview} />
            <h3>{hud.preview.material} {hud.preview.kind}</h3>
            <dl><div><dt>WIDTH</dt><dd>{hud.preview.width.toFixed(2)}</dd></div><div><dt>WEIGHT</dt><dd>{hud.preview.density.toFixed(1)}</dd></div><div><dt>GRIP</dt><dd>{hud.preview.friction.toFixed(2)}</dd></div></dl>
          </section>
          <section className="gravity-role-card">
            <div><span>ROLE ROUTER</span><button onClick={onConnect}>{linked ? "ADD DEVICE" : "CONNECT DEVICES"} ↗</button></div>
            {GRAVITYSTACK_ROLES.map((role) => {
              const assignment = session?.assignments.find((item) => item.roleId === role.id);
              return <p key={role.id} className={assignment ? "linked" : ""}><i /> <strong>{role.label}</strong><span>{assignment ? assignment.deviceId : "CONVENTIONAL FALLBACK"}</span></p>;
            })}
          </section>
          <p className="gravity-note">One phone can steer gravity while the keyboard places shapes. Add a second Link device for a dedicated builder panel.</p>
        </aside>
      </div>
      <div className="gravity-instructions"><span><b>GRAVITY</b> Arrow keys / right stick / phone tilt</span><span><b>PLACE</b> A + D / left stick / builder slider</span><span><b>DROP</b> Space / gamepad A / Link</span></div>
    </section>
  );
}

function StackMeter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`stack-meter meter-${tone}`}><span>{label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></i><strong>{Math.round(value)}%</strong></div>;
}

/**
 * The next-shape preview is HTML in the page frame, not something drawn into the play field, so it
 * follows the site's monochrome rule rather than the game's palette. Nothing is lost: the preview
 * already reproduces the shape's silhouette exactly — an orb is a circle, everything else is sized
 * from its own width and height — and the silhouette is what tells the player what is coming.
 */
function ShapePreview({ shape }: { shape: StackShapeSpec }) {
  const style = shape.kind === "orb"
    ? { width: 74, height: 74, borderRadius: "50%", background: "var(--surface-strong)" }
    : { width: Math.min(115, 34 + shape.width * 22), height: Math.min(100, 24 + shape.height * 24), background: "var(--surface-strong)" };
  return <div className="shape-preview"><i style={style} /></div>;
}

function createStackView(parent: HTMLElement, getState: () => GravityStackState, Phaser: PhaserModule, Renderer2D101: Renderer2DConstructor) {
  class StackScene extends Phaser.Scene {
    private graphics?: import("phaser").GameObjects.Graphics;

    create() {
      this.graphics = this.add.graphics();
    }

    update() {
      const graphics = this.graphics;
      if (!graphics) return;
      const state = getState();
      graphics.clear();
      graphics.fillStyle(0x080b0d, 1).fillRect(0, 0, 1000, 680);
      graphics.lineStyle(1, 0xffffff, .045);
      for (let x = 20; x < 1000; x += 40) graphics.lineBetween(x, 0, x, 680);
      for (let y = 20; y < 680; y += 40) graphics.lineBetween(0, y, 1000, y);
      graphics.fillStyle(0xeff1e8, 1).fillRect(238, worldY(5.2) - 16, 524, 32);
      graphics.fillStyle(0x9e8cff, .22).fillRect(245, worldY(5.2) - 22, 510, 5);
      for (const piece of state.pieces) {
        if (piece.lost) continue;
        const x = worldX(piece.state.position.x);
        const y = worldY(piece.state.position.y);
        const color = Phaser.Display.Color.HexStringToColor(piece.color).color;
        graphics.save();
        graphics.translateCanvas(x, y);
        graphics.rotateCanvas(piece.state.rotation);
        graphics.fillStyle(color, 1);
        graphics.lineStyle(2, 0xeff1e8, .48);
        if (piece.kind === "orb") {
          const radius = (piece.radius ?? .55) * 50;
          graphics.fillCircle(0, 0, radius).strokeCircle(0, 0, radius);
        } else {
          graphics.fillRect(-piece.width * 25, -piece.height * 25, piece.width * 50, piece.height * 50);
          graphics.strokeRect(-piece.width * 25, -piece.height * 25, piece.width * 50, piece.height * 50);
        }
        graphics.restore();
      }
      const magnitude = Math.hypot(state.gravity.x, state.gravity.y) || 1;
      const gx = state.gravity.x / magnitude;
      const gy = state.gravity.y / magnitude;
      graphics.lineStyle(4, 0xff5c35, .82).lineBetween(500, 330, 500 + gx * 72, 330 + gy * 72);
      graphics.fillStyle(0xff5c35, 1).fillCircle(500 + gx * 72, 330 + gy * 72, 7);
    }
  }

  const renderer = new Renderer2D101({ parent, width: 1000, height: 680, background: "#080b0d", scenes: [StackScene] });
  return { destroy: () => renderer.destroy() };
}

function worldX(value: number) { return 500 + value * 50; }
function worldY(value: number) { return 320 + value * 50; }
