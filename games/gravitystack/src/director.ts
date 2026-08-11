import { difficultyAt, SeededRandom } from "@101/core";

export type StackShapeKind = "block" | "tall" | "wide" | "beam" | "orb";
export type StackMaterial = "steady" | "heavy" | "bouncy" | "slippery";

export interface StackShapeSpec {
  id: number;
  kind: StackShapeKind;
  material: StackMaterial;
  width: number;
  height: number;
  radius?: number;
  density: number;
  friction: number;
  restitution: number;
  rotation: number;
  color: string;
}

const COLORS = ["#9e8cff", "#50e3ff", "#f8d96a", "#ff73c9", "#b5ff66"] as const;

export class GravityStackDirector {
  private readonly random: SeededRandom;
  private shapeId = 0;

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(): StackShapeSpec {
    const difficulty = difficultyAt(this.shapeId / 5);
    const kinds: StackShapeKind[] = difficulty.tier < 1 ? ["block", "wide", "tall"] : ["block", "wide", "tall", "beam", "orb"];
    const kind = this.random.pick(kinds);
    const materialRoll = this.random.next();
    const material: StackMaterial = difficulty.tier < 1 || materialRoll > difficulty.modifierChance
      ? "steady"
      : materialRoll < difficulty.modifierChance * .3
        ? "heavy"
        : materialRoll < difficulty.modifierChance * .62
          ? "bouncy"
          : "slippery";
    const dimensions = kind === "orb"
      ? { width: 1.15, height: 1.15, radius: .575 }
      : kind === "wide"
        ? { width: this.random.range(2.1, 3.15), height: this.random.range(.58, .9) }
        : kind === "tall"
          ? { width: this.random.range(.62, .9), height: this.random.range(1.8, 2.75) }
          : kind === "beam"
            ? { width: this.random.range(3.2, 4.1), height: this.random.range(.36, .55) }
            : { width: this.random.range(.9, 1.55), height: this.random.range(.9, 1.55) };
    this.shapeId += 1;
    return {
      id: this.shapeId,
      kind,
      material,
      ...dimensions,
      density: material === "heavy" ? 2.4 : .9,
      friction: material === "slippery" ? .08 : .82,
      restitution: material === "bouncy" ? .62 : .05,
      rotation: this.random.range(-.22, .22),
      color: this.random.pick(COLORS),
    };
  }
}

export function validateStackShape(shape: StackShapeSpec) {
  return shape.width >= .3
    && shape.width <= 4.2
    && shape.height >= .3
    && shape.height <= 2.8
    && shape.density > 0
    && shape.friction >= 0
    && shape.restitution >= 0
    && shape.restitution <= 1
    && (shape.kind !== "orb" || Boolean(shape.radius && shape.radius > 0));
}
