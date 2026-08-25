import assert from "node:assert/strict";
import test from "node:test";

import { ControllerInputModel } from "@101/link-controller";
import type { ControlMessage, SpeakerCueMessage } from "@101/protocol";
import { ControllerConfigurationGate, ControllerSpeakerGate } from "./controller-runtime-gates.ts";

const layout = {
  layout: [{ type: "button" as const, action: "fire", label: "FIRE" }],
};

function configuration(revision: number): Extract<ControlMessage, { type: "controller.configure" }> {
  return {
    type: "controller.configure",
    deviceId: "phone",
    gameId: "game",
    role: "gunner",
    revision,
    layout,
    inputFormat: "input-q1",
  };
}

test("a repeated host configuration preserves input held across a native hello heartbeat", () => {
  const model = new ControllerInputModel();
  const gate = new ControllerConfigurationGate();
  const apply = (message: ReturnType<typeof configuration>) => {
    if (gate.accept(message)) model.transition(message.layout);
  };

  apply(configuration(7));
  model.setAction("fire", true, "right-thumb");
  apply(configuration(7));
  assert.equal(model.snapshot().actions.fire, true,
    "the configure response to a repeated hello must not release a held native control");

  apply(configuration(8));
  assert.equal(model.snapshot().actions.fire, false, "a genuinely new layout revision still releases old input");
});

test("native private cues run only while audio is ready and locking cancels pending playback", () => {
  const gate = new ControllerSpeakerGate();
  const played: number[] = [];
  const discarded: number[] = [];
  let cancellations = 0;
  const cue = (sequence: number): SpeakerCueMessage => ({
    type: "speaker.cue",
    deviceId: "phone",
    sequence,
    cue: "pulse-v1",
    pitch: 1,
    volume: .5,
  });

  assert.equal(gate.deliver(cue(1), (message) => played.push(message.sequence), (message) => discarded.push(message.sequence)), false);
  assert.deepEqual(discarded, [1], "locked packets still advance the stale-sequence guard");
  assert.equal(gate.setReady(true, () => { cancellations += 1; }), true);
  assert.equal(gate.deliver(cue(2), (message) => played.push(message.sequence), (message) => discarded.push(message.sequence)), true);
  assert.deepEqual(played, [2]);

  assert.equal(gate.setReady(false, () => { cancellations += 1; }), true);
  assert.equal(cancellations, 1, "losing readiness must cancel an in-flight seek without waiting for a cue");
  assert.equal(gate.deliver(cue(3), (message) => played.push(message.sequence), (message) => discarded.push(message.sequence)), false);
  assert.deepEqual(played, [2]);
  assert.deepEqual(discarded, [1, 3]);
});
