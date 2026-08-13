import assert from "node:assert/strict";
import test from "node:test";
import { WATCH_PAYLOAD_BYTES, WATCH_PAYLOAD_MAGIC, WATCH_PAYLOAD_VERSION } from "@101/adapter-watch";
import type { InputFrame } from "@101/input";
import { WatchController, type WatchBridge, type WatchLinkSnapshot } from "./watch-controller.ts";

function payload(options: { flick?: boolean; tap?: boolean } = {}) {
  const bytes = new Uint8Array(WATCH_PAYLOAD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, WATCH_PAYLOAD_MAGIC);
  view.setUint8(1, WATCH_PAYLOAD_VERSION);
  view.setUint32(4, 100, true);
  view.setFloat32(20, 1, true); // identity quaternion
  if (options.flick) view.setFloat32(36, 600, true);
  view.setUint8(52, options.tap ? 1 : 0);
  return Buffer.from(bytes).toString("base64");
}

class FakeBridge implements WatchBridge {
  sampleListener?: (event: { data: string }) => void;
  linkListener?: (snapshot: WatchLinkSnapshot) => void;
  stopped = false;
  removed = 0;
  readonly snapshot: WatchLinkSnapshot;
  constructor(snapshot: WatchLinkSnapshot) { this.snapshot = snapshot; }
  isWatchSupported() { return true; }
  async startWatchRelay() { return this.snapshot; }
  async stopWatchRelay() { this.stopped = true; }
  async getWatchLinkState() { return this.snapshot; }
  addWatchSampleListener(listener: (event: { data: string }) => void) {
    this.sampleListener = listener;
    return { remove: () => { this.removed += 1; } };
  }
  addWatchLinkListener(listener: (snapshot: WatchLinkSnapshot) => void) {
    this.linkListener = listener;
    return { remove: () => { this.removed += 1; } };
  }
}

test("relayed watch payloads become semantic input frames under the phone's player", async () => {
  const bridge = new FakeBridge({ platform: "watchos", companionPaired: true, appInstalled: true, reachable: true });
  const frames: InputFrame[] = [];
  const controller = new WatchController(bridge, { onFrame: (frame) => frames.push(frame) });

  await controller.start("player-2");
  assert.equal(controller.strictlyLocal, true, "a reachable paired iPhone is a proven local route");

  bridge.sampleListener?.({ data: payload({ flick: true, tap: true }) });
  const frame = frames.at(-1);
  assert.equal(frame?.source, "watch-motion");
  assert.equal(frame?.playerId, "player-2", "wrist input joins the phone's own player, not a new one");
  assert.equal(frame?.actions["watch.flick"], true);
  assert.equal(frame?.actions["watch.tap"], true);
});

test("a Wear OS route that is merely connected is not reported as local", async () => {
  const bridge = new FakeBridge({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true, nearby: false });
  const controller = new WatchController(bridge, { onFrame: () => {} });
  const status = await controller.start("player-1");

  assert.equal(status.locality, "cloud-possible");
  assert.equal(controller.strictlyLocal, false);

  bridge.linkListener?.({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true, nearby: true });
  assert.equal(controller.strictlyLocal, true, "the route upgrades once the OS confirms the node is nearby");
});

test("a malformed payload is dropped and reported instead of breaking the controller", async () => {
  const bridge = new FakeBridge({ platform: "watchos", companionPaired: true, appInstalled: true, reachable: true });
  const frames: InputFrame[] = [];
  const errors: string[] = [];
  const controller = new WatchController(bridge, { onFrame: (frame) => frames.push(frame), onError: (message) => errors.push(message) });
  await controller.start("player-1");

  bridge.sampleListener?.({ data: "not base64 !!!" });
  bridge.sampleListener?.({ data: Buffer.from(new Uint8Array(4)).toString("base64") });
  assert.equal(controller.rejectedSamples, 2);
  assert.equal(errors.length, 1, "the operator is told once, not once per dropped packet");

  // The controller still works afterwards.
  bridge.sampleListener?.({ data: payload({ tap: true }) });
  assert.equal(frames.at(-1)?.actions["watch.tap"], true);
});

test("stopping releases wrist controls and detaches every listener", async () => {
  const bridge = new FakeBridge({ platform: "watchos", companionPaired: true, appInstalled: true, reachable: true });
  const frames: InputFrame[] = [];
  const controller = new WatchController(bridge, { onFrame: (frame) => frames.push(frame) });
  await controller.start("player-1");

  bridge.sampleListener?.({ data: payload({ flick: true }) });
  assert.equal(frames.at(-1)?.actions["watch.flick"], true);

  await controller.stop();
  assert.deepEqual(frames.at(-1)?.actions, {}, "a removed watch must not leave a flick applied");
  assert.equal(bridge.removed, 2, "both native subscriptions are detached");
  assert.equal(bridge.stopped, true);
});

test("losing the route mid-session releases held wrist input", async () => {
  const bridge = new FakeBridge({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true, nearby: true });
  const frames: InputFrame[] = [];
  const controller = new WatchController(bridge, { onFrame: (frame) => frames.push(frame) });
  await controller.start("player-1");

  bridge.sampleListener?.({ data: payload({ flick: true }) });
  bridge.linkListener?.({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: false, nearby: false });
  assert.deepEqual(frames.at(-1)?.actions, {}, "a watch walking out of range must not leave input held");
});
