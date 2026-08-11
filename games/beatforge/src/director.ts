import { difficultyAt, SeededRandom } from "@101/core";
import { beatDurationSeconds } from "@101/rhythm";

export type BeatAction = "left" | "right" | "punch" | "raise" | "duck";

export interface BeatGroup {
  id: number;
  beat: number;
  targetSeconds: number;
  bpm: number;
  actions: readonly BeatAction[];
  accent: boolean;
}

const BASE_ACTIONS: readonly BeatAction[] = ["left", "right", "punch"];
const ADVANCED_ACTIONS: readonly BeatAction[] = ["raise", "duck"];

export class BeatForgeDirector {
  private readonly random: SeededRandom;
  private groupId = 0;
  private nextBeat = 4;
  private nextTime = 2.4;
  private previousAction: BeatAction = "left";

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(): BeatGroup {
    // Rhythm difficulty advances by generated phrase count so half-beat density
    // does not accidentally slow its own progression.
    const difficulty = difficultyAt(this.groupId / 3);
    const bpm = Math.min(158, 112 + difficulty.tier * 3);
    if (this.groupId > 0) {
      const halfBeat = difficulty.tier >= 2 && this.random.next() < Math.min(.55, difficulty.density);
      const interval = halfBeat ? .5 : 1;
      this.nextBeat += interval;
      this.nextTime += interval * beatDurationSeconds(bpm);
    }
    const choices = difficulty.tier >= 1 ? [...BASE_ACTIONS, ...ADVANCED_ACTIONS] : [...BASE_ACTIONS];
    let first = this.random.pick(choices);
    if (first === this.previousAction && this.random.next() < .58) first = this.random.pick(choices.filter((action) => action !== first));
    const actions: BeatAction[] = [first];
    const chordChance = difficulty.tier >= 3 ? Math.min(.28, difficulty.density * .34) : 0;
    if (this.random.next() < chordChance) {
      const compatible = choices.filter((action) => action !== first && !opposites(action, first));
      if (compatible.length) actions.push(this.random.pick(compatible));
    }
    this.previousAction = first;
    this.groupId += 1;
    return {
      id: this.groupId,
      beat: this.nextBeat,
      targetSeconds: this.nextTime,
      bpm,
      actions,
      accent: Math.abs(this.nextBeat % 4) < .001,
    };
  }
}

export function validateBeatGroup(group: BeatGroup, previous?: BeatGroup) {
  return group.targetSeconds > (previous?.targetSeconds ?? 0)
    && group.bpm >= 112
    && group.bpm <= 158
    && group.actions.length >= 1
    && group.actions.length <= 2
    && new Set(group.actions).size === group.actions.length
    && (!previous || group.targetSeconds - previous.targetSeconds >= .18);
}

function opposites(a: BeatAction, b: BeatAction) {
  return (a === "left" && b === "right") || (a === "right" && b === "left") || (a === "raise" && b === "duck") || (a === "duck" && b === "raise");
}
