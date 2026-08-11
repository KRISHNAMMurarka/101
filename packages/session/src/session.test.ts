import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type LinkMessage,
  type LinkTransport,
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
  private readonly listeners = new Set<(message: LinkMessage) => void>();

  async connect() {}
  async disconnect() {}
  sendReliable(message: ControlMessage) { this.reliable.push(message); }
  sendRealtime() {}
  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  emit(message: LinkMessage) { this.listeners.forEach((listener) => listener(message)); }
}
