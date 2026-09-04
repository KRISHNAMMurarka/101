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
 * Schedules chart cues on the Web Audio clock, re-deriving the chart-to-audio mapping on every tick.
 *
 * The mapping used to be pinned once, at the first enabled tick, and every later cue was placed at
 * `audioOrigin + targetSeconds - gameOrigin`. That is only sound if the chart clock and the audio
 * clock advance together, and they do not: `Engine101` advances `state.elapsed` by
 * `Math.min(deltaSeconds, 0.1)`, so any frame longer than 100 ms — a tab restored from the
 * background, a GC pause, a lazy chunk landing — silently drops real time from the chart clock while
 * the audio clock keeps all of it. With a pinned origin that loss is permanent: every remaining beat
 * sounds early by the accumulated gap, for the rest of the run.
 *
 * Anchoring to the present instead — "this cue is N seconds ahead in chart time, so play it N
 * seconds ahead in audio time" — absorbs each stall as it happens. A cue is still placed once, and
 * Web Audio still owns its precise start, so the lookahead behaviour is unchanged; what changes is
 * that error can no longer accumulate. It also fixes a second symptom of the same cause: while a tab
 * is hidden the chart clock is frozen, so cues no longer race past an advancing absolute deadline
 * and get marked as sounded without ever being heard.
 */
export class BeatCueLookahead {
  private readonly scheduledGroups = new Set<number>();
  private readonly timeline: BeatCueTimeline;
  private readonly lookaheadSeconds: number;

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

    const now = this.timeline.currentTime;
    const horizon = now + this.lookaheadSeconds;
    const upcoming = [...groups.values()].sort((a, b) => a.targetSeconds - b.targetSeconds);
    for (const target of upcoming) {
      if (this.scheduledGroups.has(target.groupId)) continue;
      // Measured from the present on every tick, so a stalled frame shifts this cue and every cue
      // after it by the same amount rather than leaving them all early forever.
      const secondsAhead = target.targetSeconds - state.elapsed;
      const at = now + secondsAhead;
      if (secondsAhead < 0) {
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
