import { difficultyAt, SeededRandom } from "@101/core";
import { generateMaze, validateMaze, type MazeFloor } from "@101/maze";

export type EchoModifier = "still" | "black-glass" | "pulse-fog" | "false-compass";
export type EchoTheme = "archive" | "cistern" | "observatory" | "deep-vault";

export interface EchoFloor extends MazeFloor {
  theme: EchoTheme;
  modifier: EchoModifier;
  visibility: number;
  echoPressure: number;
}

const THEMES: readonly EchoTheme[] = ["archive", "cistern", "observatory", "deep-vault"];
const MODIFIERS: readonly Exclude<EchoModifier, "still">[] = ["black-glass", "pulse-fog", "false-compass"];

export class EchoMazeDirector {
  private readonly random: SeededRandom;
  private readonly seed: string;
  private level = 0;

  constructor(seed: string) {
    this.seed = seed;
    this.random = new SeededRandom(seed);
  }

  next(): EchoFloor {
    this.level += 1;
    const maze = generateMaze(this.seed, this.level);
    const difficulty = difficultyAt(this.level * 4);
    const modifier = difficulty.tier > 0 && this.random.next() < Math.min(.58, difficulty.modifierChance + .16) ? this.random.pick(MODIFIERS) : "still";
    return {
      ...maze,
      theme: THEMES[(this.level - 1) % THEMES.length]!,
      modifier,
      visibility: Math.max(.34, .68 - difficulty.tier * .035 - (modifier === "black-glass" ? .12 : 0)),
      echoPressure: Math.min(1, .12 + difficulty.density * .55 + (modifier === "pulse-fog" ? .14 : 0)),
    };
  }
}

export function validateEchoFloor(floor: EchoFloor) {
  return validateMaze(floor)
    && floor.fragments.length >= 2
    && floor.visibility >= .3
    && floor.visibility <= .7
    && floor.echoPressure >= 0
    && floor.echoPressure <= 1;
}
