import { difficultyAt, SeededRandom } from "@101/core";

export type DodgeRequirement = "center" | "left" | "right" | "duck" | "jump" | "arms" | "lean-left" | "lean-right";
export type GateModifier = "steady" | "moving" | "pulse" | "narrow";

export interface DodgeGate {
  id: number;
  distance: number;
  requirement: DodgeRequirement;
  modifier: GateModifier;
  speed: number;
  reactionSeconds: number;
  passed: boolean;
  resolved: boolean;
  phase: number;
}

const BASE_REQUIREMENTS: readonly DodgeRequirement[] = ["center", "left", "right", "duck", "jump"];
const ADVANCED_REQUIREMENTS: readonly DodgeRequirement[] = ["arms", "lean-left", "lean-right"];

export class BodyDodgeDirector {
  private readonly random: SeededRandom;
  private id = 0;
  private previousRequirement: DodgeRequirement = "center";

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(afterDistance: number): DodgeGate {
    const difficulty = difficultyAt(afterDistance / 55);
    const speed = Math.min(23, 10.5 * difficulty.speed);
    const minimumReaction = Math.max(0.82, difficulty.reactionTime);
    const reactionSeconds = this.random.range(minimumReaction, minimumReaction + 0.65);
    const choices = difficulty.tier >= 2 ? [...BASE_REQUIREMENTS, ...ADVANCED_REQUIREMENTS] : [...BASE_REQUIREMENTS];
    let requirement = this.random.pick(choices);
    if (opposites(requirement, this.previousRequirement) && reactionSeconds < 1.05) requirement = "center";
    const modifierRoll = this.random.next();
    const modifier: GateModifier = difficulty.tier < 2 || modifierRoll > difficulty.modifierChance
      ? "steady"
      : modifierRoll < difficulty.modifierChance * .28
        ? "moving"
        : modifierRoll < difficulty.modifierChance * .58
          ? "pulse"
          : "narrow";
    const gate: DodgeGate = {
      id: ++this.id,
      distance: afterDistance + Math.max(17, speed * reactionSeconds),
      requirement,
      modifier,
      speed,
      reactionSeconds,
      passed: false,
      resolved: false,
      phase: this.random.range(0, Math.PI * 2),
    };
    this.previousRequirement = requirement;
    return gate;
  }
}

export function validateGate(gate: DodgeGate, previousDistance: number) {
  const gap = gate.distance - previousDistance;
  return gate.distance > previousDistance
    && gate.speed >= 8
    && gate.speed <= 23
    && gate.reactionSeconds >= 0.82
    && gap / gate.speed >= 0.8;
}

function opposites(a: DodgeRequirement, b: DodgeRequirement) {
  return (a === "left" && b === "right") || (a === "right" && b === "left")
    || (a === "lean-left" && b === "lean-right") || (a === "lean-right" && b === "lean-left")
    || (a === "duck" && b === "jump") || (a === "jump" && b === "duck");
}
