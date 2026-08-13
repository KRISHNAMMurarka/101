import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeMotionPacket,
  deserializeControlMessage,
  encodeMotionPacket,
  decodePairingDescription,
  encodePairingDescription,
  parseControllerLayout,
  MultiplexLinkTransport,
  createControllerPairingUrl,
  decodePairingTicket,
  encodePairingTicket,
  serializeControlMessage,
  type LinkMessage,
  type LinkTransport,
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
  assert.equal(await multiplex.remove("phone"), true);
  assert.equal(second.connected, false);
  multiplex.sendReliable({ type: "ping", sentAt: 3 });
  assert.equal(first.reliable, 2);
  assert.equal(second.reliable, 2);
});

class MemoryTransport implements LinkTransport {
  connected = false;
  reliable = 0;
  private listener?: (message: LinkMessage) => void;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  sendReliable() { this.reliable += 1; }
  sendRealtime() {}
  onMessage(callback: (message: LinkMessage) => void) { this.listener = callback; return () => { this.listener = undefined; }; }
  emit(message: LinkMessage) { this.listener?.(message); }
}
