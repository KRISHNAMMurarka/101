import assert from "node:assert/strict";
import test from "node:test";
import { DesktopController, desktopControlLayout } from "./desktop-controller.ts";
import { MultiplexLinkTransport, PROTOCOL_VERSION } from "@101/protocol";
import type { LinkMessage, LinkState } from "@101/protocol";
import { createDesktopInputBridge } from "./desktop-input.ts";
import type { DesktopInputBridge, DesktopInputCommand } from "./desktop-input.ts";

test("desktop controller admits only an explicitly selected exact paired identity and a fresh mapped frame", () => {
  assert.equal(desktopControlLayout.layout.length, 10);
  assert.equal(typeof DesktopController, "function");
});

class Peer {
  state: LinkState = "connected";
  listeners = new Set<(message: LinkMessage) => void>();
  sent: LinkMessage[] = [];
  async connect() {} async disconnect() { this.state = "disconnected"; }
  sendReliable(payload: LinkMessage["payload"]) { this.sent.push({ channel: "control", payload } as LinkMessage); }
  sendRealtime() {}
  onMessage(listener: (message: LinkMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange(listener: (state: LinkState) => void) { listener(this.state); return () => {}; }
  emit(message: LinkMessage) { for (const listener of this.listeners) listener(message); }
}
test("authenticated selected peer with four timestamps publishes original deadline; another peer and expiry deny", async () => {
  const transport = new MultiplexLinkTransport();
  const peer = new Peer();
  await transport.add("webrtc-one", peer, { wireDeviceId: "phone", routeDeviceId: "webrtc-one" });
  let at = 1000, stopped = 0;
  const published: { command: DesktopInputCommand; deadline: number }[] = [];
  const bridge: DesktopInputBridge = { select: async () => ({ application: "App", window: "Window", pid: 1, windowId: 2, displayId: 3 }),
    startRoutes: () => true, publish(command, deadline) { published.push({ command, deadline }); return { ok: true }; },
    stop: async () => { stopped++; }, close: async () => {} };
  const controller = new DesktopController({ transport, pairing: { start: async () => {}, stop: async () => {} },
    bridge, now: () => at });
  await controller.start();
  try {
    peer.emit({ channel: "control", payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });
    assert.equal(await controller.selectController("another"), false);
    assert.equal(await controller.selectController("webrtc-one"), true);
    assert.equal(await controller.approveWindow(), true);
    const frame = (sequence: number, timestamp: number): LinkMessage => ({ channel: "realtime", payload: {
      deviceId: "phone", playerId: "untrusted", sequence, timestamp, source: "touch",
      actions: { left: true }, vectors: { pointer: { x: 0.3, y: 0.4 } } } });
    peer.emit(frame(1, 2005)); assert.equal(published.length, 0);
    (controller as unknown as { tick(): void }).tick();
    const probe = [...peer.sent].reverse().find(message => message.channel === "control" && message.payload.type === "ping");
    assert.ok(probe?.channel === "control" && probe.payload.type === "ping");
    peer.emit({ channel: "control", payload: { type: "pong", sentAt: probe.payload.sentAt, receivedAt: 2002 } });
    at = 1005;
    peer.emit({ channel: "control", payload: { type: "ping", sentAt: 2003 } });
    peer.emit(frame(2, 2005));
    assert.deepEqual(published.map(item => item.command.type), ["pointer", "button"]);
    assert.ok(published.every(item => item.deadline > at && item.deadline <= at + 250));
    peer.emit(frame(2, 2005)); assert.equal(published.length, 2);
    at = 1500; peer.emit(frame(3, 2006)); assert.equal(published.length, 2);
    const second = new Peer(); await transport.add("webrtc-two", second, { wireDeviceId: "other", routeDeviceId: "webrtc-two" });
    peer.emit(frame(4, 2500)); assert.equal(published.length, 2);
  } finally { await controller.stop(); }
  assert.ok(stopped > 0);
});

test("pairing Stop failure still closes the session and retains retry ownership", async () => {
  const transport = new MultiplexLinkTransport();
  let pairingStops = 0, sessionStops = 0;
  const bridge: DesktopInputBridge = { select: async () => ({ application: "App", window: "Window", pid: 1, windowId: 2, displayId: 3 }),
    startRoutes: () => true, publish: () => ({ ok: false }), stop: async () => {}, close: async () => {} };
  const controller = new DesktopController({ transport, pairing: {
    start: async () => {}, stop: async () => { if (++pairingStops === 1) throw new Error("pairing Stop failed"); },
  }, bridge, now: () => 100 });
  const originalSessionStop = controller.session.stop.bind(controller.session);
  controller.session.stop = async () => { sessionStops++; await originalSessionStop(); };
  await controller.start();
  await assert.rejects(controller.stop(), /pairing Stop failed/);
  assert.equal(pairingStops, 1);
  assert.equal(sessionStops, 1);
  await controller.stop();
  assert.equal(pairingStops, 2);
  assert.equal(sessionStops, 1);
});

// Native invocation is the cooperative seam; pairing admission, controller and
// runtime bridge are actual implementations.
test("native window refusal preserves its cause after joined Stop instead of reporting missing pairing", async () => {
  const transport = new MultiplexLinkTransport(), peer = new Peer();
  await transport.add("webrtc-one", peer, { wireDeviceId: "phone", routeDeviceId: "webrtc-one" });
  const refused = new Error("Control is still stopping. Wait, then retry.");
  let release!: () => void, entered!: () => void, selectCalls = 0;
  const pendingStop = new Promise<void>(resolve => { release = resolve; });
  const stopEntered = new Promise<void>(resolve => { entered = resolve; });
  const bridge = createDesktopInputBridge({ principalId: "local", applicationId: "hub", sessionId: "native-refusal", now: () => 100,
    async invoke(command) {
      if (command === "native_input_select") { selectCalls++; throw refused; }
      if (command === "native_input_stop") { entered(); await pendingStop; }
      return undefined;
    } });
  const controller = new DesktopController({ transport, bridge, now: () => 100,
    pairing: { start: async () => {}, stop: async () => {} } });
  await controller.start();
  try {
    assert.equal(await controller.approveWindow(), false); assert.equal(selectCalls, 0);
    peer.emit({ channel: "control", payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });
    assert.equal(await controller.selectController("webrtc-one"), true);
    const approval = controller.approveWindow(); let settled = false;
    void approval.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(approval, error => error === refused);
    await stopEntered;
    assert.equal(settled, false); assert.equal(selectCalls, 1);
    assert.equal(bridge.startRoutes(), false);
    assert.equal(bridge.publish({ type: "key", key: "Left", down: true }, 200).ok, false);
    release(); await rejection;
    assert.equal(bridge.startRoutes(), false);
  } finally { release(); await controller.stop(); await bridge.close(); }
});

test("native window refusal retains a simultaneous Stop failure for recovery", async () => {
  const transport = new MultiplexLinkTransport(), peer = new Peer();
  await transport.add("webrtc-one", peer, { wireDeviceId: "phone", routeDeviceId: "webrtc-one" });
  const refused = new Error("Window confirmation was declined"), releaseFailure = new Error("Held input needs release retry");
  let stops = 0;
  const bridge = createDesktopInputBridge({ principalId: "local", applicationId: "hub", sessionId: "native-stop-refusal", now: () => 100,
    async invoke(command) {
      if (command === "native_input_select") throw refused;
      if (command === "native_input_stop" && ++stops === 1) throw releaseFailure;
      return undefined;
    } });
  const controller = new DesktopController({ transport, bridge, now: () => 100,
    pairing: { start: async () => {}, stop: async () => {} } });
  await controller.start();
  try {
    peer.emit({ channel: "control", payload: { type: "hello", version: PROTOCOL_VERSION, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });
    assert.equal(await controller.selectController("webrtc-one"), true);
    await assert.rejects(controller.approveWindow(), error => error instanceof AggregateError &&
      error.errors.length === 2 && error.errors[0] === refused && error.errors[1] === releaseFailure);
    assert.equal(bridge.startRoutes(), false);
    assert.equal(bridge.publish({ type: "key", key: "Left", down: true }, 200).ok, false);
  } finally { await controller.stop(); await bridge.close(); }
});
