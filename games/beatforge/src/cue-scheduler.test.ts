import assert from "node:assert/strict";
import test from "node:test";
import { BeatCueLookahead, type BeatCueTimeline } from "./cue-scheduler.ts";

interface ScheduledCue {
  id: "beat" | "accent";
  at: number;
  volume: number;
}

test("queues chart cues on a stable audio clock while rendered game state is frozen", () => {
  const scheduled: ScheduledCue[] = [];
  const timeline: BeatCueTimeline = {
    currentTime: 20,
    schedule(id, at, options) {
      scheduled.push({ id, at, volume: options.volume });
    },
  };
  const state = {
    elapsed: 5,
    targets: [
      { groupId: 1, targetSeconds: 5.12, accent: false },
      // Chords share a group and produce one cue, not two louder overlapping oscillators.
      { groupId: 1, targetSeconds: 5.12, accent: false },
      { groupId: 2, targetSeconds: 5.27, accent: true },
    ],
  };
  const lookahead = new BeatCueLookahead(timeline, .15);

  lookahead.tick(state, true);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0]?.id, "beat");
  assert.ok(Math.abs(scheduled[0]!.at - 20.12) < 1e-9);

  // Simulate a late render: AudioContext.currentTime advances, while state.elapsed does not. The
  // second beat still enters the audio timeline at the chart's original wall-clock position.
  (timeline as { currentTime: number }).currentTime = 20.13;
  lookahead.tick(state, true);
  assert.equal(scheduled.length, 2);
  assert.deepEqual(scheduled[1]?.id, "accent");
  assert.ok(Math.abs(scheduled[1]!.at - 20.27) < 1e-9);
  assert.equal(scheduled[1]?.volume, .75);

  lookahead.tick(state, true);
  assert.equal(scheduled.length, 2, "a render or timer retry must not duplicate a group");
});

test("enabling audio mid-chart skips elapsed cues instead of replaying them late", () => {
  const scheduled: ScheduledCue[] = [];
  const timeline: BeatCueTimeline = {
    currentTime: 8,
    schedule(id, at, options) {
      scheduled.push({ id, at, volume: options.volume });
    },
  };
  const state = {
    elapsed: 3,
    targets: [
      { groupId: 7, targetSeconds: 2.4, accent: true },
      { groupId: 8, targetSeconds: 3.1, accent: false },
    ],
  };
  const lookahead = new BeatCueLookahead(timeline, .15);

  lookahead.tick(state, false);
  lookahead.tick(state, true);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.id, "beat");
  assert.ok(Math.abs(scheduled[0]!.at - 8.1) < 1e-9);
});
