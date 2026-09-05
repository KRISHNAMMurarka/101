import assert from "node:assert/strict";
import test from "node:test";

import type { SpeakerCueMessage } from "@101/protocol";
import {
  ControllerSpeaker,
  type ControllerSpeakerPlayer,
} from "./controller-speaker.ts";

class FakePlayer implements ControllerSpeakerPlayer {
  volume = 1;
  playbackRate = 1;
  shouldCorrectPitch = true;
  readonly seeks: number[] = [];
  plays = 0;

  async seekTo(position: number) {
    this.seeks.push(position);
  }

  play() {
    this.plays += 1;
  }
}

class DeferredPlayer extends FakePlayer {
  readonly pending: Array<() => void> = [];

  override seekTo(position: number) {
    this.seeks.push(position);
    return new Promise<void>((resolve) => this.pending.push(resolve));
  }
}

/**
 * Yields until a condition holds, for the tests that drive an injected clock.
 *
 * `ControllerSpeaker.play` queues its work on a promise chain, so the player has not been asked to
 * seek yet at the moment `play()` returns. Resolving the deferred seek before that point leaves it
 * pending forever and hangs the run — which is exactly what happened while writing these.
 */
async function settle(until: () => boolean, ticks = 20) {
  for (let i = 0; i < ticks && !until(); i += 1) await Promise.resolve();
}

/**
 * Yields repeatedly, resolving any seek the speaker asks for.
 *
 * The deadline tests must fail rather than hang when the guard is removed: leaving a deferred seek
 * unresolved wedges the run instead of reporting anything, which is a worse signal than the bug.
 * Draining lets an unguarded cue run all the way to `play()`, so the assertion catches it.
 */
async function drain(player: DeferredPlayer, ticks = 40) {
  for (let i = 0; i < ticks; i += 1) {
    player.pending.shift()?.();
    await Promise.resolve();
  }
}

function cue(sequence: number, pitch = 1, volume = 1): SpeakerCueMessage {
  return {
    type: "speaker.cue",
    deviceId: "native-controller",
    sequence,
    cue: "pulse-v1",
    pitch,
    volume,
  };
}

test("the controller speaker restarts the bundled cue with the host's private pitch and level", async () => {
  const player = new FakePlayer();
  const speaker = new ControllerSpeaker(player);

  assert.equal(await speaker.play(cue(7, 1.75, 0.35)), true);
  assert.deepEqual(player.seeks, [0], "each cue starts at the beginning instead of waiting for an old sound");
  assert.equal(player.plays, 1);
  assert.equal(player.playbackRate, 1.75);
  assert.equal(player.volume, 0.35);
  assert.equal(player.shouldCorrectPitch, false, "pitch is game information, not a tempo correction target");
});

test("late and duplicate speaker packets never replay an old private clue", async () => {
  const player = new FakePlayer();
  const speaker = new ControllerSpeaker(player);

  assert.equal(await speaker.play(cue(12)), true);
  assert.equal(await speaker.play(cue(12, 0.5)), false);
  assert.equal(await speaker.play(cue(11, 2)), false);
  assert.equal(player.plays, 1);
  assert.equal(player.playbackRate, 1, "discarded packets cannot mutate the current voice");
});

test("a newer cue cancels an older seek that finishes late", async () => {
  const player = new DeferredPlayer();
  const speaker = new ControllerSpeaker(player);

  const oldCue = speaker.play(cue(20, 0.6));
  await Promise.resolve();
  assert.equal(player.pending.length, 1, "the old restart is already in flight");
  const newCue = speaker.play(cue(21, 1.6));
  player.pending[0]?.();
  assert.equal(await oldCue, false);
  assert.equal(player.plays, 0, "the old seek cannot buzz after the newer packet arrived");

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.pending.length, 2, "the newer restart waits for the shared player");
  player.pending[1]?.();
  assert.equal(await newCue, true);
  assert.equal(player.plays, 1);
  assert.equal(player.playbackRate, 1.6);
});

test("only one restart seek can be in flight on the shared native player", async () => {
  const player = new DeferredPlayer();
  const speaker = new ControllerSpeaker(player);

  const oldCue = speaker.play(cue(30, .7));
  await Promise.resolve();
  const newCue = speaker.play(cue(31, 1.7));
  assert.equal(player.pending.length, 1,
    "issuing both seeks concurrently lets the old one jump a newer sound back to its start");
  player.pending[0]?.();
  assert.equal(await oldCue, false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.pending.length, 2);
  player.pending[1]?.();
  assert.equal(await newCue, true);
  assert.equal(player.plays, 1);
  assert.equal(player.playbackRate, 1.7);
});

test("a new pairing may restart speaker sequencing without reconstructing native audio", async () => {
  const player = new FakePlayer();
  const speaker = new ControllerSpeaker(player);

  await speaker.play(cue(4));
  assert.equal(await speaker.play(cue(1)), false);
  speaker.reset();
  assert.equal(await speaker.play(cue(1, 0.8)), true);
  assert.equal(player.plays, 2);
});

test("native accepts the protocol's first legal sequence and cancel keeps stale protection", async () => {
  const player = new FakePlayer();
  const speaker = new ControllerSpeaker(player);

  assert.equal(await speaker.play(cue(0)), true);
  speaker.cancel();
  assert.equal(await speaker.play(cue(0)), false);
  assert.equal(player.plays, 1);
});

test("a cue discarded while locked cannot replay after native audio becomes ready", async () => {
  const player = new FakePlayer();
  const speaker = new ControllerSpeaker(player);

  assert.equal(speaker.discard(cue(8)), true);
  assert.equal(await speaker.play(cue(8)), false);
  assert.equal(player.plays, 0);
});

test("a cue whose seek outlives the deadline is dropped before it can sound", () => {
  // The 120 ms deadline is why a speaker cue rides the disposable realtime lane at all: a private
  // clue arriving after the moment it described is worse than one that never arrives. Every other
  // test here builds the speaker on the real clock, where elapsed time is ~0 ms, so the deadline
  // never fires — deleting both checks left all seven of them green. These two drive the clock.
  //
  // This one covers the check *after* the seek resolves, which is the subtle one: the cue was live
  // when it started and expired while the audio engine was still seeking.
  return (async () => {
    let clock = 1_000;
    const player = new DeferredPlayer();
    const speaker = new ControllerSpeaker(player, () => clock);

    const sounding = speaker.play(cue(1, 1.4, 0.8));
    await settle(() => player.pending.length > 0);
    clock += 500;
    await drain(player);

    assert.equal(await sounding, false, "a cue that expired mid-seek must not reach the speaker");
    assert.equal(player.seeks.length, 1, "it had already started seeking when the deadline passed");
    assert.equal(player.plays, 0, "but it must never play");
  })();
});

test("a cue that waits out its deadline in the queue never touches the player", () => {
  // And this one covers the check *before* the seek: a cue queued behind a slow one, still waiting
  // when its own moment has passed.
  return (async () => {
    let clock = 1_000;
    const player = new DeferredPlayer();
    const speaker = new ControllerSpeaker(player, () => clock);

    const blocking = speaker.play(cue(1));
    const queued = speaker.play(cue(2, 1.9, 0.05));
    clock += 500;
    await drain(player);
    await blocking;

    assert.equal(await queued, false, "a cue that waited out its deadline must not sound");
    assert.equal(player.plays, 0);
    // The distinctive settings of the queued cue must never have been written to the player, which
    // is what distinguishes "dropped before configuring" from "configured then cancelled".
    assert.notEqual(player.playbackRate, 1.9, "an expired cue must not configure the player");
    assert.notEqual(player.volume, 0.05);
  })();
});

test("a cue still inside its deadline sounds normally on the same driven clock", () => {
  // The companion to both: the deadline must reject late cues without rejecting live ones, or it
  // would be indistinguishable from the speaker simply being broken.
  return (async () => {
    let clock = 5_000;
    const player = new DeferredPlayer();
    const speaker = new ControllerSpeaker(player, () => clock);

    const sounding = speaker.play(cue(9, 1.5, 0.6));
    await settle(() => player.pending.length > 0);
    clock += 30;
    player.pending.shift()?.();

    assert.equal(await sounding, true, "30 ms is well inside the 120 ms budget");
    assert.equal(player.plays, 1);
    assert.equal(player.volume, 0.6);
    assert.equal(player.playbackRate, 1.5);
  })();
});
