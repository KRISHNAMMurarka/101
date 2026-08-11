import { Game101 } from "@101/sdk";
import { SlashstormDirector, type SlashTarget } from "./director.ts";

export interface SlashParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export interface SlashstormState {
  seed: string;
  director: SlashstormDirector;
  targets: SlashTarget[];
  particles: SlashParticle[];
  blade: { x: number; y: number };
  previousBlade: { x: number; y: number };
  score: number;
  combo: number;
  bestCombo: number;
  lives: number;
  elapsed: number;
  wave: number;
  gameOver: boolean;
  lastHit: string;
}

export function createSlashstormGame(seed = "slashstorm-101") {
  return Game101.define<SlashstormState>({
    id: "slashstorm",
    initialState: () => ({
      seed,
      director: new SlashstormDirector(seed),
      targets: [],
      particles: [],
      blade: { x: 0, y: 0.45 },
      previousBlade: { x: 0, y: 0.45 },
      score: 0,
      combo: 0,
      bestCombo: 0,
      lives: 3,
      elapsed: 0,
      wave: 1,
      gameOver: false,
      lastHit: "",
    }),
    start(ctx) {
      ctx.input.bind("aim");
      ctx.input.bind("move");
      ctx.input.bind("slash");
      ctx.input.bind("trigger");
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.wave = 1 + Math.floor(state.elapsed / 20);

      state.previousBlade = { ...state.blade };
      const aim = ctx.input.vector("aim");
      const move = ctx.input.vector("move");
      if (Math.abs(aim.x) + Math.abs(aim.y) > 0.015) {
        state.blade.x = clamp(aim.x);
        state.blade.y = clamp(aim.y);
      } else {
        state.blade.x = clamp(state.blade.x + move.x * delta * 1.7);
        state.blade.y = clamp(state.blade.y + move.y * delta * 1.7);
      }

      state.director.update(delta, state.elapsed, (target) => state.targets.push(target));
      const gravity = 0.82;
      for (const target of state.targets) {
        target.vy += gravity * delta;
        target.x += target.vx * delta;
        target.y += target.vy * delta;
        target.rotation += target.spin * delta;
      }

      const bladeDistance = Math.hypot(
        state.blade.x - state.previousBlade.x,
        state.blade.y - state.previousBlade.y,
      );
      const isSlashing = Boolean(ctx.input.action("slash")) || Boolean(ctx.input.action("trigger"));
      if (isSlashing && (bladeDistance > 0.006 || Math.abs(move.x) + Math.abs(move.y) > 0)) {
        const slashStart = bladeDistance > 0.006
          ? state.previousBlade
          : {
              x: clamp(state.blade.x - move.x * 1.8),
              y: clamp(state.blade.y - move.y * 1.8),
            };
        for (const target of state.targets) {
          if (distanceToSegment(target.x, target.y, slashStart.x, slashStart.y, state.blade.x, state.blade.y) > target.radius + 0.035) continue;
          target.health -= 1;
          if (target.health > 0) {
            state.score += 4;
            state.lastHit = "ARMOR CRACK";
            continue;
          }
          if (target.kind === "bomb") {
            state.lives -= 1;
            state.combo = 0;
            state.lastHit = "OVERLOAD";
          } else {
            const value = target.kind === "bonus" ? 30 : target.kind === "core" ? 15 : target.kind === "armored" ? 24 : 10;
            state.combo += 1;
            state.bestCombo = Math.max(state.bestCombo, state.combo);
            state.score += value * Math.max(1, Math.min(5, Math.floor(state.combo / 4) + 1));
            state.lastHit = `${target.kind.toUpperCase()} +${value}`;
          }
          burst(state, target);
        }
      }

      const remaining: SlashTarget[] = [];
      for (const target of state.targets) {
        if (target.health <= 0) continue;
        if (target.y > 1.35 && target.vy > 0) {
          if (target.kind !== "bomb") {
            state.lives -= 1;
            state.combo = 0;
            state.lastHit = "CORE MISSED";
          }
          continue;
        }
        remaining.push(target);
      }
      state.targets = remaining;

      for (const particle of state.particles) {
        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        particle.vy += gravity * 0.5 * delta;
        particle.life -= delta;
      }
      state.particles = state.particles.filter((particle) => particle.life > 0);
      if (state.lives <= 0) state.gameOver = true;
    },
  });
}

function burst(state: SlashstormState, target: SlashTarget) {
  const color = target.kind === "bomb" ? "#ff5c35" : target.kind === "bonus" ? "#b5ff66" : "#50e3ff";
  for (let index = 0; index < 9; index += 1) {
    const angle = (index / 9) * Math.PI * 2 + target.rotation;
    state.particles.push({
      x: target.x,
      y: target.y,
      vx: Math.cos(angle) * (0.25 + (index % 3) * 0.08),
      vy: Math.sin(angle) * (0.25 + (index % 2) * 0.1),
      life: 0.45 + (index % 4) * 0.06,
      color,
    });
  }
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared ? clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSquared) : 0;
  return Math.hypot(px - (ax + dx * amount), py - (ay + dy * amount));
}

const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export default createSlashstormGame();
