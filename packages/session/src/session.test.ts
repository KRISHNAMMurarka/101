import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type LinkMessage,
  type LinkTransport,
  type RealtimeMessage,
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
