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
