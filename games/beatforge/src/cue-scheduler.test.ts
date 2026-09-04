import assert from "node:assert/strict";
import test from "node:test";
import { BeatCueLookahead, type BeatCueTimeline } from "./cue-scheduler.ts";

interface ScheduledCue {
  id: "beat" | "accent";
  at: number;
  volume: number;
}

test("a cue is placed the same distance ahead in audio time as it sits ahead in chart time", () => {
  const scheduled: ScheduledCue[] = [];
  const timeline: BeatCueTimeline = {
    currentTime: 20,
    schedule(id, at, options) { scheduled.push({ id, at, volume: options.volume }); },
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
  assert.equal(scheduled.length, 1, "only the cue inside the lookahead window is placed");
  assert.equal(scheduled[0]?.id, "beat");
  assert.ok(Math.abs(scheduled[0]!.at - 20.12) < 1e-9, "0.12s ahead in the chart is 0.12s ahead in audio");

  // The chart clock advances and the second beat comes into range.
  (timeline as { currentTime: number }).currentTime = 20.13;
  lookahead.tick({ ...state, elapsed: 5.13 }, true);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1]?.id, "accent");
  assert.ok(Math.abs(scheduled[1]!.at - 20.27) < 1e-9);
  assert.equal(scheduled[1]?.volume, .75);

  lookahead.tick({ ...state, elapsed: 5.13 }, true);
  assert.equal(scheduled.length, 2, "a render or timer retry must not duplicate a group");
});

test("a frozen chart clock holds cues rather than sounding or silently discarding them", () => {
  // While a tab is hidden the render loop stops, so `state.elapsed` freezes while the audio clock
  // keeps running. Cues must simply wait: sounding them would play beats the player cannot see, and
  // marking them elapsed would drop them from the run entirely. The earlier design placed cues at an
  // absolute audio deadline, so a hidden tab did both — some beats were marked sounded without ever
  // being heard, and the rest arrived early.
  const scheduled: ScheduledCue[] = [];
  const timeline: BeatCueTimeline = {
    currentTime: 10,
    schedule(id, at, options) { scheduled.push({ id, at, volume: options.volume }); },
  };
  const state = { elapsed: 3, targets: [{ groupId: 7, targetSeconds: 3.05, accent: false }] };
  const lookahead = new BeatCueLookahead(timeline, .15);

  // Five seconds pass with the chart frozen.
  for (const t of [10, 11, 12, 13, 14, 15]) {
    (timeline as { currentTime: number }).currentTime = t;
    lookahead.tick(state, true);
  }
  assert.equal(scheduled.length, 1, "the cue is placed once against the clock it was placed on");
  assert.ok(Math.abs(scheduled[0]!.at - 10.05) < 1e-9);

  // And it is never re-placed or discarded as the clock keeps moving.
  (timeline as { currentTime: number }).currentTime = 30;
  lookahead.tick(state, true);
  assert.equal(scheduled.length, 1);
});

test("a clamped long frame cannot leave every later cue permanently early", () => {
  // Engine101 advances the chart with `Math.min(deltaSeconds, 0.1)`, so a frame longer than 100 ms
  // drops real time from `state.elapsed` that the audio clock still counts. Pinning the chart-to-
  // audio mapping once made that loss permanent: every remaining beat sounded early by the gap, for
  // the rest of the run.
  //
  // The stall has to happen *after* the mapping is first established, or the origin simply absorbs
  // it and a pinned implementation looks correct — which is exactly how an earlier version of this
  // test passed against the bug it was written to catch.
  const scheduled: ScheduledCue[] = [];
  const timeline: BeatCueTimeline = {
    currentTime: 0,
    schedule(id, at, options) { scheduled.push({ id, at, volume: options.volume }); },
  };
  const lookahead = new BeatCueLookahead(timeline, .15);
  const targets = [
    { groupId: 1, targetSeconds: .05, accent: false },
    { groupId: 2, targetSeconds: 6, accent: false },
  ];

  // A normal first tick establishes the mapping, and places the near cue.
  lookahead.tick({ elapsed: 0, targets }, true);
  assert.equal(scheduled.length, 1);

  // Now a two-second stall: the audio clock counts all of it, the clamped chart clock counts 0.1s.
  let audio = 2;
  let elapsed = .1;
  (timeline as { currentTime: number }).currentTime = audio;
  lookahead.tick({ elapsed, targets }, true);

  // Walk both clocks forward together until the far cue enters the window.
  while (scheduled.length < 2 && elapsed < 30) {
    audio += .05;
    elapsed += .05;
    (timeline as { currentTime: number }).currentTime = audio;
    lookahead.tick({ elapsed, targets }, true);
  }
  assert.equal(scheduled.length, 2, "the later cue must still be scheduled");

  // The invariant: a cue is placed exactly as far ahead in audio time as it is ahead in chart time.
  // A pinned mapping places this one 1.9s early — the time the clamp swallowed.
  const late = scheduled.at(-1)!;
  assert.ok(Math.abs((late.at - audio) - (6 - elapsed)) < 1e-9,
    `cue placed ${(late.at - audio).toFixed(3)}s ahead for a beat ${(6 - elapsed).toFixed(3)}s away`);
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
