import assert from "node:assert/strict";
import test from "node:test";

/**
 * The sample-rate readout is a diagnostic people calibrate against, so it must never state a
 * number it cannot support. These tests exercise the rate logic directly rather than through
 * expo-sensors, which needs a native runtime.
 */
class SampleRateTracker {
  lastTimestamp?: number;
  smoothedIntervalMs?: number;
  sampleRate = 0;

  track(timestamp: number) {
    const previous = this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (previous === undefined) return;
    const delta = timestamp - previous;
    if (!(delta > 0) || delta > 1_000) return;
    this.smoothedIntervalMs = this.smoothedIntervalMs === undefined
      ? delta
      : this.smoothedIntervalMs + (delta - this.smoothedIntervalMs) * 0.2;
    this.sampleRate = Math.min(1_000, 1_000 / this.smoothedIntervalMs);
  }
}

test("a repeated sensor timestamp never invents an impossible sample rate", () => {
  const tracker = new SampleRateTracker();
  // A 1 ms floor used to turn duplicate timestamps into a reported 1,000,000 Hz.
  tracker.track(1_000);
  tracker.track(1_000);
  tracker.track(1_000);
  assert.equal(tracker.sampleRate, 0, "with no advancing clock the rate stays unknown, not absurd");

  tracker.track(1_020);
  assert.equal(Math.round(tracker.sampleRate), 50, "a real 20 ms gap reports 50 Hz");

  tracker.track(1_020);
  assert.equal(Math.round(tracker.sampleRate), 50, "a duplicate afterwards keeps the last good value");
});

test("the reported rate stays inside what a sensor can physically deliver", () => {
  const tracker = new SampleRateTracker();
  tracker.track(0);
  // A clock that jumps backwards or barely moves must not produce a headline figure.
  tracker.track(-50);
  assert.equal(tracker.sampleRate, 0);

  const fast = new SampleRateTracker();
  fast.track(0);
  for (let index = 1; index <= 40; index += 1) fast.track(index * 0.0001);
  assert.ok(fast.sampleRate <= 1_000, `capped at 1000 Hz, got ${fast.sampleRate}`);
});

test("a long stall is ignored rather than reported as a rate", () => {
  const tracker = new SampleRateTracker();
  tracker.track(0);
  tracker.track(16);
  const settled = tracker.sampleRate;
  assert.ok(settled > 0);

  // The app was backgrounded for five seconds; that is a gap, not a 0.2 Hz sample rate.
  tracker.track(5_016);
  assert.equal(tracker.sampleRate, settled, "the stall leaves the previous rate untouched");
});

test("the rate smooths instead of chasing every jittery callback", () => {
  const tracker = new SampleRateTracker();
  tracker.track(0);
  for (let index = 1; index <= 30; index += 1) tracker.track(index * 16);
  const steady = tracker.sampleRate;
  assert.ok(Math.abs(steady - 62.5) < 1, `~62.5 Hz for a 16 ms cadence, got ${steady}`);

  // One late 40 ms frame is instantaneously 25 Hz. The reading should move toward that without
  // snapping to it, so it stays far nearer the steady cadence than the outlier.
  tracker.track(30 * 16 + 40);
  const afterOutlier = tracker.sampleRate;
  assert.ok(afterOutlier < steady, "a genuine slowdown is still reflected");
  assert.ok(
    Math.abs(afterOutlier - steady) < Math.abs(afterOutlier - 25),
    `should stay closer to ${steady.toFixed(1)} Hz than to the 25 Hz outlier, got ${afterOutlier.toFixed(1)}`,
  );
});
