import { difficultyAt, SeededRandom } from "@101/core";

export type ShadowEnemyType = "striker" | "brute" | "shade" | "sentinel";
export type ShadowAttack = "high" | "low" | "heavy";
export type ArenaModifier = "clear" | "blackout" | "low-gravity" | "mirror" | "fury";

export interface ShadowSpawn {
  id: string;
  type: ShadowEnemyType;
  side: -1 | 1;
  spawnAt: number;
  speed: number;
  health: number;
  attack: ShadowAttack;
  windup: number;
}

export interface ShadowRound {
  id: number;
  startsAt: number;
  duration: number;
  modifier: ArenaModifier;
  boss: boolean;
  spawns: ShadowSpawn[];
}

const TYPES: readonly ShadowEnemyType[] = ["striker", "brute", "shade"];
const ATTACKS: Record<ShadowEnemyType, readonly ShadowAttack[]> = {
  striker: ["high", "low"], brute: ["heavy", "high"], shade: ["low", "high"], sentinel: ["heavy", "low", "high"],
};

export class ShadowArenaDirector {
  private readonly random: SeededRandom;
  private round = 0;
  private nextStart = 1.8;

  constructor(seed: string) { this.random = new SeededRandom(seed); }

  next(): ShadowRound {
    this.round += 1;
    const difficulty = difficultyAt(this.round * 3.8);
    const boss = this.round % 7 === 0;
    const count = boss ? 1 + Math.min(3, difficulty.tier) : Math.min(10, 2 + difficulty.simultaneousThreats + Math.floor(difficulty.density * 4));
    const interval = Math.max(.72, 1.45 - difficulty.tier * .06);
    const startsAt = this.nextStart;
    const modifier = difficulty.tier > 0 && this.random.next() < Math.min(.52, difficulty.modifierChance + .12)
      ? this.random.pick(["blackout", "low-gravity", "mirror", "fury"] as const)
      : "clear";
    const spawns = Array.from({ length: count }, (_, index): ShadowSpawn => {
      const type = boss && index === 0 ? "sentinel" : this.random.pick(TYPES);
      const fury = modifier === "fury" ? 1.14 : 1;
      return {
        id: `round-${this.round}-fighter-${index + 1}`,
        type,
        side: this.random.next() < .5 ? -1 : 1,
        spawnAt: startsAt + index * interval,
        speed: Math.min(3, (.78 + difficulty.speed * .18 + this.random.range(-.08, .1)) * fury),
        health: type === "sentinel" ? 14 + difficulty.tier * 2 : type === "brute" ? 5 + Math.floor(difficulty.tier / 2) : type === "shade" ? 2 : 3,
        attack: this.random.pick(ATTACKS[type]),
        windup: Math.max(.52, 1.12 - difficulty.tier * .035 + this.random.range(-.1, .14)),
      };
    });
    const duration = Math.max(4.8, count * interval + 3);
    this.nextStart = startsAt + duration;
    return { id: this.round, startsAt, duration, modifier, boss, spawns };
  }
}

export function validateShadowRound(round: ShadowRound, previous?: ShadowRound) {
  return round.id > 0
    && round.startsAt >= (previous ? previous.startsAt + previous.duration - .001 : 0)
    && round.duration >= 4.8
    && round.spawns.length >= 1
    && round.spawns.length <= 10
    && round.spawns.every((spawn) => spawn.spawnAt >= round.startsAt && spawn.spawnAt <= round.startsAt + round.duration
      && spawn.speed > 0 && spawn.speed <= 3 && spawn.health > 0 && spawn.windup >= .5 && ATTACKS[spawn.type].includes(spawn.attack));
}
