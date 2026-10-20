// Exact legacy fixture assertions retained from protocol tests at 301b0d3f.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { INPUT_SOURCES } from "@101/input";
import {
  MIN_SUPPORTED_PROTOCOL_VERSION,
  acceptProtocolVersion,
  PROTOCOL_VERSION,
  parseControlMessage,
  ProtocolVersionError,
  negotiateProtocolVersion,
  INPUT_Q1_BYTES,
  INPUT_Q1_FORMAT,
  createInputPacketProfile,
  decodeInputPacket,
  decodeMotionPacket,
  deserializeRealtimeMessage,
  deserializeControlMessage,
  encodeInputPacket,
  encodeMotionPacket,
  parseControllerLayout,
  createControllerPairingUrl,
  decodePairingTicket,
  encodePairingTicket,
  serializeControlMessage,
  serializeRealtimeMessage,
  type ControllerLayout,
  type ControlMessage,
  type InputPacketProfile,
} from "./game-protocol.ts";

test("round-trips reliable control messages", () => {
  const message = { type: "ping", sentAt: 101 } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(message)), message);
});

test("negotiates binary input and private speaker readiness without a protocol-version bump", () => {
  const hello = {
    type: "hello",
    version: 2,
    deviceId: "phone-speaker",
    device: "Phone",
    capabilities: { touch: true, speaker: true },
    features: { inputFormats: [INPUT_Q1_FORMAT], speakerAudio: "ready" },
  } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(hello)), hello);

  const configure = {
    type: "controller.configure",
    deviceId: "phone-speaker",
    gameId: "echomaze",
    role: "scanner",
    revision: 4,
    inputFormat: INPUT_Q1_FORMAT,
    layout: { layout: [{ type: "button", action: "scan", label: "SCAN" }] },
  } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(configure)), configure);

  const cue = {
    type: "speaker.cue",
    deviceId: "phone-speaker",
    sequence: 8,
    cue: "pulse-v1",
    pitch: 1.4,
    volume: .35,
  } as const;
  assert.deepEqual(deserializeRealtimeMessage(serializeRealtimeMessage(cue)), cue);
  assert.throws(() => deserializeRealtimeMessage(JSON.stringify({ ...cue, pitch: 4 })));
});

test("optional feature negotiation ignores future offers while preserving known intersections", () => {
  const hello = {
    type: "hello",
    version: 2,
    deviceId: "future-phone",
    device: "Future Phone",
    capabilities: { touch: true },
    features: { inputFormats: [INPUT_Q1_FORMAT], speakerAudio: "ready" },
  } as const;
  const futurePacket = JSON.parse(serializeControlMessage(hello)) as {
    message: { features: { inputFormats: string[]; futureBatteryMode?: string } };
  };
  futurePacket.message.features.inputFormats.push("input-q2");
  futurePacket.message.features.futureBatteryMode = "eco";

  const parsed = deserializeControlMessage(JSON.stringify(futurePacket));
  assert.equal(parsed.type, "hello");
  assert.deepEqual(parsed.type === "hello" && parsed.features, {
    inputFormats: [INPUT_Q1_FORMAT],
    speakerAudio: "ready",
  });

  futurePacket.message.features.inputFormats = ["input-q2"];
  const jsonOnly = deserializeControlMessage(JSON.stringify(futurePacket));
  assert.deepEqual(jsonOnly.type === "hello" && jsonOnly.features?.inputFormats, [],
    "an old host falls back to JSON when it recognizes none of a future controller's formats");
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

test("canonicalizes gamepad controls, placement hints, interactions, and stick tuning", () => {
  const chordActions = ["guard", "dash"];
  const source = {
    title: "Arcade pad",
    handedness: "right",
    layout: [
      {
        type: "joystick", action: "move", label: "MOVE",
        side: "left", zone: "thumb", size: "large", span: 2, priority: 100,
      },
      { type: "shoulder", action: "focus", label: "L1", side: "left", zone: "shoulder", interaction: { type: "hold" } },
      { type: "button", action: "special", label: "SPECIAL", interaction: { type: "chord", actions: chordActions } },
      { type: "trigger", action: "brake", label: "L2", side: "left", zone: "index" },
      { type: "analog-button", action: "accelerate", label: "R2", side: "right", zone: "index" },
    ],
  };

  const parsed = parseControllerLayout(source);
  assert.deepEqual(parsed, {
    title: "Arcade pad",
    handedness: "right",
    layout: [
      {
        type: "joystick", action: "move", label: "MOVE", deadZone: .12, responseCurve: 1,
        side: "left", zone: "thumb", size: "large", span: 2, priority: 100,
      },
      { type: "shoulder", action: "focus", label: "L1", interaction: { type: "hold", thresholdMs: 450 }, side: "left", zone: "shoulder" },
      { type: "button", action: "special", label: "SPECIAL", interaction: { type: "chord", actions: ["guard", "dash"] } },
      { type: "trigger", action: "brake", label: "L2", side: "left", zone: "index" },
      { type: "analog-button", action: "accelerate", label: "R2", side: "right", zone: "index" },
    ],
  });
  assert.notStrictEqual(parsed.layout[2], source.layout[2]);
  if (parsed.layout[2]?.type !== "button" || parsed.layout[2].interaction?.type !== "chord") {
    assert.fail("Expected a canonical chord interaction");
  }
  assert.notStrictEqual(parsed.layout[2].interaction.actions, chordActions);
  chordActions.push("pause");
  assert.deepEqual(parsed.layout[2].interaction.actions, ["guard", "dash"]);
});

test("applies configurable interaction and joystick defaults without invalidating old layouts", () => {
  assert.deepEqual(parseControllerLayout({ layout: [{ type: "joystick", action: "move" }] }), {
    layout: [{ type: "joystick", action: "move", deadZone: .12, responseCurve: 1 }],
  });
  assert.deepEqual(parseControllerLayout({
    layout: [
      { type: "joystick", action: "aim", deadZone: 0, responseCurve: 4 },
      { type: "button", action: "dash", label: "DASH", interaction: { type: "double-tap" } },
      { type: "shoulder", action: "guard", label: "GUARD", interaction: { type: "toggle" } },
    ],
  }), {
    layout: [
      { type: "joystick", action: "aim", deadZone: 0, responseCurve: 4 },
      { type: "button", action: "dash", label: "DASH", interaction: { type: "double-tap", intervalMs: 300 } },
      { type: "shoulder", action: "guard", label: "GUARD", interaction: { type: "toggle" } },
    ],
  });
});

test("rejects invalid controller placement, tuning, and interaction contracts", () => {
  const button = { type: "button", action: "fire", label: "FIRE" };
  const invalidLayouts = [
    { handedness: "ambidextrous", layout: [button] },
    { layout: [{ ...button, action: "1fire" }] },
    { layout: [{ ...button, action: ".fire" }] },
    { layout: [{ ...button, action: "fire." }] },
    { layout: [{ ...button, side: "top" }] },
    { layout: [{ ...button, zone: "palm" }] },
    { layout: [{ ...button, size: "huge" }] },
    { layout: [{ ...button, span: 0 }] },
    { layout: [{ ...button, span: 1.5 }] },
    { layout: [{ ...button, priority: -1 }] },
    { layout: [{ type: "joystick", action: "move", deadZone: .951 }] },
    { layout: [{ type: "joystick", action: "move", responseCurve: .249 }] },
    { layout: [{ ...button, interaction: { type: "hold", thresholdMs: 149 } }] },
    { layout: [{ ...button, interaction: { type: "double-tap", intervalMs: 751 } }] },
    { layout: [{ ...button, interaction: { type: "chord", actions: [] } }] },
    { layout: [{ ...button, interaction: { type: "chord", actions: ["guard", "guard"] } }] },
    { layout: [{ ...button, interaction: { type: "chord", actions: ["fire"] } }] },
    { layout: [{ type: "analog-button", action: "throttle" }] },
    { layout: [{ type: "trigger", action: "brake" }] },
    { layout: [{ type: "trigger", action: "brake", label: "RT", interaction: { type: "toggle" } }] },
    { layout: [{ type: "shoulder", action: "guard" }] },
    { layout: [{ ...button, priorty: 90 }] },
    { layout: [{ ...button, interaction: { type: "toggle", extra: true } }] },
    { future: true, layout: [button] },
    { $schema: 101, layout: [button] },
    { motion: { action: "aim", mode: "wand", extra: true }, layout: [button] },
    { motion: { action: "aim", mode: "wand", gestures: { swing: "fire", extra: "dash" } }, layout: [button] },
  ];
  for (const layout of invalidLayouts) assert.throws(() => parseControllerLayout(layout));
});

test("publishes the expanded controller contract in JSON Schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../schemas/controller-layout.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);
  for (const field of ["handedness", "side", "zone", "size", "span", "priority", "interaction", "deadZone", "responseCurve"]) {
    assert.match(serialized, new RegExp(`\\"${field}\\"`));
  }
  for (const type of ["shoulder", "trigger", "analog-button", "hold", "double-tap", "toggle", "chord"]) {
    assert.match(serialized, new RegExp(`\\"${type}\\"`));
  }
  const definitions = schema.$defs as Record<string, Record<string, unknown>>;
  assert.equal(definitions.action?.maxLength, 64, "schema action names must match the runtime parser");
  assert.equal(definitions.label?.maxLength, 40, "schema labels must match the runtime parser");
  assert.equal(definitions.motionLabel?.maxLength, 64, "motion labels retain their runtime 64-character limit");
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
      motion: { action: "aim", mode: "wand", gestures: { swing: "spell.cast.blade", spin: "spell.cast.vortex" } },
      layout: [
        { type: "slider", action: "power", label: "POWER", min: 0, max: 1, step: .01 },
        { type: "button", action: "vent", label: "VENT", emphasis: "danger" },
      ],
    },
  } as const;
  assert.deepEqual(deserializeControlMessage(serializeControlMessage(message)), message);
  assert.throws(() => parseControllerLayout({ motion: { action: "aim", mode: "wand", gestures: { swing: "bad action" } }, layout: [{ type: "button", action: "fire", label: "FIRE" }] }));
});

test("round-trips explicit controller standby state", () => {
  const message = { type: "player.wait", deviceId: "phone-2", gameId: "tiltdrift", reason: "no-open-role" } as const;
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

test("packs a complete gamepad snapshot into a fixed 24-byte negotiated packet", () => {
  const layout = parseControllerLayout({
    title: "Pro Gamepad",
    layout: [
      { type: "shoulder", action: "bumperL", label: "LB" },
      { type: "trigger", action: "triggerL", label: "LT" },
      { type: "joystick", action: "move", label: "MOVE" },
      { type: "shoulder", action: "bumperR", label: "RB" },
      { type: "trigger", action: "triggerR", label: "RT" },
      { type: "joystick", action: "aim", label: "AIM" },
      { type: "analog-button", action: "buttonA", label: "A" },
      { type: "button", action: "buttonB", label: "B", interaction: { type: "toggle" } },
      { type: "button", action: "buttonX", label: "X", interaction: { type: "chord", actions: ["bumperL", "bumperR"] } },
      { type: "button", action: "buttonY", label: "Y" },
    ],
  });
  const profile = requireProfile(layout, 7);
  assert.equal(profile.lanes.length, 12, "the shipped Pro Gamepad must fit every control exactly");

  const frame = {
    deviceId: "phone",
    playerId: "forged",
    sequence: 0x10203040,
    timestamp: 0x1_0000_0005,
    source: "touch" as const,
    actions: {
      bumperL: true,
      triggerL: .51,
      bumperR: false,
      triggerR: 1,
      buttonA: .25,
      buttonB: true,
      buttonX: false,
      buttonY: true,
    },
    vectors: { move: { x: -.75, y: .5 }, aim: { x: 1, y: -1 } },
  };
  const encoded = encodeInputPacket(frame, profile);
  assert.equal(encoded.byteLength, INPUT_Q1_BYTES);
  assert.equal(serializeRealtimeMessage(frame, profile) instanceof Uint8Array, true);

  const padded = new Uint8Array(INPUT_Q1_BYTES + 6);
  padded.set(encoded, 3);
  const decoded = decodeInputPacket(padded.subarray(3, 3 + INPUT_Q1_BYTES), profile);
  assert.equal(decoded.deviceId, "phone");
  assert.equal(decoded.playerId, "role-player");
  assert.equal(decoded.sequence, frame.sequence);
  assert.equal(decoded.timestamp, 5, "timestamps are intentionally transmitted modulo 2^32");
  assert.equal(decoded.source, "touch");
  assert.equal(decoded.actions.bumperL, true);
  assert.equal(decoded.actions.bumperR, false);
  assert.ok(Math.abs(Number(decoded.actions.triggerL) - .51) <= 1 / 255);
  assert.ok(Math.abs(decoded.vectors!.move!.x - -.75) <= 1 / 127);
  assert.ok(Math.abs(decoded.vectors!.move!.y - .5) <= 1 / 127);
  assert.deepEqual(deserializeRealtimeMessage(encoded, profile), decoded);

  const stale = encoded.slice();
  new DataView(stale.buffer).setUint16(2, 8, true);
  assert.throws(() => decodeInputPacket(stale, profile), /revision/i);
});

test("a swipe surface carries blade position and held state in one compact packet", () => {
  const layout = parseControllerLayout({
    title: "Swipe blade",
    layout: [{ type: "touch-surface", action: "aim", label: "Swipe to slice", pressAction: "trigger" }],
  });
  assert.deepEqual(layout.layout[0], { type: "touch-surface", action: "aim", label: "Swipe to slice", pressAction: "trigger" });
  const profile = requireProfile(layout, 3);
  assert.deepEqual(profile.lanes.map((lane) => lane.name), ["aim", "aim", "trigger"]);
  const frame = {
    deviceId: "phone", playerId: "forged", sequence: 1, timestamp: 2, source: "touch" as const,
    actions: { trigger: true }, vectors: { aim: { x: .5, y: -.5 } },
  };
  const encoded = encodeInputPacket(frame, profile);
  assert.equal(encoded.byteLength, INPUT_Q1_BYTES);
  const decoded = decodeInputPacket(encoded, profile);
  assert.equal(decoded.actions.trigger, true);
  assert.ok(Math.abs(decoded.vectors!.aim!.x - .5) <= 1 / 127);
  assert.throws(() => parseControllerLayout({ layout: [{ type: "touch-surface", action: "aim", pressAction: "aim" }] }), /press action/);
  assert.throws(() => parseControllerLayout({ layout: [{ type: "dpad", action: "move", pressAction: "trigger" }] }), /Unsupported/);
});

test("keeps JSON realtime fallback for layouts that cannot be represented safely", () => {
  const oversized: ControllerLayout = {
    layout: Array.from({ length: 13 }, (_, index) => ({
      type: "button" as const,
      action: `button${index}`,
      label: `B${index}`,
    })),
  };
  assert.equal(createInputPacketProfile(oversized, {
    revision: 1,
    deviceId: "phone",
    playerId: "role-player",
  }), undefined);
  assert.equal(createInputPacketProfile({ layout: [
    { type: "button", action: "same", label: "SAME" },
    { type: "joystick", action: "same" },
  ] }, { revision: 1, deviceId: "phone", playerId: "role-player" }), undefined);
  assert.equal(createInputPacketProfile({ layout: [
    { type: "joystick", action: "move" },
    { type: "slider", action: "moveX", label: "STRAFE", min: -1, max: 1 },
  ] }, { revision: 1, deviceId: "phone", playerId: "role-player" }), undefined,
  "derived vector-axis aliases must not overwrite an independently encoded control");

  const frame = { deviceId: "phone", playerId: "player", sequence: 1, timestamp: 2, source: "touch" as const, actions: { fire: true } };
  assert.equal(typeof serializeRealtimeMessage(frame), "string");
});

test("keeps a layout-transition release complete when the new binary profile cannot encode it", () => {
  const profile = createInputPacketProfile({ layout: [
    { type: "button", action: "newAction", label: "NEW" },
  ] }, { revision: 2, deviceId: "phone", playerId: "role-player" });
  assert.ok(profile);
  const release = {
    deviceId: "phone",
    playerId: "role-player",
    sequence: 4,
    timestamp: 8,
    source: "touch" as const,
    actions: { oldHeldAction: false },
  };

  assert.equal(typeof serializeRealtimeMessage(release, profile), "string",
    "the old action name must survive the transition instead of disappearing from a new-profile packet");
  assert.throws(() => encodeInputPacket(release, profile), /JSON fallback/,
    "direct codec callers must not silently discard an unprofiled release either");
});

test("round-trips bounded expiring LAN pairing tickets and controller URLs", () => {
  const ticket = {
    version: 2, sessionId: "ABC101", endpoint: "http://192.168.1.20:10101",
    joinToken: "abcdefghijklmnopqrstuvwxyzABCDEF", expiresAt: 2_000,
    hostName: "Living Room", transport: "webrtc",
  } as const;
  const code = encodePairingTicket(ticket);
  assert.match(code, /^101L2\./);
  assert.deepEqual(decodePairingTicket(code, 1_000), ticket);
  const url = createControllerPairingUrl("https://controller.101.local/controller", ticket);
  assert.equal(new URL(url).searchParams.get("pair"), code);
  assert.throws(() => decodePairingTicket(code, 2_001), /expired/);
  assert.throws(() => decodePairingTicket(`${code.slice(0, -1)}x`, 1_000), /integrity|encoding|JSON/);
});

function requireProfile(layout: ControllerLayout, revision: number): InputPacketProfile {
  const profile = createInputPacketProfile(layout, {
    revision,
    deviceId: "phone",
    playerId: "role-player",
  });
  assert.ok(profile);
  return profile;
}

test("input packet source indices are append-only wire values", () => {
  // The Q1 packet stores the source as a 4-bit index into INPUT_SOURCES, so this list's *order* is
  // wire format: reordering or inserting silently remaps every frame a deployed controller sends,
  // and there is no version bump that can rescue a phone already holding the old order. This copy
  // is deliberately frozen and must never be regenerated — it is the record of what shipped.
  assert.deepEqual([...INPUT_SOURCES], [
    "keyboard", "mouse", "touch", "gamepad", "phone-motion", "watch-motion",
    "camera-hand", "camera-pose", "camera-face", "hid", "bluetooth", "serial", "custom",
  ], "append only: an existing source may never change index");
  assert.ok(INPUT_SOURCES.length <= 16, "the packet header has four bits for the source index");
});

test("a hello one version behind is accepted and reported at the agreed version", () => {
  // 101 Link is an installable PWA, so a host meets controllers older than itself as a matter of
  // course. Bumping PROTOCOL_VERSION must not orphan them.
  const hello = {
    type: "hello",
    version: MIN_SUPPORTED_PROTOCOL_VERSION,
    deviceId: "phone-1",
    device: "Phone",
    capabilities: { sources: ["touch"], haptics: false },
  };
  const parsed = parseControlMessage(hello) as Extract<ControlMessage, { type: "hello" }>;
  assert.equal(parsed.version, MIN_SUPPORTED_PROTOCOL_VERSION);
  assert.equal(parsed.deviceId, "phone-1");
});

test("a version with no overlap names which device is behind", () => {
  const older = () => parseControlMessage({
    type: "hello", version: MIN_SUPPORTED_PROTOCOL_VERSION - 1,
    deviceId: "d", device: "D", capabilities: { sources: ["touch"], haptics: false },
  });
  assert.throws(older, (error: unknown) => {
    assert.ok(error instanceof ProtocolVersionError);
    assert.equal(error.outdated, "theirs");
    assert.match(error.message, /Update the other device/);
    return true;
  });

  const newer = () => parseControlMessage({
    type: "hello", version: PROTOCOL_VERSION + 1,
    deviceId: "d", device: "D", capabilities: { sources: ["touch"], haptics: false },
  });
  assert.throws(newer, (error: unknown) => {
    assert.ok(error instanceof ProtocolVersionError);
    assert.equal(error.outdated, "ours");
    assert.match(error.message, /Update this device/);
    return true;
  });
});

test("a version mismatch is distinguishable from a malformed packet", () => {
  // Both used to throw a bare Error, so a caller could not tell "your controller needs updating"
  // from "this is not a 101 packet" and could only report the generic case.
  assert.throws(() => deserializeControlMessage(JSON.stringify({ version: 99, message: {} })), ProtocolVersionError);
  assert.throws(() => deserializeControlMessage(JSON.stringify({ message: {} })), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof ProtocolVersionError));
    return true;
  });
});

test("negotiating clamps to the lower version; reading accepts a closed range", () => {
  // These answer different questions, and conflating them is the bug this pair was written for:
  // agreeing on v2 with a v7 peer does not mean a packet stamped v7 is readable.
  assert.equal(negotiateProtocolVersion(PROTOCOL_VERSION + 5), PROTOCOL_VERSION);
  assert.equal(acceptProtocolVersion(PROTOCOL_VERSION + 5), false);

  assert.equal(negotiateProtocolVersion(PROTOCOL_VERSION), PROTOCOL_VERSION);
  assert.equal(acceptProtocolVersion(PROTOCOL_VERSION), true);
  assert.equal(acceptProtocolVersion(MIN_SUPPORTED_PROTOCOL_VERSION), true);

  for (const nonsense of [MIN_SUPPORTED_PROTOCOL_VERSION - 1, 1.5, Number.NaN]) {
    assert.equal(negotiateProtocolVersion(nonsense), undefined, `negotiated ${nonsense}`);
    assert.equal(acceptProtocolVersion(nonsense), false, `accepted ${nonsense}`);
  }
});

test("preserves independent display and audio-output capabilities in a hello", () => {
  const hello = parseControlMessage({ type: "hello", version: PROTOCOL_VERSION, deviceId: "screen-1", device: "Screen", capabilities: { display: true, audioOut: true, touch: false } });
  assert.equal(hello.type, "hello");
  if (hello.type === "hello") assert.deepEqual(hello.capabilities, { display: true, audioOut: true, touch: false });
});

test("binary lane version failures name the outdated peer", () => {
  const layout = { layout: [{ type: "button", action: "fire", label: "Fire" }] } as const;
  const profile = createInputPacketProfile(layout, { revision: 1, deviceId: "pad", playerId: "player-1" })!;
  const packet = encodeInputPacket({ deviceId: "pad", playerId: "player-1", source: "touch", sequence: 1, timestamp: 1, actions: { fire: true } }, profile);
  for (const version of [1, PROTOCOL_VERSION + 1]) {
    packet[0] = version;
    assert.throws(() => decodeInputPacket(packet, profile), (error: unknown) => error instanceof ProtocolVersionError && error.outdated === (version > PROTOCOL_VERSION ? "ours" : "theirs"));
    const motion = new Uint8Array(48);
    motion[0] = version;
    motion[1] = 1;
    assert.throws(() => decodeMotionPacket(motion), ProtocolVersionError);
  }
});