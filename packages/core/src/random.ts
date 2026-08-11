export class SeededRandom {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  }

  next() {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number) {
    return min + (max - min) * this.next();
  }

  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new Error("Cannot pick from an empty list");
    return values[Math.floor(this.next() * values.length)]!;
  }
}

export interface DifficultyProfile {
  tier: number;
  density: number;
  speed: number;
  reactionTime: number;
  simultaneousThreats: number;
  modifierChance: number;
}

export function difficultyAt(distance: number): DifficultyProfile {
  const tier = Math.max(0, Math.floor(distance / 10));
  return {
    tier,
    density: Math.min(1, 0.2 + tier * 0.035),
    speed: Math.min(2.4, 1 + tier * 0.04),
    reactionTime: Math.max(0.35, 1.4 - tier * 0.025),
    simultaneousThreats: Math.min(8, 1 + Math.floor(tier / 3)),
    modifierChance: Math.min(0.65, tier * 0.025),
  };
}

function hashSeed(seed: string) {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
