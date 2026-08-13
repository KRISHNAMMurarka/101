import { difficultyAt, SeededRandom } from "@101/core";

export type SwarmEnemyType = "raider" | "tank" | "splitter" | "artillery" | "hive";
export type SwarmTerrainType = "slow-field" | "ion-storm" | "repair-zone";
export type SwarmModifier = "clear" | "crosswind" | "overclock" | "dark-grid" | "fracture";

export interface SwarmEnemySpawn {
  id: string; type: SwarmEnemyType; x: number; y: number; spawnAt: number; health: number; speed: number; damage: number;
}
export interface SwarmTerrain { id: string; type: SwarmTerrainType; x: number; y: number; radius: number }
export interface SwarmWave { id: number; startsAt: number; duration: number; modifier: SwarmModifier; enemies: SwarmEnemySpawn[]; terrain: SwarmTerrain[]; boss: boolean }

const MODIFIERS: readonly Exclude<SwarmModifier, "clear">[] = ["crosswind", "overclock", "dark-grid", "fracture"];
const TYPES: readonly SwarmEnemyType[] = ["raider", "tank", "splitter", "artillery"];
const TERRAIN: readonly SwarmTerrainType[] = ["slow-field", "ion-storm", "repair-zone"];

export class SwarmCommanderDirector {
  private readonly random: SeededRandom;
  private wave = 0;
  private cursor = 0;

  constructor(seed: string) { this.random = new SeededRandom(seed); }

  next(): SwarmWave {
    this.wave += 1;
    const difficulty = difficultyAt(this.wave * 3.2);
    const boss = this.wave % 8 === 0;
    const duration = Math.max(8.2, 12.5 - difficulty.tier * .18);
    const startsAt = this.cursor; this.cursor += duration;
    const count = boss ? 1 + Math.min(12, difficulty.simultaneousThreats) : Math.min(28, 5 + this.wave + difficulty.simultaneousThreats);
    const enemies = Array.from({ length: count }, (_, index): SwarmEnemySpawn => {
      const type: SwarmEnemyType = boss && index === 0 ? "hive" : this.random.pick(TYPES);
      const angle = this.random.range(-Math.PI, Math.PI); const radius = this.random.range(9.2, 12.5);
      const scale = type === "hive" ? 7 : type === "tank" ? 2.5 : type === "artillery" ? 1.6 : 1;
      return {
        id: `w${this.wave}-e${index}`, type, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
        spawnAt: startsAt + .6 + index * Math.max(.12, .42 - difficulty.tier * .015),
        health: Math.round((8 + difficulty.tier * 1.7) * scale),
        speed: Math.min(3.2, (.72 + difficulty.speed * .36) * (type === "tank" ? .62 : type === "hive" ? .45 : 1)),
        damage: Math.min(12, 1.3 + difficulty.tier * .28 + (type === "tank" ? 1.8 : type === "hive" ? 3.5 : 0)),
      };
    });
    const terrainCount = Math.min(4, 1 + Math.floor(this.wave / 5));
    const terrain = Array.from({ length: terrainCount }, (_, index): SwarmTerrain => ({
      id: `w${this.wave}-t${index}`, type: this.random.pick(TERRAIN), x: this.random.range(-6.5, 6.5), y: this.random.range(-4.4, 4.4), radius: this.random.range(1.1, 2.1),
    }));
    const modifier = this.wave > 2 && this.random.next() < Math.min(.62, difficulty.modifierChance + .14) ? this.random.pick(MODIFIERS) : "clear";
    return { id: this.wave, startsAt, duration, modifier, enemies, terrain, boss };
  }
}

export function validateSwarmWave(wave: SwarmWave) {
  return wave.id > 0 && wave.duration >= 8 && wave.enemies.length > 0 && wave.enemies.length <= 28
    && wave.enemies.every((enemy) => Number.isFinite(enemy.x) && Number.isFinite(enemy.y) && enemy.health > 0 && enemy.speed > 0 && enemy.speed <= 3.2 && enemy.spawnAt >= wave.startsAt)
    && wave.terrain.every((terrain) => terrain.radius >= 1 && terrain.radius <= 2.2)
    && (!wave.boss || wave.enemies.some((enemy) => enemy.type === "hive"));
}
