import { Game101 } from "@101/sdk";
import { BodyDodgeDirector, type DodgeGate, type DodgeRequirement } from "./director.ts";

export interface BodyDodgePlayer {
  slot: number;
  playerId: string;
  active: boolean;
  playerX: number;
  crouch: number;
  lift: number;
  lean: number;
  arms: number;
  cleared: number;
  missed: number;
}

export interface BodyDodgeState {
  /** One shared course and integrity pool, with independent movement and gate judgments. */
  players: BodyDodgePlayer[];
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
        players: [1, 2].map((slot) => ({ slot, playerId: `player-${slot}`, active: slot === 1, playerX: 0, crouch: 0, lift: 0, lean: 0, arms: 0, cleared: 0, missed: 0 })),
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
      ["body.move", "dodgeX", "duck", "jump", "armsRaised", "leanLeft", "leanRight"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.wave = 1 + Math.floor(state.elapsed / 25);
      for (const player of state.players) {
        // Player one always retains keyboard/phone fallback; another body participates while visible.
        player.active = player.slot === 1 || Boolean(ctx.input.pose("body", player.playerId)?.length);
        if (!player.active) continue;
        const linkedMove = ctx.input.vector("body.move", player.playerId);
        const cameraX = ctx.input.axis("dodgeX", player.playerId);
        const conventionalX = ctx.input.axis("moveX", player.playerId);
        const targetX = Math.abs(linkedMove.x) > .02 ? linkedMove.x : Math.abs(cameraX) > .02 ? cameraX : conventionalX;
        const ducking = Boolean(ctx.input.action("duck", player.playerId)) || linkedMove.y > .55;
        const jumping = Boolean(ctx.input.action("jump", player.playerId)) || linkedMove.y < -.55;
        const armsRaised = Boolean(ctx.input.action("armsRaised", player.playerId));
        const leaning = ctx.input.axis("lean", player.playerId) || linkedMove.x || (ctx.input.action("leanLeft", player.playerId) ? -1 : ctx.input.action("leanRight", player.playerId) ? 1 : 0);
        player.playerX += (clamp(targetX) - player.playerX) * Math.min(1, delta * 9);
        player.crouch += (Number(ducking) - player.crouch) * Math.min(1, delta * 12);
        player.lift += (Number(jumping) - player.lift) * Math.min(1, delta * 13);
        player.arms += (Number(armsRaised) - player.arms) * Math.min(1, delta * 10);
        player.lean += (clamp(leaning) - player.lean) * Math.min(1, delta * 9);
      }
      const primary = state.players[0]!;
      state.playerX = primary.playerX; state.crouch = primary.crouch; state.lift = primary.lift;
      state.arms = primary.arms; state.lean = primary.lean;

      const nextGate = state.gates.find((gate) => !gate.resolved);
      state.speed += (((nextGate?.speed ?? 14) - state.speed) * Math.min(1, delta * 1.8));
      state.distance += state.speed * delta;
      state.score += Math.round(state.speed * delta * (1 + state.combo * .06));
      extendCourse(state);

      for (const gate of state.gates) {
        if (gate.resolved || gate.distance - state.distance > 1.1) continue;
        gate.resolved = true;
        const players = state.players.filter((player) => player.active);
        const passed = players.filter((player) => satisfies(gate.requirement, player));
        gate.passed = passed.length === players.length;
        state.lastRequirement = gate.requirement;
        state.combo = gate.passed ? state.combo + 1 : 0;
        for (const player of players) {
          if (passed.includes(player)) {
            player.cleared++;
            state.score += 100 + state.combo * 15;
          } else {
            player.missed++;
            state.integrity = Math.max(0, state.integrity - 25);
          }
        }
        state.lastEvent = `${label(gate.requirement)} ${gate.passed ? "CLEAR" : "MISSED"}`;
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

function satisfies(requirement: DodgeRequirement, state: BodyDodgePlayer) {
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
