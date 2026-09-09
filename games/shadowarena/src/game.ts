import { Game101, type GameContext } from "@101/sdk";
import { ShadowArenaDirector, type ArenaModifier, type ShadowAttack, type ShadowEnemyType, type ShadowSpawn } from "./director.ts";

export interface ShadowEnemy extends ShadowSpawn {
  x: number;
  hitPoints: number;
  attackAt: number;
  attacked: boolean;
  targetSlot?: number;
  staggerUntil: number;
}

export interface ShadowEffect { id: number; kind: "hit" | "block" | "hurt" | "special"; x: number; createdAt: number }

export interface ShadowPlayer {
  slot: number;
  playerId: string;
  active: boolean;
  playerX: number;
  playerY: number;
  facing: -1 | 1;
  lastAction: string;
  previous: Record<"left" | "right" | "special", boolean>;
  block: boolean;
  duck: boolean;
  jump: boolean;
}

export interface ShadowArenaState {
  /** Fighters move and defend independently while sharing team health, focus and score. */
  players: ShadowPlayer[];
  seed: string;
  director: ShadowArenaDirector;
  elapsed: number;
  round: number;
  nextRoundAt: number;
  modifier: ArenaModifier;
  enemies: ShadowEnemy[];
  effects: ShadowEffect[];
  playerX: number;
  playerY: number;
  facing: -1 | 1;
  health: number;
  focus: number;
  score: number;
  combo: number;
  lastEvent: string;
  lastAction: string;
  actionSequence: number;
  impactSequence: number;
  effectId: number;
  previous: Record<"left" | "right" | "special", boolean>;
  gameOver: boolean;
}

export function createShadowArenaGame(seed = "shadowarena-101") {
  return Game101.define<ShadowArenaState>({
    id: "shadowarena",
    initialState: () => {
      const state: ShadowArenaState = {
        players: [1, 2].map((slot) => ({ slot, playerId: `player-${slot}`, active: slot === 1, playerX: slot === 1 ? 0 : 1.4, playerY: 0, facing: 1, lastAction: "READY", previous: { left: false, right: false, special: false }, block: false, duck: false, jump: false })),
        seed, director: new ShadowArenaDirector(seed), elapsed: 0, round: 0, nextRoundAt: 0, modifier: "clear", enemies: [], effects: [],
        playerX: 0, playerY: 0, facing: 1, health: 100, focus: 0, score: 0, combo: 0,
        lastEvent: "THE ARENA IS LISTENING", lastAction: "READY", actionSequence: 0, impactSequence: 0, effectId: 0,
        previous: { left: false, right: false, special: false }, gameOver: false,
      };
      extendRounds(state);
      return state;
    },
    start(ctx) {
      ["combat.punchLeft", "combat.punchRight", "combat.block", "combat.duck", "combat.jump", "combat.special", "combat.move"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      extendRounds(state);
      state.focus = Math.min(100, state.focus + delta * 3.2);
      for (const player of state.players) {
        player.active = player.slot === 1 || Boolean(ctx.input.pose("body", player.playerId)?.length);
        if (!player.active) { player.previous = { left: false, right: false, special: false }; continue; }
        const move = readMove(ctx, player.playerId);
        const mirrored = state.modifier === "mirror" ? -1 : 1;
        player.playerX = clamp(player.playerX + move.x * mirrored * delta * 4.6, -4.4, 4.4);
        if (Math.abs(move.x) > .08) player.facing = move.x > 0 ? 1 : -1;
        player.jump = readAction(ctx, player.playerId, "combat.jump", "jump");
        player.duck = readAction(ctx, player.playerId, "combat.duck", "duck");
        player.block = readAction(ctx, player.playerId, "combat.block");
        player.playerY = player.jump ? (state.modifier === "low-gravity" ? 1.65 : 1.1) : player.duck ? -.52 : 0;
        const left = readAction(ctx, player.playerId, "combat.punchLeft");
        const right = readAction(ctx, player.playerId, "combat.punchRight");
        const special = readAction(ctx, player.playerId, "combat.special");
        if (left && !player.previous.left) punch(state, player, -1);
        if (right && !player.previous.right) punch(state, player, 1);
        if (special && !player.previous.special) shadowBurst(state, player);
        player.previous = { left, right, special };
      }
      const primary = state.players[0]!;
      state.playerX = primary.playerX; state.playerY = primary.playerY; state.facing = primary.facing;
      state.previous = primary.previous;

      for (const enemy of state.enemies) {
        if (enemy.spawnAt > state.elapsed || enemy.hitPoints <= 0) continue;
        const active = state.players.filter((player) => player.active);
        let target = active.find((player) => player.slot === enemy.targetSlot);
        if (!target) {
          enemy.targetSlot = undefined; enemy.attackAt = 0;
          target = active.sort((a, b) => Math.abs(a.playerX - enemy.x) - Math.abs(b.playerX - enemy.x))[0]!;
        }
        const direction = Math.sign(target.playerX - enemy.x) || enemy.side * -1;
        if (state.elapsed >= enemy.staggerUntil && Math.abs(enemy.x - target.playerX) > 1.12) enemy.x += direction * enemy.speed * delta;
        if (Math.abs(enemy.x - target.playerX) <= 1.18 && enemy.attackAt === 0) {
          enemy.attackAt = state.elapsed + enemy.windup;
          enemy.targetSlot = target.slot;
        }
        if (enemy.attackAt > 0 && state.elapsed >= enemy.attackAt && !enemy.attacked) resolveEnemyAttack(state, enemy, target);
      }
      state.enemies = state.enemies.filter((enemy) => enemy.hitPoints > 0 && (enemy.spawnAt > state.elapsed - 1 || Math.abs(enemy.x) < 13));
      state.effects = state.effects.filter((effect) => state.elapsed - effect.createdAt < .9);
      if (state.health <= 0) state.gameOver = true;
    },
  });
}

function extendRounds(state: ShadowArenaState) {
  while (state.nextRoundAt < state.elapsed + 9) {
    const round = state.director.next();
    state.round = round.id;
    state.nextRoundAt = round.startsAt + round.duration;
    state.modifier = round.modifier;
    state.enemies.push(...round.spawns.map((spawn): ShadowEnemy => ({ ...spawn, x: spawn.side * 9.5, hitPoints: spawn.health, attackAt: 0, attacked: false, staggerUntil: 0 })));
    if (round.boss) state.lastEvent = "SENTINEL SILHOUETTE DETECTED";
    else if (round.modifier !== "clear") state.lastEvent = `${round.modifier.toUpperCase()} ARENA MODIFIER`;
  }
}

function punch(state: ShadowArenaState, player: ShadowPlayer, side: -1 | 1) {
  player.facing = side;
  state.lastAction = player.lastAction = side < 0 ? "LEFT PUNCH" : "RIGHT PUNCH";
  state.actionSequence += 1;
  const target = state.enemies
    .filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0 && Math.sign(enemy.x - player.playerX) === side)
    .sort((a, b) => Math.abs(a.x - player.playerX) - Math.abs(b.x - player.playerX))[0];
  if (!target || Math.abs(target.x - player.playerX) > 2.15) { state.lastEvent = `${state.lastAction} CUT THE AIR`; return; }
  damageEnemy(state, target, target.type === "shade" ? 2 : 1.5);
  target.staggerUntil = state.elapsed + .34;
  addEffect(state, "hit", target.x);
}

function shadowBurst(state: ShadowArenaState, player: ShadowPlayer) {
  if (state.focus < 55) { state.lastEvent = "FOCUS BELOW SHADOW BURST THRESHOLD"; return; }
  state.focus -= 55;
  state.lastAction = player.lastAction = "SHADOW BURST";
  state.actionSequence += 1;
  const victims = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0 && Math.abs(enemy.x - player.playerX) < 4.2);
  victims.forEach((enemy) => damageEnemy(state, enemy, 4));
  state.lastEvent = victims.length ? `SHADOW BURST · ${victims.length} TARGETS` : "SHADOW BURST ECHOED EMPTY";
  addEffect(state, "special", player.playerX);
}

function resolveEnemyAttack(state: ShadowArenaState, enemy: ShadowEnemy, defense: ShadowPlayer) {
  enemy.attacked = true;
  const avoided = enemy.attack === "high" ? defense.duck : enemy.attack === "low" ? defense.jump : defense.block;
  if (avoided) {
    state.focus = Math.min(100, state.focus + 14);
    state.score += 60 + state.combo * 8;
    state.lastEvent = `${defenseLabel(enemy.attack)} · COUNTER WINDOW`;
    enemy.staggerUntil = state.elapsed + .85;
    enemy.attackAt = state.elapsed + 1.4;
    enemy.attacked = false;
    addEffect(state, "block", defense.playerX);
    return;
  }
  const damage = enemy.attack === "heavy" ? 19 : enemy.type === "sentinel" ? 16 : 11;
  state.health = Math.max(0, state.health - damage);
  state.combo = 0;
  state.lastEvent = `${enemyLabel(enemy.type)} LANDED ${enemy.attack.toUpperCase()}`;
  state.impactSequence += 1;
  enemy.attackAt = state.elapsed + 1.55;
  enemy.attacked = false;
  addEffect(state, "hurt", defense.playerX);
}

function damageEnemy(state: ShadowArenaState, enemy: ShadowEnemy, amount: number) {
  if (enemy.hitPoints <= 0) return;
  enemy.hitPoints -= amount;
  if (enemy.hitPoints > 0) { state.lastEvent = `${enemyLabel(enemy.type)} · ${Math.ceil(enemy.hitPoints)} HP`; return; }
  state.combo += 1;
  state.focus = Math.min(100, state.focus + 8);
  state.score += Math.round((enemy.type === "sentinel" ? 1_800 : enemy.type === "brute" ? 360 : 180) * (1 + Math.min(20, state.combo) * .08));
  state.lastEvent = `${enemyLabel(enemy.type)} DISPERSED · CHAIN ${state.combo}`;
  state.impactSequence += 1;
}

function readAction(ctx: GameContext<ShadowArenaState>, playerId: string, action: string, fallback?: string) {
  return Boolean((playerId === "player-1" && ctx.input.action(action, "role-fighter"))
    || ctx.input.action(action, playerId) || (fallback && ctx.input.action(fallback, playerId)));
}

function readMove(ctx: GameContext<ShadowArenaState>, playerId: string) {
  if (playerId === "player-1") {
    const role = ctx.input.vector("combat.move", "role-fighter");
    if (Math.hypot(role.x, role.y) > .02) return role;
  }
  const semantic = ctx.input.vector("combat.move", playerId);
  if (Math.hypot(semantic.x, semantic.y) > .02) return semantic;
  return ctx.input.vector("move", playerId);
}

function addEffect(state: ShadowArenaState, kind: ShadowEffect["kind"], x: number) { state.effects.push({ id: ++state.effectId, kind, x, createdAt: state.elapsed }); }
function defenseLabel(attack: ShadowAttack) { return attack === "high" ? "DUCK" : attack === "low" ? "JUMP" : "BLOCK"; }
function enemyLabel(type: ShadowEnemyType) { return type.toUpperCase(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

export default createShadowArenaGame();
