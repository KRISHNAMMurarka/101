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
  decodePairingDescription,
  encodePairingDescription,
  parseControllerLayout,
  MultiplexLinkTransport,
  createControllerPairingUrl,
  decodePairingTicket,
  encodePairingTicket,
  serializeControlMessage,
  serializeRealtimeMessage,
  WebRTCTransport,
  type ControllerLayout,
  type ControlMessage,
  type InputPacketProfile,
  type LinkMessage,
  type LinkTransport,
  type RealtimeMessage,
} from "./index.ts";

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

test("WebRTC switches to binary only after both peers negotiate the configured profile", async () => {
  const originalPeer = globalThis.RTCPeerConnection;
  FakePeerConnection.instances.length = 0;
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;

  const layout = parseControllerLayout({ layout: [
    { type: "joystick", action: "move" },
    { type: "button", action: "fire", label: "FIRE" },
  ] });
  const controller = new WebRTCTransport({ initiator: true });
  const host = new WebRTCTransport({ initiator: true });
  try {
    const frame = {
      deviceId: "phone",
      playerId: "role-player",
      sequence: 9,
      timestamp: 12,
      source: "touch" as const,
      actions: { fire: true },
      vectors: { move: { x: .25, y: -.5 } },
    };
    const assignment = { type: "player.assign", deviceId: "phone", playerId: "role-player", role: "pilot", gameId: "game" } as const;
    const configuration = {
      type: "controller.configure", deviceId: "phone", gameId: "game", role: "pilot", revision: 7,
      layout, inputFormat: INPUT_Q1_FORMAT,
    } as const;

    // Controller side: only control messages received from the host may select its encoder.
    await controller.connect();
    const controllerPeer = FakePeerConnection.instances.at(-1);
    const controllerControl = controllerPeer?.channel("101-control");
    const controllerRealtime = controllerPeer?.channel("101-realtime");
    assert.ok(controllerControl && controllerRealtime);
    assert.equal(controllerRealtime.binaryType, "arraybuffer");
    controller.sendRealtime(frame);
    assert.equal(typeof controllerRealtime.sent.at(-1), "string", "input stays JSON until configuration arrives");
    controllerControl.receive(serializeControlMessage(assignment));
    controllerControl.receive(serializeControlMessage(configuration));
    controller.sendRealtime(frame);
    const binary = controllerRealtime.sent.at(-1);
    assert.ok(binary instanceof Uint8Array);
    assert.equal(binary.byteLength, INPUT_Q1_BYTES);

    // Host side: only the configuration it sent may select its decoder. Keeping this endpoint
    // separate makes a swapped incoming/outgoing profile fail instead of cancelling itself out.
    const received: LinkMessage[] = [];
    host.onMessage((message) => received.push(message));
    await host.connect();
    const hostPeer = FakePeerConnection.instances.at(-1);
    const hostControl = hostPeer?.channel("101-control");
    const hostRealtime = hostPeer?.channel("101-realtime");
    assert.ok(hostControl && hostRealtime);
    host.sendReliable(assignment);
    host.sendReliable(configuration);
    hostRealtime.receive(binary);
    const decoded = received.at(-1);
    assert.equal(decoded?.channel, "realtime");
    assert.equal(decoded?.channel === "realtime" && !("type" in decoded.payload) && decoded.payload.deviceId, "phone");

    const receivedBeforeMalformed = received.length;
    hostRealtime.receive(new Uint8Array(3));
    assert.equal(received.length, receivedBeforeMalformed, "partial disposable input packets are dropped");
  } finally {
    await Promise.all([controller.disconnect(), host.disconnect()]);
    if (originalPeer) globalThis.RTCPeerConnection = originalPeer;
    else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  }
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

test("multiplexes any number of Link transports and removes peers cleanly", async () => {
  const first = new MemoryTransport();
  const second = new MemoryTransport();
  const multiplex = new MultiplexLinkTransport();
  const received: LinkMessage[] = [];
  multiplex.onMessage((message) => received.push(message));
  await multiplex.add("browser", first);
  await multiplex.connect();
  await multiplex.add("phone", second);
  multiplex.sendReliable({ type: "ping", sentAt: 1 });
  assert.equal(first.reliable, 1);
  assert.equal(second.reliable, 1);
  second.emit({ channel: "control", payload: { type: "pong", sentAt: 1, receivedAt: 2 } });
  assert.equal(received.length, 1);
  second.emit({ channel: "control", payload: { type: "hello", version: 2, deviceId: "phone-2", device: "Phone", capabilities: { touch: true } } });
  multiplex.sendReliable({ type: "haptic", deviceId: "phone-2", pattern: "tap" });
  assert.equal(first.reliable, 1, "targeted private control must not be broadcast to other peers");
  assert.equal(second.reliable, 2);
  multiplex.sendRealtime({ type: "speaker.cue", deviceId: "phone-2", sequence: 1, cue: "pulse-v1", pitch: 1, volume: .5 });
  assert.equal(first.realtime, 0, "private speaker audio must not leak to another controller");
  assert.equal(second.realtime, 1);
  assert.equal(await multiplex.remove("phone"), true);
  assert.equal(second.connected, false);
  multiplex.sendRealtime({ type: "speaker.cue", deviceId: "phone-2", sequence: 2, cue: "pulse-v1", pitch: 1, volume: .5 });
  assert.equal(first.realtime, 0, "a private cue for a missing route must be dropped, never broadcast");
  multiplex.sendReliable({ type: "controller.state", deviceId: "phone-2", values: { clue: "private" } });
  assert.equal(first.reliable, 1, "targeted reliable state must also be dropped when its peer is gone");
  multiplex.sendReliable({ type: "ping", sentAt: 3 });
  assert.equal(first.reliable, 2);
  assert.equal(second.reliable, 2);
});

test("multiplex binds each authenticated peer to its own device route", async () => {
  const first = new MemoryTransport();
  const second = new MemoryTransport();
  const multiplex = new MultiplexLinkTransport();
  const received: LinkMessage[] = [];
  multiplex.onMessage((message) => received.push(message));
  await multiplex.add("peer-a", first, { wireDeviceId: "device-a", routeDeviceId: "peer-a" });
  await multiplex.add("peer-b", second, { wireDeviceId: "device-b", routeDeviceId: "peer-b" });
  await multiplex.connect();

  first.emit({ channel: "control", payload: {
    type: "hello", version: 2, deviceId: "device-a", device: "A", capabilities: { touch: true },
  } });
  second.emit({ channel: "control", payload: {
    type: "hello", version: 2, deviceId: "device-b", device: "B", capabilities: { touch: true },
  } });
  second.emit({ channel: "control", payload: {
    type: "hello", version: 2, deviceId: "device-a", device: "B spoofing A", capabilities: { touch: true },
  } });
  second.emit({ channel: "realtime", payload: {
    deviceId: "device-a", playerId: "forged", sequence: 1, timestamp: 1, source: "touch", actions: { fire: true },
  } });

  assert.deepEqual(received.map((message) => (
    "deviceId" in message.payload ? message.payload.deviceId : undefined
  )), ["peer-a", "peer-b"],
    "a peer cannot overwrite another route or inject input under its wire identity");
  multiplex.sendRealtime({
    type: "speaker.cue", deviceId: "peer-a", sequence: 1, cue: "pulse-v1", pitch: 1, volume: .5,
  });
  assert.equal(first.realtime, 1);
  assert.equal(second.realtime, 0, "a private cue stays on the authenticated peer route");
  assert.equal("type" in first.realtimeMessages[0]! && first.realtimeMessages[0].deviceId, "device-a",
    "the bound transport restores the controller's local id on the wire");
});

test("two authenticated peers with the same local id remain distinct host devices", async () => {
  const first = new MemoryTransport();
  const second = new MemoryTransport();
  const multiplex = new MultiplexLinkTransport();
  const received: LinkMessage[] = [];
  multiplex.onMessage((message) => received.push(message));
  await multiplex.add("peer-a", first, { wireDeviceId: "phone", routeDeviceId: "peer-a" });
  await multiplex.add("peer-b", second, { wireDeviceId: "phone", routeDeviceId: "peer-b" });
  await multiplex.connect();
  first.emit({ channel: "control", payload: { type: "hello", version: 2, deviceId: "phone", device: "A", capabilities: { touch: true } } });
  second.emit({ channel: "control", payload: { type: "hello", version: 2, deviceId: "phone", device: "B", capabilities: { touch: true } } });

  assert.deepEqual(received.map((message) => (
    "deviceId" in message.payload ? message.payload.deviceId : undefined
  )), ["peer-a", "peer-b"]);
  multiplex.sendReliable({ type: "controller.state", deviceId: "peer-a", values: { clue: "private" } });
  assert.equal(first.reliable, 1);
  assert.equal(second.reliable, 0);
  assert.equal(first.reliableMessages[0]?.type === "controller.state" && first.reliableMessages[0].deviceId, "phone");
});

class MemoryTransport implements LinkTransport {
  connected = false;
  reliable = 0;
  realtime = 0;
  readonly reliableMessages: ControlMessage[] = [];
  readonly realtimeMessages: RealtimeMessage[] = [];
  private listener?: (message: LinkMessage) => void;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  sendReliable(message: ControlMessage) { this.reliable += 1; this.reliableMessages.push(message); }
  sendRealtime(message: RealtimeMessage) { this.realtime += 1; this.realtimeMessages.push(message); }
  onMessage(callback: (message: LinkMessage) => void) { this.listener = callback; return () => { this.listener = undefined; }; }
  emit(message: LinkMessage) { this.listener?.(message); }
}

function requireProfile(layout: ControllerLayout, revision: number): InputPacketProfile {
  const profile = createInputPacketProfile(layout, {
    revision,
    deviceId: "phone",
    playerId: "role-player",
  });
  assert.ok(profile);
  return profile;
}

class FakeDataChannel {
  readonly label: string;
  readonly sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  readyState = "open" as const;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "blob";
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(label: string) { this.label = label; }

  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(data); }
  close() {}
  receive(data: string | ArrayBuffer | ArrayBufferView) { this.onmessage?.({ data } as MessageEvent); }
}

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = [];
  readonly channels = new Map<string, FakeDataChannel>();
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  constructor() { FakePeerConnection.instances.push(this); }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel(label);
    this.channels.set(label, channel);
    return channel as unknown as RTCDataChannel;
  }

  channel(label: string) { return this.channels.get(label); }
  close() { this.connectionState = "closed"; }
  getStats() { return Promise.resolve(new Map() as unknown as RTCStatsReport); }
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

test("multiplex rejects a mismatched peer across a real BroadcastChannel and keeps compatible traffic", async () => {
  const { BroadcastChannelTransport } = await import("./index.ts");
  const channel = `version-test-${process.pid}-${Date.now()}`;
  const errors: ProtocolVersionError[] = [];
  const multiplex = new MultiplexLinkTransport({ onProtocolError: (error: ProtocolVersionError) => errors.push(error) });
  const sender = new BroadcastChannelTransport(channel);
  const received: LinkMessage[] = [];
  let done!: () => void;
  const delivered = new Promise<void>((resolve) => { done = resolve; });
  multiplex.onMessage((message) => { received.push(message); if (message.channel === "control" && message.payload.type === "hello" && message.payload.deviceId === "compatible") done(); });
  const timeout = setTimeout(() => done(), 1500);
  try {
    await multiplex.add("local", new BroadcastChannelTransport(channel));
    await multiplex.connect();
    await sender.connect();
    sender.sendReliable({ type: "hello", version: PROTOCOL_VERSION + 1, deviceId: "future", device: "Future", capabilities: { touch: true } });
    sender.sendReliable({ type: "hello", version: PROTOCOL_VERSION, deviceId: "compatible", device: "Compatible", capabilities: { touch: true } });
    await delivered;
    assert.equal(received.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.outdated, "ours");
  } finally { clearTimeout(timeout); await sender.disconnect(); await multiplex.disconnect(); }
});
