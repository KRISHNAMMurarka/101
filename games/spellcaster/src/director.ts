import { difficultyAt, SeededRandom } from "@101/core";

export type SpellId = "shield" | "grab" | "vortex" | "projectile" | "charge" | "blade";
export type ArcaneEnemyType = "wisp" | "golem" | "specter" | "swarm" | "warden";

export interface ArcaneSpawn {
  id: string;
  type: ArcaneEnemyType;
  weakness: SpellId;
  spawnAt: number;
  angle: number;
  speed: number;
  health: number;
  armored: boolean;
}

export interface ArcaneWave {
  id: number;
  startsAt: number;
  duration: number;
  modifier: "none" | "haste" | "mirrored" | "mana-storm";
  spawns: ArcaneSpawn[];
  boss: boolean;
}

const TYPES: readonly ArcaneEnemyType[] = ["wisp", "golem", "specter", "swarm"];
const WEAKNESS: Record<ArcaneEnemyType, readonly SpellId[]> = {
  wisp: ["projectile", "vortex"],
  golem: ["charge", "blade"],
  specter: ["shield", "grab"],
  swarm: ["vortex", "blade"],
  warden: ["projectile", "charge", "vortex"],
};

export class SpellcasterDirector {
  private readonly random: SeededRandom;
  private waveId = 0;
  private nextStart = 1.8;

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(): ArcaneWave {
    this.waveId += 1;
    const difficulty = difficultyAt(this.waveId * 3.4);
    const boss = this.waveId % 8 === 0;
    const count = boss ? 1 + Math.min(4, difficulty.tier) : Math.min(10, 3 + difficulty.simultaneousThreats + Math.floor(difficulty.density * 3));
    const interval = Math.max(.48, 1.05 - difficulty.tier * .045);
    const modifier = difficulty.tier > 0 && this.random.next() < Math.min(.46, difficulty.modifierChance + .1)
      ? this.random.pick(["haste", "mirrored", "mana-storm"] as const)
      : "none";
    const startsAt = this.nextStart;
    const spawns = Array.from({ length: count }, (_, index): ArcaneSpawn => {
      const type = boss && index === 0 ? "warden" : this.random.pick(TYPES);
      const speedScale = modifier === "haste" ? 1.18 : 1;
      return {
        id: `wave-${this.waveId}-enemy-${index + 1}`,
        type,
        weakness: this.random.pick(WEAKNESS[type]),
        spawnAt: startsAt + index * interval,
        angle: normalizeAngle(this.random.range(-Math.PI * .78, Math.PI * .78) * (modifier === "mirrored" ? -1 : 1)),
        speed: Math.min(2.35, (.48 + difficulty.speed * .17 + this.random.range(-.06, .09)) * speedScale),
        health: type === "warden" ? 12 + difficulty.tier * 2 : type === "golem" ? 4 + Math.floor(difficulty.tier / 2) : type === "swarm" ? 1 : 2 + Math.floor(difficulty.tier / 3),
        armored: type === "golem" || type === "warden",
      };
    });
    const duration = Math.max(4.2, count * interval + 2.6);
    this.nextStart = startsAt + duration;
    return { id: this.waveId, startsAt, duration, modifier, spawns, boss };
  }
}

export function validateArcaneWave(wave: ArcaneWave, previous?: ArcaneWave) {
  return wave.id > 0
    && wave.startsAt >= (previous ? previous.startsAt + previous.duration - .001 : 0)
    && wave.duration >= 4
    && wave.spawns.length >= 1
    && wave.spawns.length <= 10
    && wave.spawns.every((spawn) => spawn.spawnAt >= wave.startsAt
      && spawn.spawnAt <= wave.startsAt + wave.duration
      && spawn.speed > 0
      && spawn.speed <= 2.35
      && spawn.health > 0
      && WEAKNESS[spawn.type].includes(spawn.weakness));
}

function normalizeAngle(value: number) {
  return Math.max(-Math.PI * .8, Math.min(Math.PI * .8, value));
}
