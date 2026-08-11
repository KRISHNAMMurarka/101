import { Game101 } from "@101/sdk";
import { BodyDodgeDirector, type DodgeGate, type DodgeRequirement } from "./director.ts";

export interface BodyDodgeState {
  seed: string;
  director: BodyDodgeDirector;
  gates: DodgeGate[];
  distance: number;
  speed: number;
  elapsed: number;
  wave: number;
  playerX: number;
  crouch: number;
  lift: number;
  lean: number;
  arms: number;
  score: number;
  combo: number;
  integrity: number;
  gameOver: boolean;
  lastEvent: string;
  lastRequirement: DodgeRequirement;
}

export function createBodyDodgeGame(seed = "bodydodge-101") {
  return Game101.define<BodyDodgeState>({
    id: "bodydodge",
    initialState: () => {
      const director = new BodyDodgeDirector(seed);
      const first = director.next(0);
      return {
        seed,
        director,
        gates: [first],
        distance: 0,
        speed: first.speed,
        elapsed: 0,
        wave: 1,
        playerX: 0,
        crouch: 0,
        lift: 0,
        lean: 0,
        arms: 0,
        score: 0,
        combo: 0,
        integrity: 100,
        gameOver: false,
        lastEvent: "CALIBRATE OR USE KEYS",
        lastRequirement: first.requirement,
      };
    },
    start(ctx) {
      ["dodgeX", "duck", "jump", "armsRaised", "leanLeft", "leanRight"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.wave = 1 + Math.floor(state.elapsed / 25);
      const cameraX = ctx.input.axis("dodgeX");
      const conventionalX = ctx.input.axis("moveX");
      const targetX = Math.abs(cameraX) > .02 ? cameraX : conventionalX;
      const ducking = Boolean(ctx.input.action("duck"));
      const jumping = Boolean(ctx.input.action("jump"));
      const armsRaised = Boolean(ctx.input.action("armsRaised"));
      const leaning = ctx.input.axis("lean") || (ctx.input.action("leanLeft") ? -1 : ctx.input.action("leanRight") ? 1 : 0);
      state.playerX += (clamp(targetX) - state.playerX) * Math.min(1, delta * 9);
      state.crouch += (Number(ducking) - state.crouch) * Math.min(1, delta * 12);
      state.lift += (Number(jumping) - state.lift) * Math.min(1, delta * 13);
      state.arms += (Number(armsRaised) - state.arms) * Math.min(1, delta * 10);
      state.lean += (clamp(leaning) - state.lean) * Math.min(1, delta * 9);

      const nextGate = state.gates.find((gate) => !gate.resolved);
      state.speed += (((nextGate?.speed ?? 14) - state.speed) * Math.min(1, delta * 1.8));
      state.distance += state.speed * delta;
      state.score += Math.round(state.speed * delta * (1 + state.combo * .06));
      extendCourse(state);

      for (const gate of state.gates) {
        if (gate.resolved || gate.distance - state.distance > 1.1) continue;
        gate.resolved = true;
        gate.passed = satisfies(gate.requirement, state);
        state.lastRequirement = gate.requirement;
        if (gate.passed) {
          state.combo += 1;
          state.score += 100 + state.combo * 15;
          state.lastEvent = `${label(gate.requirement)} CLEAR`;
        } else {
          state.integrity = Math.max(0, state.integrity - 25);
          state.combo = 0;
          state.lastEvent = `${label(gate.requirement)} MISSED`;
        }
      }
      state.gates = state.gates.filter((gate) => gate.distance > state.distance - 12);
      if (state.integrity <= 0) state.gameOver = true;
    },
  });
}

function extendCourse(state: BodyDodgeState) {
  let last = state.gates[state.gates.length - 1];
  while (!last || last.distance < state.distance + 180) {
    const next = state.director.next(last?.distance ?? state.distance);
    state.gates.push(next);
    last = next;
  }
}

function satisfies(requirement: DodgeRequirement, state: BodyDodgeState) {
  if (requirement === "center") return Math.abs(state.playerX) < .34;
  if (requirement === "left") return state.playerX < -.38;
  if (requirement === "right") return state.playerX > .38;
  if (requirement === "duck") return state.crouch > .5;
  if (requirement === "jump") return state.lift > .45;
  if (requirement === "arms") return state.arms > .5;
  if (requirement === "lean-left") return state.lean < -.35 || state.playerX < -.48;
  return state.lean > .35 || state.playerX > .48;
}

function label(requirement: DodgeRequirement) {
  return requirement.replace("-", " ").toUpperCase();
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

export default createBodyDodgeGame();
