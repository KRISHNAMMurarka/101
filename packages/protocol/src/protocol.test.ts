import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeMotionPacket,
  deserializeControlMessage,
  encodeMotionPacket,
  decodePairingDescription,
  encodePairingDescription,
  parseControllerLayout,
  serializeControlMessage,
} from "./index.ts";

test("round-trips reliable control messages", () => {
  const message = { type: "ping", sentAt: 101 } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(message)), message);
});

test("validates custom controller layout JSON", () => {
  const layout = parseControllerLayout({
    title: "Reactor",
    accent: "#f8d96a",
    layout: [{ type: "slider", action: "reactor.power", label: "POWER", min: .2, max: 1 }],
  });
  assert.equal(layout.layout[0]?.type, "slider");
  assert.throws(() => parseControllerLayout({ layout: [{ type: "button", action: "bad action", label: "FIRE" }] }));
  assert.throws(() => parseControllerLayout({ layout: [] }));
});

test("rejects malformed reliable control payloads", () => {
  assert.throws(() => deserializeControlMessage(JSON.stringify({ version: 2, message: { type: "haptic", deviceId: "phone", pattern: "forever" } })));
  assert.throws(() => deserializeControlMessage(JSON.stringify({ version: 2, message: { type: "controller.configure", deviceId: "phone", gameId: "game", role: "pilot", revision: 1, layout: { layout: [] } } })));
});

test("round-trips targeted dynamic controller configuration", () => {
  const message = {
    type: "controller.configure",
    deviceId: "phone-2",
    gameId: "orbitalcrew",
    role: "reactor",
    revision: 4,
    layout: {
      title: "Reactor",
      accent: "#f8d96a",
      layout: [
        { type: "slider", action: "power", label: "POWER", min: 0, max: 1, step: .01 },
        { type: "button", action: "vent", label: "VENT", emphasis: "danger" },
      ],
    },
  } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(message)), message);
});

test("packs motion into a fixed 48-byte realtime packet", () => {
  const encoded = encodeMotionPacket({
    sequence: 504,
    timestamp: 1234.5,
    quaternion: [0, 0.5, -0.25, 1],
    acceleration: [1.2, -0.3, 0],
    buttons: 5,
  });
  const decoded = decodeMotionPacket(encoded);
  assert.equal(encoded.byteLength, 48);
  assert.equal(decoded.sequence, 504);
  assert.equal(decoded.buttons, 5);
  assert.ok(Math.abs(decoded.quaternion[1] - 0.5) < 0.0001);
});

test("round-trips validated offline pairing descriptions", async () => {
  const description = {
    type: "offer" as const,
    sdp: "v=0\r\na=ice-options:trickle\r\n",
  };
  const code = await encodePairingDescription(description, false);
  assert.match(code, /^101J2\./);
  assert.deepEqual(await decodePairingDescription(code), description);
});

test("compresses offline pairing descriptions when streams are available", async () => {
  if (typeof CompressionStream === "undefined") return;
  const description = { type: "offer" as const, sdp: `v=0\r\n${"a=candidate:local\r\n".repeat(80)}` };
  const code = await encodePairingDescription(description);
  assert.match(code, /^101C2\./);
  assert.deepEqual(await decodePairingDescription(code), description);
});

test("rejects corrupted pairing descriptions", async () => {
  const code = await encodePairingDescription({ type: "answer", sdp: "v=0\r\n" }, false);
  await assert.rejects(() => decodePairingDescription(`${code.slice(0, -1)}x`));
});
