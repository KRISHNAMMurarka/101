export const BEAT_CUE_LOOKAHEAD_SECONDS = .15;

export interface BeatCueTarget {
  groupId: number;
  targetSeconds: number;
  accent: boolean;
}

export interface BeatCueState {
  elapsed: number;
  targets: readonly BeatCueTarget[];
}

export interface BeatCueTimeline {
  readonly currentTime: number;
  schedule(id: "beat" | "accent", at: number, options: { volume: number }): unknown;
}

/**
 * Maps the chart clock to the Web Audio clock once, then keeps that mapping stable while rendered
 * frames arrive early, late, or not at all. A short timer calls `tick`; Web Audio owns the precise
 * future start after each cue enters the lookahead window.
 */
export class BeatCueLookahead {
  private readonly scheduledGroups = new Set<number>();
  private readonly timeline: BeatCueTimeline;
  private readonly lookaheadSeconds: number;
  private audioOrigin?: number;
  private gameOrigin?: number;

  constructor(timeline: BeatCueTimeline, lookaheadSeconds = BEAT_CUE_LOOKAHEAD_SECONDS) {
    if (!(lookaheadSeconds > 0)) throw new Error("Beat cue lookahead must be positive");
    this.timeline = timeline;
    this.lookaheadSeconds = lookaheadSeconds;
  }

  tick(state: BeatCueState, enabled: boolean) {
    const groups = new Map<number, BeatCueTarget>();
    for (const target of state.targets) {
      const current = groups.get(target.groupId);
      if (!current || target.targetSeconds < current.targetSeconds) groups.set(target.groupId, target);
    }

    // Targets leave the chart shortly after judgment, so retaining only live group ids keeps an
    // endless session's bookkeeping bounded without allowing any live chord to double-trigger.
    for (const groupId of this.scheduledGroups) {
      if (!groups.has(groupId)) this.scheduledGroups.delete(groupId);
    }

    if (!enabled) {
      // Enabling audio mid-song must not dump every beat that already passed into the speakers.
      for (const target of groups.values()) {
        if (target.targetSeconds <= state.elapsed) this.scheduledGroups.add(target.groupId);
      }
      return;
    }

    if (this.audioOrigin === undefined || this.gameOrigin === undefined) {
      this.audioOrigin = this.timeline.currentTime;
      this.gameOrigin = state.elapsed;
    }

    const now = this.timeline.currentTime;
    const horizon = now + this.lookaheadSeconds;
    const upcoming = [...groups.values()].sort((a, b) => a.targetSeconds - b.targetSeconds);
    for (const target of upcoming) {
      if (this.scheduledGroups.has(target.groupId)) continue;
      const at = this.audioOrigin + target.targetSeconds - this.gameOrigin;
      if (at < now) {
        this.scheduledGroups.add(target.groupId);
        continue;
      }
      if (at > horizon) break;
      this.timeline.schedule(target.accent ? "accent" : "beat", at, {
        volume: target.accent ? .75 : .42,
      });
      this.scheduledGroups.add(target.groupId);
    }
  }
}
