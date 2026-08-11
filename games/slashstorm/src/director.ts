import { difficultyAt, SeededRandom } from "@101/core";

export type SlashTargetKind = "crystal" | "core" | "armored" | "bomb" | "bonus";

export interface SlashTarget {
  id: number;
  kind: SlashTargetKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  health: number;
  rotation: number;
  spin: number;
}

export class SlashstormDirector {
  private readonly random: SeededRandom;
  private elapsed = 0;
  private nextAt = 0.35;
  private id = 0;

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  update(delta: number, distance: number, spawn: (target: SlashTarget) => void) {
    this.elapsed += delta;
    const difficulty = difficultyAt(distance);
    if (this.elapsed < this.nextAt) return;

    const groupSize = this.random.next() < difficulty.density * 0.45
      ? Math.min(3, 1 + Math.floor(this.random.range(1, difficulty.simultaneousThreats + 1)))
      : 1;
    for (let index = 0; index < groupSize; index += 1) {
      spawn(this.createTarget(distance, index, groupSize));
    }
    const baseGap = Math.max(0.28, 0.92 - difficulty.density * 0.5);
    this.nextAt = this.elapsed + this.random.range(baseGap * 0.72, baseGap * 1.18);
  }

  private createTarget(distance: number, index: number, groupSize: number): SlashTarget {
    const difficulty = difficultyAt(distance);
    const roll = this.random.next();
    const kind: SlashTargetKind = roll < 0.08 + difficulty.modifierChance * 0.08
      ? "bomb"
      : roll < 0.18
        ? "armored"
        : roll < 0.26
          ? "bonus"
          : roll < 0.58
            ? "core"
            : "crystal";
    const lane = groupSize === 1 ? this.random.range(-0.78, 0.78) : -0.62 + (1.24 * index) / Math.max(1, groupSize - 1);
    return {
      id: ++this.id,
      kind,
      x: lane + this.random.range(-0.08, 0.08),
      y: 1.18 + this.random.range(0, 0.12),
      vx: this.random.range(-0.18, 0.18),
      vy: -this.random.range(1.36, 1.72) * difficulty.speed,
      radius: kind === "bonus" ? 0.055 : kind === "bomb" ? 0.085 : 0.075,
      health: kind === "armored" ? 2 : 1,
      rotation: this.random.range(0, Math.PI * 2),
      spin: this.random.range(-2.8, 2.8),
    };
  }
}
