import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type LinkMessage,
  type LinkTransport,
  type RealtimeMessage,
  type SpeakerCueMessage,
} from "@101/protocol";
import { LocalSession, SessionHost, type SessionRole } from "./index.ts";

const roles: SessionRole[] = [
  {
    id: "pilot",
    label: "Pilot",
    playerId: "role-pilot",
    preferredCapabilities: ["gyroscope"],
    layout: { title: "Flight", layout: [{ type: "joystick", action: "flight" }] },
  },
  {
    id: "weapons",
    label: "Weapons",
    playerId: "role-weapons",
    requiredCapabilities: ["touch"],
    layout: { title: "Weapons", layout: [{ type: "button", action: "fire", label: "FIRE" }] },
  },
];

test("assigns compatible devices deterministically and prefers stronger capabilities", () => {
  const session = new LocalSession("TEST01", 1);
  session.configureGame("orbitalcrew", roles);
  session.register({ id: "touch-first", label: "Touch", capabilities: { touch: true }, lastSeenAt: 10 });
  session.register({ id: "motion-second", label: "Motion", capabilities: { touch: true, gyroscope: true }, lastSeenAt: 11 });

  assert.equal(session.assignmentForRole("pilot")?.deviceId, "motion-second");
  assert.equal(session.assignmentForRole("weapons")?.deviceId, "touch-first");
  assert.equal(session.snapshot().openRoles.length, 0);
});

test("keeps devices connected while changing games and reconfigures roles", () => {
  const session = new LocalSession("TEST02", 1);
  session.configureGame("first", roles);
  session.register({ id: "phone", label: "Phone", capabilities: { touch: true }, lastSeenAt: 10 });
  const firstConnectedAt = session.devices.get("phone")?.connectedAt;

  session.configureGame("second", [{
    id: "reactor",
    label: "Reactor",
    playerId: "role-reactor",
    layout: { layout: [{ type: "slider", action: "power", label: "POWER" }] },
  }]);

  assert.equal(session.devices.get("phone")?.connectedAt, firstConnectedAt);
  assert.equal(session.assignmentForDevice("phone")?.gameId, "second");
  assert.equal(session.assignmentForDevice("phone")?.roleId, "reactor");
});

test("session layout clones isolate nested interactions from sources, snapshots, and sent configurations", async () => {
  const chordActions = ["guard"];
  const chordRole: SessionRole = {
    id: "combo",
    label: "Combo",
    playerId: "role-combo",
    requiredCapabilities: ["touch"],
    layout: {
      layout: [{
        type: "button",
        action: "special",
        label: "SPECIAL",
        interaction: { type: "chord", actions: chordActions },
      }],
    },
  };

  const session = new LocalSession("CLONE1", 1);
  session.configureGame("clone-test", [chordRole]);
  chordActions[0] = "source-corruption";
  const firstSnapshot = session.snapshot();
  const firstElement = firstSnapshot.openRoles[0]?.layout.layout[0];
  assert.equal(firstElement?.type, "button");
  assert.deepEqual(firstElement?.type === "button" && firstElement.interaction?.type === "chord"
    ? firstElement.interaction.actions : [], ["guard"]);
  if (firstElement?.type === "button" && firstElement.interaction?.type === "chord") {
    (firstElement.interaction.actions as string[])[0] = "snapshot-corruption";
  }
  const secondElement = session.snapshot().openRoles[0]?.layout.layout[0];
  assert.deepEqual(secondElement?.type === "button" && secondElement.interaction?.type === "chord"
    ? secondElement.interaction.actions : [], ["guard"]);

  chordActions[0] = "guard";
  const transport = new MemoryTransport();
  const host = new SessionHost({ gameId: "clone-test", roles: [chordRole], transport, onFrame: () => {}, deviceTimeoutMs: 60_000 });
  chordActions[0] = "host-source-corruption";
  await host.start();
  try {
    transport.emit({
      channel: "control",
      payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } },
    });
    const firstConfiguration = transport.reliable.find((message) => message.type === "controller.configure");
    assert.equal(firstConfiguration?.type, "controller.configure");
    const sentElement = firstConfiguration?.type === "controller.configure" ? firstConfiguration.layout.layout[0] : undefined;
    if (sentElement?.type === "button" && sentElement.interaction?.type === "chord") {
      (sentElement.interaction.actions as string[])[0] = "message-corruption";
    }
    transport.reliable.length = 0;
    transport.emit({
      channel: "control",
      payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } },
    });
    const nextConfiguration = transport.reliable.find((message) => message.type === "controller.configure");
    const nextElement = nextConfiguration?.type === "controller.configure" ? nextConfiguration.layout.layout[0] : undefined;
    assert.deepEqual(nextElement?.type === "button" && nextElement.interaction?.type === "chord"
      ? nextElement.interaction.actions : [], ["guard"]);
  } finally {
    await host.stop();
  }
});

test("session host targets layouts and overrides untrusted realtime identity", async () => {
  const transport = new MemoryTransport();
  const frames: InputFrame[] = [];
  const host = new SessionHost({
    gameId: "orbitalcrew",
    roles,
    transport,
    onFrame: (frame) => frames.push(frame),
    deviceTimeoutMs: 60_000,
  });
  await host.start();
  transport.emit({
    channel: "control",
    payload: {
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId: "phone-1",
      device: "Phone",
      capabilities: { touch: true },
    },
  });

  const assignment = transport.reliable.find((message) => message.type === "player.assign");
  const configuration = transport.reliable.find((message) => message.type === "controller.configure");
  assert.equal(assignment?.type === "player.assign" && assignment.deviceId, "phone-1");
  assert.equal(configuration?.type === "controller.configure" && configuration.deviceId, "phone-1");

  transport.emit({ channel: "realtime", payload: frame("unknown", "admin") });
  transport.emit({ channel: "realtime", payload: frame("phone-1", "admin") });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.deviceId, "phone-1");
  assert.equal(frames[0]?.playerId, "role-pilot");
  await host.stop();
});

test("session host rolls back a failed start so a retry reconnects cleanly", async () => {
  let connectAttempts = 0;
  let activeListeners = 0;
  const reliable: ControlMessage[] = [];
  const listeners = new Set<(message: LinkMessage) => void>();
  const transport: LinkTransport = {
    async connect() {
      connectAttempts += 1;
      if (connectAttempts === 1) throw new Error("temporary signaling failure");
    },
    async disconnect() {},
    sendReliable(message) { reliable.push(message); },
    sendRealtime() {},
    onMessage(callback) {
      activeListeners += 1;
      listeners.add(callback);
      return () => {
        activeListeners -= 1;
        listeners.delete(callback);
      };
    },
  };
  const host = new SessionHost({
    gameId: "retry",
    roles: [roles[1]!],
    transport,
    onFrame: () => {},
    deviceTimeoutMs: 60_000,
  });

  await assert.rejects(() => host.start(), /temporary signaling failure/);
  assert.equal(activeListeners, 0, "a rejected connection must not retain its receive listener");

  await host.start();
  assert.equal(connectAttempts, 2, "retry must call the transport again instead of trusting stale started state");
  assert.equal(activeListeners, 1);
  for (const listener of listeners) listener({
    channel: "control",
    payload: {
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId: "retry-phone",
      device: "Phone",
      capabilities: { touch: true },
    },
  });
  assert.ok(reliable.some((message) => message.type === "player.assign"),
    "the retry must install one working receive listener");
  await host.stop();
  assert.equal(activeListeners, 0);
});

test("session host stop prevents a pending successful start from resurrecting its timer", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalInstalls = 0;
  globalThis.setInterval = (() => {
    intervalInstalls += 1;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;

  let releaseConnect!: () => void;
  let signalConnectStarted!: () => void;
  const connectStarted = new Promise<void>((resolve) => { signalConnectStarted = resolve; });
  const connectPending = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let activeListeners = 0;
  let disconnects = 0;
  const transport: LinkTransport = {
    async connect() {
      signalConnectStarted();
      await connectPending;
    },
    async disconnect() { disconnects += 1; },
    sendReliable() {},
    sendRealtime() {},
    onMessage() {
      activeListeners += 1;
      return () => { activeListeners -= 1; };
    },
  };
  const host = new SessionHost({
    gameId: "pending-start",
    roles: [],
    transport,
    onFrame: () => {},
    deviceTimeoutMs: 60_000,
  });

  try {
    const start = host.start();
    await connectStarted;
    await host.stop();
    releaseConnect();
    await start;

    assert.equal(activeListeners, 0, "cleanup must retain no receive path after the late connection");
    assert.equal(intervalInstalls, 0, "a stopped host must not install expiry work after connect resolves");
    assert.ok(disconnects >= 1);
  } finally {
    releaseConnect();
    await host.stop();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("session host clamps untrusted Link analog controls to their declared 0..1 range", async () => {
  const transport = new MemoryTransport();
  const frames: InputFrame[] = [];
  const host = new SessionHost({
    gameId: "racer",
    roles: [{
      id: "driver",
      label: "Driver",
      playerId: "role-driver",
      requiredCapabilities: ["touch"],
      layout: { layout: [
        { type: "trigger", action: "throttle", label: "RT" },
        { type: "analog-button", action: "brake", label: "BRAKE" },
      ] },
    }],
    transport,
    onFrame: (input) => frames.push(input),
    deviceTimeoutMs: 60_000,
  });
  await host.start();
  try {
    transport.emit({
      channel: "control",
      payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } },
    });
    transport.emit({
      channel: "realtime",
      payload: {
        deviceId: "phone", playerId: "forged", sequence: 1, timestamp: 1, source: "custom",
        actions: { throttle: 4, brake: -.5, unrelated: 3 },
      },
    });
    assert.deepEqual(frames[0]?.actions, { throttle: 1, brake: 0, unrelated: 3 });
  } finally {
    await host.stop();
  }
});

test("session host sends haptics as disposable realtime feedback", async () => {
  const transport = new MemoryTransport();
  const host = new SessionHost({
    gameId: "orbitalcrew",
    roles,
    transport,
    onFrame: () => {},
    deviceTimeoutMs: 60_000,
  });
  await host.start();
  try {
    transport.emit({
      channel: "control",
      payload: {
        type: "hello",
        version: PROTOCOL_VERSION,
        deviceId: "phone-1",
        device: "Phone",
        capabilities: { touch: true, haptics: true },
      },
    });
    transport.reliable.length = 0;

    assert.equal(host.haptic("pilot", "impact"), true);
    assert.deepEqual(transport.realtime, [{ type: "haptic", deviceId: "phone-1", pattern: "impact" }]);
    assert.deepEqual(transport.reliable, [], "late haptics must never queue on the reliable channel");
  } finally {
    await host.stop();
  }
});

test("session host negotiates binary input and sends speaker cues only to an audio-ready role", async () => {
  const transport = new MemoryTransport();
  const host = new SessionHost({
    gameId: "echomaze",
    roles: [{
      id: "scanner",
      label: "Scanner",
      playerId: "role-scanner",
      requiredCapabilities: ["touch"],
      layout: { layout: [
        { type: "joystick", action: "bearing" },
        { type: "button", action: "scan", label: "SCAN" },
      ] },
    }],
    transport,
    onFrame: () => {},
    deviceTimeoutMs: 60_000,
  });
  await host.start();
  try {
    transport.emit({
      channel: "control",
      payload: {
        type: "hello",
        version: PROTOCOL_VERSION,
        deviceId: "phone-audio",
        device: "Phone",
        capabilities: { touch: true, speaker: true },
        features: { inputFormats: ["input-q1"], speakerAudio: "locked" },
      },
    });
    const configuration = transport.reliable.find((message) => message.type === "controller.configure");
    assert.equal(configuration?.type === "controller.configure" && configuration.inputFormat, "input-q1",
      "a supported bounded layout should opt into the 24-byte input format");
    transport.realtime.length = 0;
    assert.equal(host.speakerCue("scanner", { pitch: 1.25, volume: .4 }), false,
      "autoplay-locked audio must fall back at the host instead of disappearing");
    assert.deepEqual(transport.realtime, []);

    transport.emit({
      channel: "control",
      payload: {
        type: "hello",
        version: PROTOCOL_VERSION,
        deviceId: "phone-audio",
        device: "Phone",
        capabilities: { touch: true, speaker: true },
        features: { inputFormats: ["input-q1"], speakerAudio: "ready" },
      },
    });
    transport.realtime.length = 0;
    assert.equal(host.speakerCue("scanner", { pitch: 1.25, volume: .4 }), true);
    assert.equal(host.speakerCue("scanner", { pitch: .8, volume: .2 }), true);
    assert.equal(transport.realtime.length, 2);
    const firstCue = requireSpeakerCue(transport.realtime[0]);
    const secondCue = requireSpeakerCue(transport.realtime[1]);
    assert.deepEqual({ ...firstCue, sequence: 0 },
      { type: "speaker.cue", deviceId: "phone-audio", sequence: 0, cue: "pulse-v1", pitch: 1.25, volume: .4 });
    assert.deepEqual({ ...secondCue, sequence: 0 },
      { type: "speaker.cue", deviceId: "phone-audio", sequence: 0, cue: "pulse-v1", pitch: .8, volume: .2 });
    assert.equal(secondCue.sequence, firstCue.sequence + 1,
    "cue sequences must remain monotonic so late realtime cannot replay after a role change");
  } finally {
    await host.stop();
  }
});

test("speaker cue sequences survive a game host remount", async () => {
  const emitOneCue = async () => {
    const transport = new MemoryTransport();
    const host = new SessionHost({
      gameId: "echomaze",
      roles: [{
        id: "scanner", label: "Scanner", playerId: "role-scanner", requiredCapabilities: ["touch"],
        layout: { layout: [{ type: "button", action: "scan", label: "SCAN" }] },
      }],
      transport,
      onFrame: () => {},
      now: () => 1_234,
      deviceTimeoutMs: 60_000,
    });
    await host.start();
    try {
      transport.emit({ channel: "control", payload: {
        type: "hello", version: PROTOCOL_VERSION, deviceId: "persistent-phone", device: "Phone",
        capabilities: { touch: true, speaker: true }, features: { speakerAudio: "ready" },
      } });
      assert.equal(host.speakerCue("scanner", { pitch: 1, volume: .5 }), true);
      return requireSpeakerCue(transport.realtime.at(-1)).sequence;
    } finally {
      await host.stop();
    }
  };

  const beforeRemount = await emitOneCue();
  const afterRemount = await emitOneCue();
  assert.ok(afterRemount > beforeRemount,
    "a controller page outlives React game hosts and must not reject every cue after restart as stale");
});

test("session host retargets a connected controller when the game changes without another hello", async () => {
  const transport = new MemoryTransport();
  const host = new SessionHost({ gameId: "first", roles, transport, onFrame: () => {}, deviceTimeoutMs: 60_000 });
  await host.start();
  transport.emit({
    channel: "control",
    payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone-1", device: "Phone", capabilities: { touch: true } },
  });
  transport.reliable.length = 0;

  host.setGame("second", [{
    id: "scanner",
    label: "Scanner",
    playerId: "role-scanner",
    layout: { layout: [{ type: "touch-surface", action: "scan" }] },
  }]);

  const assignment = transport.reliable.find((message) => message.type === "player.assign");
  const configuration = transport.reliable.find((message) => message.type === "controller.configure");
  assert.equal(assignment?.type === "player.assign" && assignment.gameId, "second");
  assert.equal(assignment?.type === "player.assign" && assignment.playerId, "role-scanner");
  assert.equal(configuration?.type === "controller.configure" && configuration.gameId, "second");
  assert.equal(configuration?.type === "controller.configure" && configuration.revision, 2);
  await host.stop();
});

test("session host places surplus controllers on explicit standby", async () => {
  const transport = new MemoryTransport();
  const host = new SessionHost({ gameId: "single", roles: [roles[1]!], transport, onFrame: () => {}, deviceTimeoutMs: 60_000 });
  await host.start();
  for (const id of ["phone-1", "phone-2"]) transport.emit({
    channel: "control",
    payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: id, device: "Phone", capabilities: { touch: true } },
  });
  const waits = transport.reliable.filter((message) => message.type === "player.wait");
  assert.ok(waits.some((message) => message.type === "player.wait" && message.deviceId === "phone-2" && message.gameId === "single"));
  await host.stop();
});

test("session host requests input eviction on role reset and heartbeat expiry", async () => {
  const transport = new MemoryTransport();
  const resets: string[] = [];
  let now = 100;
  const host = new SessionHost({
    gameId: "first",
    roles,
    transport,
    onFrame: () => {},
    onDeviceReset: (deviceId) => resets.push(deviceId),
    deviceTimeoutMs: 20,
    now: () => now,
  });
  await host.start();
  transport.emit({ channel: "control", payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });
  host.setGame("second", roles);
  assert.deepEqual(resets, ["phone"]);
  now = 200;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(resets, ["phone", "phone"]);
  await host.stop();
});

test("a controller that plays or pings is not expired out from under the player", async () => {
  // Liveness used to be refreshed only by `hello`. The browser client re-sends its handshake every
  // 1.6 s, so it survived by accident and every test passed; the native app sends `ping` instead
  // and was therefore expired six seconds after connecting, mid-game. Emulators never completed a
  // WebRTC connection, so no run ever reached the six-second mark to catch it.
  const transport = new MemoryTransport();
  const resets: string[] = [];
  let now = 100;
  const host = new SessionHost({
    gameId: "first",
    roles,
    transport,
    onFrame: () => {},
    onDeviceReset: (deviceId) => resets.push(deviceId),
    deviceTimeoutMs: 20,
    now: () => now,
  });
  await host.start();
  transport.emit({ channel: "control", payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });

  // Sending input is proof of life.
  now = 115;
  transport.emit({ channel: "realtime", payload: frame("phone", "player-1") });
  now = 130;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(resets, [], "a device that just sent input must not be expired");

  // So is a ping — which is also answered, so the controller can measure the round trip.
  now = 140;
  transport.emit({ channel: "control", payload: { type: "ping", sentAt: 5, deviceId: "phone" } });
  const pong = transport.reliable.find((message) => message.type === "pong");
  assert.ok(pong, "the host must answer a ping or controller latency stays unmeasurable");
  assert.equal(pong.sentAt, 5, "the pong echoes the original send time");

  now = 155;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(resets, [], "a device that just pinged must not be expired");

  // Silence still expires it.
  now = 400;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(resets, ["phone"], "a genuinely gone device is still reclaimed");
  await host.stop();
});

function frame(deviceId: string, playerId: string): InputFrame {
  return {
    deviceId,
    playerId,
    sequence: 1,
    timestamp: 1,
    source: "custom",
    actions: { fire: true },
  };
}

class MemoryTransport implements LinkTransport {
  readonly reliable: ControlMessage[] = [];
  readonly realtime: RealtimeMessage[] = [];
  private readonly listeners = new Set<(message: LinkMessage) => void>();

  async connect() {}
  async disconnect() {}
  sendReliable(message: ControlMessage) { this.reliable.push(message); }
  sendRealtime(message: RealtimeMessage) { this.realtime.push(message); }
  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  emit(message: LinkMessage) { this.listeners.forEach((listener) => listener(message)); }
}

function requireSpeakerCue(message: RealtimeMessage | undefined): SpeakerCueMessage {
  assert.ok(message && "type" in message && message.type === "speaker.cue");
  return message;
}
