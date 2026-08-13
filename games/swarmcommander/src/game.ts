import { Game101, type GameContext } from "@101/sdk";
import { selectInRadius, stepSwarm, swarmCentroid, type FormationKind, type SwarmAgent, type SwarmPoint } from "@101/swarm";
import { SwarmCommanderDirector, type SwarmEnemySpawn, type SwarmEnemyType, type SwarmModifier, type SwarmTerrain } from "./director.ts";

export interface CommanderEnemy extends SwarmEnemySpawn { hitPoints: number; maxHealth: number; reached: boolean }
export interface CommanderEffect { id: number; kind: "pulse" | "shield" | "hit" | "loss" | "recall"; x: number; y: number; createdAt: number }

export interface SwarmCommanderState {
  seed: string; director: SwarmCommanderDirector; elapsed: number; wave: number; nextWaveAt: number; modifier: SwarmModifier;
  agents: SwarmAgent[]; enemies: CommanderEnemy[]; terrain: SwarmTerrain[]; effects: CommanderEffect[];
  target: SwarmPoint; direction: SwarmPoint; formation: FormationKind; energy: number; shieldUntil: number; pulseReadyAt: number;
  score: number; streak: number; selected: number; lastEvent: string; actionSequence: number; impactSequence: number; effectId: number;
  casualtyDebt: number; previous: Record<string, boolean>; gameOver: boolean;
}

const FORMATION_ACTIONS: readonly [FormationKind, string][] = [
  ["cluster", "swarm.formation.cluster"], ["line", "swarm.formation.line"], ["wedge", "swarm.formation.wedge"], ["ring", "swarm.formation.ring"], ["grid", "swarm.formation.grid"],
];

export function createSwarmCommanderGame(seed = "swarmcommander-101") {
  return Game101.define<SwarmCommanderState>({
    id: "swarmcommander",
    initialState: () => {
      const state: SwarmCommanderState = {
        seed, director: new SwarmCommanderDirector(seed), elapsed: 0, wave: 0, nextWaveAt: 0, modifier: "clear",
        agents: createAgents(168), enemies: [], terrain: [], effects: [], target: { x: 0, y: 0 }, direction: { x: 0, y: 0 }, formation: "cluster",
        energy: 100, shieldUntil: 0, pulseReadyAt: 0, score: 0, streak: 0, selected: 0, lastEvent: "COLLECTIVE ONLINE · 168 SIGNALS", actionSequence: 0, impactSequence: 0, effectId: 0,
        casualtyDebt: 0, previous: {}, gameOver: false,
      };
      scheduleWave(state);
      return state;
    },
    start(ctx) {
      ["swarm.direction", "swarm.command", "swarm.select", "swarm.ability.pulse", "swarm.ability.shield", "swarm.ability.recall", ...FORMATION_ACTIONS.map(([, action]) => action)].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      if (state.elapsed >= state.nextWaveAt - .8) scheduleWave(state);
      state.energy = Math.min(100, state.energy + delta * 4.2);

      const direction = readDirection(ctx);
      state.direction = direction;
      const command = readCommand(ctx);
      if (Math.hypot(command.x, command.y) > .06) state.target = { x: command.x * 8.4, y: command.y * 5.2 };
      else if (Math.hypot(direction.x, direction.y) > .04) {
        state.target.x = clamp(state.target.x + direction.x * delta * 5.4, -8.4, 8.4);
        state.target.y = clamp(state.target.y + direction.y * delta * 5.4, -5.2, 5.2);
      }

      for (const [formation, action] of FORMATION_ACTIONS) if (edge(state, action, readAction(ctx, action))) setFormation(state, formation);
      const selecting = readAction(ctx, "swarm.select") || Boolean(ctx.input.action("trigger", "player-1")) || Boolean(ctx.input.action("hand.point", "player-1"));
      if (edge(state, "swarm.select", selecting)) {
        state.selected = selectInRadius(state.agents, state.target, 2.35);
        state.lastEvent = state.selected ? `${state.selected} AGENTS ASSIGNED TO PRECISION GROUP` : "SELECTION CLEARED · FULL COLLECTIVE ACTIVE";
        state.actionSequence += 1;
      }
      if (edge(state, "swarm.ability.pulse", readAction(ctx, "swarm.ability.pulse"))) ionPulse(state);
      if (edge(state, "swarm.ability.shield", readAction(ctx, "swarm.ability.shield"))) emergencyShield(state);
      if (edge(state, "swarm.ability.recall", readAction(ctx, "swarm.ability.recall"))) recall(state);

      const mobile = state.selected ? state.agents.filter((agent) => agent.selected) : state.agents;
      const center = swarmCentroid(mobile);
      const terrainSpeed = state.terrain.some((zone) => zone.type === "slow-field" && distance(center, zone) < zone.radius) ? .62 : 1;
      const modifierSpeed = state.modifier === "overclock" ? 1.24 : 1;
      const crosswind = state.modifier === "crosswind" ? { x: .45, y: -.18 } : { x: 0, y: 0 };
      stepSwarm(mobile, { target: state.target, direction: { x: direction.x + crosswind.x, y: direction.y + crosswind.y }, formation: state.formation, spacing: state.formation === "line" ? .31 : .4 }, delta, {
        maxSpeed: 6.2 * terrainSpeed * modifierSpeed, acceleration: 23, bounds: { minX: -9, maxX: 9, minY: -5.8, maxY: 5.8 },
      });
      if (mobile !== state.agents) for (const agent of state.agents) if (!agent.selected) { agent.vx *= Math.max(0, 1 - delta * 3); agent.vy *= Math.max(0, 1 - delta * 3); }

      resolveTerrain(state, delta);
      resolveEnemies(state, delta);
      state.enemies = state.enemies.filter((enemy) => enemy.hitPoints > 0 && enemy.spawnAt > state.elapsed - 32);
      state.effects = state.effects.filter((effect) => state.elapsed - effect.createdAt < 1.1);
      state.selected = state.agents.filter((agent) => agent.selected).length;
      if (state.agents.length < 10) { state.gameOver = true; state.lastEvent = "COLLECTIVE SIGNAL LOST"; }
    },
  });
}

function scheduleWave(state: SwarmCommanderState) {
  const wave = state.director.next();
  state.wave = wave.id; state.nextWaveAt = wave.startsAt + wave.duration; state.modifier = wave.modifier; state.terrain = wave.terrain;
  state.enemies.push(...wave.enemies.map((enemy): CommanderEnemy => ({ ...enemy, hitPoints: enemy.health, maxHealth: enemy.health, reached: false })));
  const reinforcementCount = wave.id === 1 ? 0 : Math.min(11, 4 + Math.floor(wave.id / 4));
  state.agents.push(...createAgents(Math.min(reinforcementCount, 280 - state.agents.length), state.agents.length, state.target));
  if (wave.boss) state.lastEvent = "HIVE MIND ENTERING THE FIELD";
  else if (wave.modifier !== "clear") state.lastEvent = `WAVE ${wave.id} · ${wave.modifier.toUpperCase()} MODIFIER`;
}

function resolveTerrain(state: SwarmCommanderState, delta: number) {
  const center = swarmCentroid(state.agents);
  for (const zone of state.terrain) {
    if (distance(center, zone) > zone.radius) continue;
    if (zone.type === "repair-zone") state.energy = Math.min(100, state.energy + delta * 11);
    if (zone.type === "ion-storm" && state.elapsed >= state.shieldUntil) state.casualtyDebt += delta * .3;
  }
}

function resolveEnemies(state: SwarmCommanderState, delta: number) {
  const center = swarmCentroid(state.agents);
  for (const enemy of state.enemies) {
    if (enemy.spawnAt > state.elapsed || enemy.hitPoints <= 0) continue;
    const dx = center.x - enemy.x; const dy = center.y - enemy.y; const length = Math.hypot(dx, dy) || 1;
    const stopDistance = enemy.type === "artillery" ? 3.4 : enemy.type === "hive" ? 1.7 : .72;
    if (length > stopDistance) { enemy.x += dx / length * enemy.speed * delta; enemy.y += dy / length * enemy.speed * delta; }
    let attackers = 0;
    for (const agent of state.agents) if ((agent.x - enemy.x) ** 2 + (agent.y - enemy.y) ** 2 < 1.55 ** 2) attackers += 1;
    if (attackers) enemy.hitPoints -= attackers * delta * (enemy.type === "tank" ? .18 : .28);
    if (length <= stopDistance + .3) {
      const shield = state.elapsed < state.shieldUntil ? .18 : 1;
      state.casualtyDebt += enemy.damage * delta * shield * (enemy.type === "artillery" ? .42 : 1);
      enemy.reached = true;
    }
    if (enemy.hitPoints <= 0) destroyEnemy(state, enemy);
  }
  while (state.casualtyDebt >= 1 && state.agents.length) {
    state.casualtyDebt -= 1;
    const target = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0).sort((a, b) => distance(a, center) - distance(b, center))[0];
    let index = state.agents.length - 1;
    if (target) {
      let nearest = Infinity;
      state.agents.forEach((agent, candidate) => { const value = distance(agent, target); if (value < nearest) { nearest = value; index = candidate; } });
    }
    const [lost] = state.agents.splice(index, 1);
    if (lost) addEffect(state, "loss", lost.x, lost.y);
    state.streak = 0; state.impactSequence += 1;
  }
}

function destroyEnemy(state: SwarmCommanderState, enemy: CommanderEnemy) {
  if (enemy.hitPoints < -999) return;
  enemy.hitPoints = -1000;
  state.streak += 1;
  state.score += Math.round(enemyScore(enemy.type) * (1 + Math.min(30, state.streak) * .045));
  state.energy = Math.min(100, state.energy + (enemy.type === "hive" ? 28 : 5));
  state.lastEvent = `${enemy.type.toUpperCase()} DISASSEMBLED · STREAK ${state.streak}`;
  state.impactSequence += 1;
  addEffect(state, "hit", enemy.x, enemy.y);
}

function setFormation(state: SwarmCommanderState, formation: FormationKind) { state.formation = formation; state.lastEvent = `${formation.toUpperCase()} FORMATION LOCKED`; state.actionSequence += 1; }
function ionPulse(state: SwarmCommanderState) {
  if (state.elapsed < state.pulseReadyAt || state.energy < 35) { state.lastEvent = "ION PULSE RECHARGING"; return; }
  state.energy -= 35; state.pulseReadyAt = state.elapsed + 5.5;
  let hits = 0;
  for (const enemy of state.enemies) if (enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0 && distance(enemy, state.target) < 3.4) { enemy.hitPoints -= 18; hits += 1; if (enemy.hitPoints <= 0) destroyEnemy(state, enemy); }
  state.lastEvent = `ION PULSE · ${hits} HOSTILE SIGNAL${hits === 1 ? "" : "S"}`; state.actionSequence += 1; addEffect(state, "pulse", state.target.x, state.target.y);
}
function emergencyShield(state: SwarmCommanderState) {
  if (state.energy < 25) { state.lastEvent = "SHIELD NEEDS 25 ENERGY"; return; }
  state.energy -= 25; state.shieldUntil = Math.max(state.shieldUntil, state.elapsed + 3.5); state.lastEvent = "COLLECTIVE SHIELD · 3.5 SECONDS"; state.actionSequence += 1; addEffect(state, "shield", state.target.x, state.target.y);
}
function recall(state: SwarmCommanderState) {
  state.target = { x: 0, y: 0 }; state.agents.forEach((agent) => { agent.selected = false; }); state.selected = 0; state.formation = "cluster";
  state.lastEvent = "INSTANT RECALL · FULL COLLECTIVE"; state.actionSequence += 1; addEffect(state, "recall", 0, 0);
}

function readAction(ctx: GameContext<SwarmCommanderState>, action: string) { return Boolean(ctx.input.action(action, "role-navigator") || ctx.input.action(action, "role-tactician") || ctx.input.action(action, "player-1")); }
function readDirection(ctx: GameContext<SwarmCommanderState>) { return firstVector(ctx, "swarm.direction", ["role-navigator", "player-1"], "move"); }
function readCommand(ctx: GameContext<SwarmCommanderState>) {
  const semantic = firstVector(ctx, "swarm.command", ["role-tactician", "player-1"]);
  if (Math.hypot(semantic.x, semantic.y) > .02) return semantic;
  return ctx.input.vector("aim", "player-1");
}
function firstVector(ctx: GameContext<SwarmCommanderState>, name: string, players: string[], fallback?: string) { for (const player of players) { const vector = ctx.input.vector(name, player); if (Math.hypot(vector.x, vector.y) > .02) return vector; } return fallback ? ctx.input.vector(fallback, "player-1") : { x: 0, y: 0 }; }
function edge(state: SwarmCommanderState, key: string, active: boolean) { const previous = state.previous[key] ?? false; state.previous[key] = active; return active && !previous; }
function createAgents(count: number, offset = 0, center: SwarmPoint = { x: 0, y: 0 }): SwarmAgent[] { return Array.from({ length: Math.max(0, count) }, (_, index) => { const angle = (index + offset) * 2.399963229728653; const radius = Math.sqrt(index + 1) * .08; return { id: `agent-${offset + index}`, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, vx: 0, vy: 0 }; }); }
function addEffect(state: SwarmCommanderState, kind: CommanderEffect["kind"], x: number, y: number) { state.effects.push({ id: ++state.effectId, kind, x, y, createdAt: state.elapsed }); }
function enemyScore(type: SwarmEnemyType) { return type === "hive" ? 3200 : type === "tank" ? 420 : type === "artillery" ? 310 : type === "splitter" ? 230 : 160; }
function distance(a: SwarmPoint, b: SwarmPoint) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }

export default createSwarmCommanderGame();
