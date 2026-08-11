import { judgeTiming, type TimingGrade } from "@101/rhythm";
import { Game101, type GameContext } from "@101/sdk";
import { BeatForgeDirector, type BeatAction } from "./director.ts";

export type BeatTargetStatus = "pending" | TimingGrade;

export interface BeatTarget {
  id: string;
  groupId: number;
  action: BeatAction;
  targetSeconds: number;
  bpm: number;
  accent: boolean;
  status: BeatTargetStatus;
  judgedAt?: number;
}

export interface BeatForgeState {
  seed: string;
  director: BeatForgeDirector;
  targets: BeatTarget[];
  elapsed: number;
  bpm: number;
  score: number;
  combo: number;
  bestCombo: number;
  health: number;
  judged: number;
  timingPoints: number;
  accuracy: number;
  lastJudge: string;
  cueSequence: number;
  cue: "beat" | TimingGrade;
  gameOver: boolean;
  previous: Record<string, boolean>;
}

const ACTIONS: readonly BeatAction[] = ["left", "right", "punch", "raise", "duck"];

export function createBeatForgeGame(seed = "beatforge-101") {
  return Game101.define<BeatForgeState>({
    id: "beatforge",
    initialState: () => {
      const state: BeatForgeState = {
        seed,
        director: new BeatForgeDirector(seed),
        targets: [],
        elapsed: 0,
        bpm: 112,
        score: 0,
        combo: 0,
        bestCombo: 0,
        health: 100,
        judged: 0,
        timingPoints: 0,
        accuracy: 100,
        lastJudge: "FIND THE PULSE",
        cueSequence: 0,
        cue: "beat",
        gameOver: false,
        previous: {},
      };
      extendChart(state);
      return state;
    },
    start(ctx) {
      ["beat.left", "beat.right", "beat.punch", "beat.raise", "beat.duck", "swing", "gesture"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      extendChart(state);

      const current: Record<string, boolean> = {};
      const triggered: BeatAction[] = [];
      for (const action of ACTIONS) {
        current[action] = readAction(ctx, action);
        if (current[action] && !state.previous[action]) triggered.push(action);
      }
      current.swing = Boolean(ctx.input.action("swing", "role-performer") || ctx.input.action("swing", "player-1"));
      if (current.swing && !state.previous.swing) {
        const gesture = vectorWithFallback(ctx, "gesture", "role-performer");
        const outstanding = nearestPending(state);
        triggered.push(Math.abs(gesture.x) > .2 ? gesture.x < 0 ? "left" : "right" : outstanding?.action ?? "punch");
      }
      state.previous = current;

      for (const action of new Set(triggered)) attemptHit(state, action);
      for (const target of state.targets) {
        if (target.status !== "pending" || state.elapsed <= target.targetSeconds + .2) continue;
        target.status = "miss";
        target.judgedAt = state.elapsed;
        state.judged += 1;
        state.combo = 0;
        state.health = Math.max(0, state.health - 10);
        state.lastJudge = `${label(target.action)} MISSED`;
        state.cue = "miss";
        state.cueSequence += 1;
      }
      state.targets = state.targets.filter((target) => target.status === "pending" || state.elapsed - (target.judgedAt ?? state.elapsed) < 1.1);
      state.accuracy = state.judged ? state.timingPoints / (state.judged * 4) * 100 : 100;
      if (state.health <= 0) state.gameOver = true;
    },
  });
}

function attemptHit(state: BeatForgeState, action: BeatAction) {
  const candidates = state.targets
    .filter((target) => target.status === "pending" && target.action === action)
    .map((target) => ({ target, offset: state.elapsed - target.targetSeconds }))
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
  const candidate = candidates[0];
  if (!candidate || Math.abs(candidate.offset) > .19) return;
  const result = judgeTiming(candidate.offset);
  candidate.target.status = result.grade;
  candidate.target.judgedAt = state.elapsed;
  state.judged += 1;
  state.combo += 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  const points = result.grade === "perfect" ? 4 : result.grade === "great" ? 3 : result.grade === "good" ? 2 : 0;
  state.timingPoints += points;
  state.score += Math.round(100 * result.scoreMultiplier * (1 + Math.min(20, state.combo) * .06));
  state.health = Math.min(100, state.health + 1.5);
  state.lastJudge = `${result.grade.toUpperCase()} · ${candidate.offset >= 0 ? "+" : ""}${Math.round(candidate.offset * 1000)} MS`;
  state.cue = result.grade;
  state.cueSequence += 1;
}

function extendChart(state: BeatForgeState) {
  let lastTime = state.targets[state.targets.length - 1]?.targetSeconds ?? 0;
  while (lastTime < state.elapsed + 8) {
    const group = state.director.next();
    state.bpm = group.bpm;
    group.actions.forEach((action, index) => state.targets.push({
      id: `${group.id}-${index}`,
      groupId: group.id,
      action,
      targetSeconds: group.targetSeconds,
      bpm: group.bpm,
      accent: group.accent,
      status: "pending",
    }));
    lastTime = group.targetSeconds;
  }
}

function readAction(ctx: GameContext<BeatForgeState>, action: BeatAction) {
  const direct = Boolean(ctx.input.action(`beat.${action}`, "role-performer") || ctx.input.action(`beat.${action}`, "player-1"));
  if (direct) return true;
  if (action === "left") return Boolean(ctx.input.action("leanLeft", "player-1"));
  if (action === "right") return Boolean(ctx.input.action("leanRight", "player-1"));
  if (action === "punch") return Boolean(ctx.input.action("punch", "player-1"));
  if (action === "raise") return Boolean(ctx.input.action("armsRaised", "player-1"));
  return Boolean(ctx.input.action("duck", "player-1"));
}

function vectorWithFallback(ctx: GameContext<BeatForgeState>, name: string, playerId: string) {
  const role = ctx.input.vector(name, playerId);
  return Math.hypot(role.x, role.y) > .01 ? role : ctx.input.vector(name, "player-1");
}

function nearestPending(state: BeatForgeState) {
  return state.targets.filter((target) => target.status === "pending").sort((a, b) => Math.abs(a.targetSeconds - state.elapsed) - Math.abs(b.targetSeconds - state.elapsed))[0];
}

export function beatActionLabel(action: BeatAction) {
  return label(action);
}

function label(action: BeatAction) {
  return action === "left" ? "LEFT SLASH" : action === "right" ? "RIGHT SLASH" : action.toUpperCase();
}

export default createBeatForgeGame();
