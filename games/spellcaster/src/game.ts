import { Game101, type GameContext } from "@101/sdk";
import { SpellcasterDirector, type ArcaneEnemyType, type ArcaneSpawn, type SpellId } from "./director.ts";

export interface ArcaneEnemy extends ArcaneSpawn {
  radius: number;
  hitPoints: number;
  stunnedUntil: number;
}

export interface SpellEffect {
  id: number;
  spell: SpellId | "impact";
  angle: number;
  radius: number;
  createdAt: number;
  strength: number;
}

export interface SpellcasterState {
  seed: string;
  director: SpellcasterDirector;
  elapsed: number;
  wave: number;
  nextWaveAt: number;
  enemies: ArcaneEnemy[];
  effects: SpellEffect[];
  score: number;
  combo: number;
  health: number;
  mana: number;
  charge: number;
  shieldUntil: number;
  aim: { x: number; y: number };
  lastCast: SpellId;
  lastEvent: string;
  castSequence: number;
  impactSequence: number;
  effectId: number;
  previous: Record<SpellId, boolean>;
  gameOver: boolean;
}

export const SPELLS: readonly SpellId[] = ["shield", "grab", "projectile", "charge", "blade", "vortex"];

const COST: Record<SpellId, number> = { shield: 18, grab: 12, vortex: 32, projectile: 8, charge: 0, blade: 15 };

export function createSpellcasterGame(seed = "spellcaster-101") {
  return Game101.define<SpellcasterState>({
    id: "spellcaster",
    initialState: () => {
      const state: SpellcasterState = {
        seed,
        director: new SpellcasterDirector(seed),
        elapsed: 0,
        wave: 0,
        nextWaveAt: 0,
        enemies: [],
        effects: [],
        score: 0,
        combo: 0,
        health: 100,
        mana: 100,
        charge: 0,
        shieldUntil: 0,
        aim: { x: 0, y: 0 },
        lastCast: "projectile",
        lastEvent: "THE VEIL IS OPENING",
        castSequence: 0,
        impactSequence: 0,
        effectId: 0,
        previous: { shield: false, grab: false, vortex: false, projectile: false, charge: false, blade: false },
        gameOver: false,
      };
      extendWaves(state);
      return state;
    },
    start(ctx) {
      SPELLS.forEach((spell) => ctx.input.bind(`spell.cast.${spell}`));
      ctx.input.bind("spell.aim");
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      state.elapsed += delta;
      state.mana = Math.min(100, state.mana + delta * (state.charge > 0 ? 5.4 : 8));
      state.aim = readAim(ctx);
      extendWaves(state);

      const current = { ...state.previous };
      for (const spell of SPELLS) {
        current[spell] = readSpell(ctx, spell);
        if (current[spell] && !state.previous[spell]) castSpell(state, spell);
      }
      state.previous = current;

      for (const enemy of state.enemies) {
        if (enemy.spawnAt > state.elapsed || enemy.hitPoints <= 0) continue;
        if (state.elapsed >= enemy.stunnedUntil) enemy.radius -= enemy.speed * delta;
        enemy.angle += Math.sin(state.elapsed * .7 + enemy.id.length) * delta * .035;
        if (enemy.radius > 1.15) continue;
        if (state.shieldUntil > state.elapsed) {
          damageEnemy(state, enemy, 99, "shield");
          state.lastEvent = "SHIELD RETURNED AN IMPACT";
        } else {
          enemy.hitPoints = 0;
          state.health = Math.max(0, state.health - (enemy.type === "warden" ? 30 : enemy.armored ? 18 : 11));
          state.combo = 0;
          state.lastEvent = `${enemyLabel(enemy.type)} BREACHED THE CIRCLE`;
          state.impactSequence += 1;
          addEffect(state, "impact", enemy.angle, 1.1, 1);
        }
      }
      state.enemies = state.enemies.filter((enemy) => enemy.hitPoints > 0 && (enemy.spawnAt > state.elapsed - 1 || enemy.radius > .5));
      state.effects = state.effects.filter((effect) => state.elapsed - effect.createdAt < 1.25);
      if (state.health <= 0) state.gameOver = true;
    },
  });
}

function extendWaves(state: SpellcasterState) {
  while (state.nextWaveAt < state.elapsed + 9) {
    const wave = state.director.next();
    state.wave = wave.id;
    state.nextWaveAt = wave.startsAt + wave.duration;
    state.enemies.push(...wave.spawns.map((spawn): ArcaneEnemy => ({ ...spawn, radius: 16.5, hitPoints: spawn.health, stunnedUntil: 0 })));
    if (wave.boss) state.lastEvent = "WARDEN SIGNATURE DETECTED";
    else if (wave.modifier !== "none") state.lastEvent = `${wave.modifier.toUpperCase()} WAVE FORMING`;
  }
}

function castSpell(state: SpellcasterState, spell: SpellId) {
  const cost = COST[spell];
  if (state.mana < cost) {
    state.lastEvent = `NOT ENOUGH MANA FOR ${spell.toUpperCase()}`;
    return;
  }
  state.mana -= cost;
  state.lastCast = spell;
  state.castSequence += 1;
  const target = selectTarget(state);
  const power = 1 + state.charge * .65;

  if (spell === "charge") {
    state.charge = Math.min(3, state.charge + 1);
    state.mana = Math.min(100, state.mana + 12);
    state.lastEvent = `ARCANE CHARGE ${state.charge}/3`;
    addEffect(state, spell, 0, 0, state.charge);
    return;
  }
  if (spell === "shield") {
    state.shieldUntil = Math.max(state.shieldUntil, state.elapsed + 3.2 + state.charge * .35);
    state.lastEvent = "OPEN PALM · SHIELD RAISED";
    addEffect(state, spell, 0, 1.25, power);
    state.charge = 0;
    return;
  }
  if (spell === "vortex") {
    const victims = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.radius < 15);
    victims.forEach((enemy) => damageEnemy(state, enemy, (enemy.weakness === spell ? 3 : 1.25) * power, spell));
    state.lastEvent = victims.length ? `CIRCLE · ${victims.length} TARGETS IN VORTEX` : "VORTEX FOUND NO TARGET";
    addEffect(state, spell, target?.angle ?? 0, target?.radius ?? 7, power);
    state.charge = 0;
    return;
  }
  if (!target) {
    state.lastEvent = `${spell.toUpperCase()} CAST INTO THE VOID`;
    addEffect(state, spell, state.aim.x * 1.2, 7, power);
    return;
  }
  if (spell === "grab") {
    target.stunnedUntil = state.elapsed + 2.4 * power;
    target.radius = Math.min(16, target.radius + .7);
    damageEnemy(state, target, target.weakness === spell ? 2 * power : .5 * power, spell);
  } else if (spell === "blade") {
    const victims = state.enemies.filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.radius < 10 && angularDistance(enemy.angle, target.angle) < .72);
    victims.forEach((enemy) => damageEnemy(state, enemy, (enemy.weakness === spell ? 4 : 1.8) * power, spell));
  } else {
    damageEnemy(state, target, (target.weakness === spell ? 4.5 : 2) * power, spell);
  }
  state.lastEvent = `${spell.toUpperCase()} · ${enemyLabel(target.type)} ${Math.max(0, Math.ceil(target.hitPoints))} HP`;
  addEffect(state, spell, target.angle, target.radius, power);
  state.charge = 0;
}

function damageEnemy(state: SpellcasterState, enemy: ArcaneEnemy, amount: number, spell: SpellId) {
  if (enemy.hitPoints <= 0) return;
  enemy.hitPoints -= amount;
  if (enemy.hitPoints > 0) return;
  state.combo += 1;
  state.score += Math.round((enemy.type === "warden" ? 1_500 : enemy.armored ? 280 : 120) * (1 + Math.min(20, state.combo) * .07));
  state.mana = Math.min(100, state.mana + (enemy.weakness === spell ? 9 : 4));
  state.impactSequence += 1;
  addEffect(state, "impact", enemy.angle, enemy.radius, enemy.type === "warden" ? 2 : 1);
}

function selectTarget(state: SpellcasterState) {
  const desired = state.aim.x * Math.PI * .62;
  return state.enemies
    .filter((enemy) => enemy.spawnAt <= state.elapsed && enemy.hitPoints > 0)
    .sort((a, b) => angularDistance(a.angle, desired) - angularDistance(b.angle, desired) || a.radius - b.radius)[0];
}

function readSpell(ctx: GameContext<SpellcasterState>, spell: SpellId) {
  const action = `spell.cast.${spell}`;
  return Boolean(ctx.input.action(action, "role-sorcerer") || ctx.input.action(action, "player-1"));
}

function readAim(ctx: GameContext<SpellcasterState>) {
  const role = ctx.input.vector("spell.aim", "role-sorcerer");
  if (Math.hypot(role.x, role.y) > .01) return { x: role.x, y: role.y };
  const semantic = ctx.input.vector("spell.aim", "player-1");
  if (Math.hypot(semantic.x, semantic.y) > .01) return { x: semantic.x, y: semantic.y };
  const fallback = ctx.input.vector("aim", "player-1");
  return { x: fallback.x, y: fallback.y };
}

function addEffect(state: SpellcasterState, spell: SpellEffect["spell"], angle: number, radius: number, strength: number) {
  state.effects.push({ id: ++state.effectId, spell, angle, radius, createdAt: state.elapsed, strength });
}

function enemyLabel(type: ArcaneEnemyType) {
  return type.toUpperCase();
}

function angularDistance(a: number, b: number) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

export default createSpellcasterGame();
