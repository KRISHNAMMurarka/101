import assert from "node:assert/strict";
import test from "node:test";

import {
  INPUT_Q1_BYTES,
  INPUT_Q1_FORMAT,
  serializeControlMessage,
  type ControlMessage,
} from "@101/protocol";
import { NativeWebRTCCodec } from "./native-webrtc-codec.ts";

const layout = {
  layout: [
    { type: "joystick" as const, action: "move", label: "MOVE" },
    { type: "button" as const, action: "fire", label: "FIRE" },
  ],
};
const assignment = {
  type: "player.assign",
  deviceId: "phone",
  playerId: "role-player",
  role: "pilot",
  gameId: "game",
} satisfies ControlMessage;
const configuration = {
  type: "controller.configure",
  deviceId: "phone",
  gameId: "game",
  role: "pilot",
  revision: 7,
  layout,
  inputFormat: INPUT_Q1_FORMAT,
} satisfies ControlMessage;
const frame = {
  deviceId: "phone",
  playerId: "role-player",
  sequence: 9,
  timestamp: 12,
  source: "touch" as const,
  actions: { fire: true },
  axes: { move: .25, moveX: .25, moveY: -.5 },
  vectors: { move: { x: .25, y: -.5 } },
};

test("native controller and host codecs negotiate input-q1 in the real wire directions", () => {
  const controller = new NativeWebRTCCodec();
  assert.equal(typeof controller.serializeRealtime(frame), "string");
  controller.deserializeControl(serializeControlMessage(assignment));
  controller.deserializeControl(serializeControlMessage(configuration));
  const binary = controller.serializeRealtime(frame);
  assert.ok(binary instanceof Uint8Array, "configuration received by Link must select its encoder");
  assert.equal(binary.byteLength, INPUT_Q1_BYTES);

  const host = new NativeWebRTCCodec();
  host.serializeControl(assignment);
  host.serializeControl(configuration);
  const decoded = host.deserializeRealtime(binary);
  assert.equal("type" in decoded, false);
  if ("type" in decoded) return;
  assert.equal(decoded.deviceId, "phone");
  assert.equal(decoded.playerId, "role-player");
  assert.equal(decoded.actions.fire, true);
  assert.ok(Math.abs(decoded.vectors!.move!.x - .25) <= 1 / 127);

  assert.equal(typeof host.serializeRealtime(frame), "string",
    "configuration sent by the host selects only its decoder, never its encoder");
  assert.throws(() => controller.deserializeRealtime(binary), /before format negotiation/,
    "configuration received by Link must not select its decoder in the opposite direction");
});
