import assert from "node:assert/strict";
import test from "node:test";
import type { InputFrame } from "@101/input";
import {
  WATCH_PAYLOAD_BYTES,
  WATCH_PAYLOAD_MAGIC,
  WATCH_PAYLOAD_VERSION,
  WatchCrownTracker,
  WatchGestureRecognizer,
  WatchInputAdapter,
  decodeWatchPayload,
  describeWatchTransport,
  isStrictlyLocal,
} from "./index.ts";

const LEVEL = [0, 0, 0, 1] as const;

test("Wear OS locality is never claimed without a nearby node", () => {
  const connectedButFar = describeWatchTransport({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true, nearby: false });
  assert.equal(connectedButFar.locality, "cloud-possible");
  assert.equal(connectedButFar.transport, "unknown");
  assert.equal(isStrictlyLocal(connectedButFar), false);
  assert.match(connectedButFar.note, /may route/);

  const nearby = describeWatchTransport({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true, nearby: true });
  assert.equal(nearby.locality, "verified-local");
  assert.equal(nearby.transport, "bluetooth");
  assert.equal(isStrictlyLocal(nearby), true);

  // An absent nearby signal is unproven, not permission to assume the optimistic answer.
  const unknownProximity = describeWatchTransport({ platform: "wearos", companionPaired: true, appInstalled: true, reachable: true });
  assert.equal(unknownProximity.locality, "cloud-possible");
});

test("watchOS reports device-to-device only once the watch app is reachable", () => {
  assert.equal(describeWatchTransport({ platform: "watchos", companionPaired: false, appInstalled: false, reachable: false }).locality, "unknown");
  assert.equal(describeWatchTransport({ platform: "watchos", companionPaired: true, appInstalled: false, reachable: false }).locality, "unknown");
  assert.equal(describeWatchTransport({ platform: "watchos", companionPaired: true, appInstalled: true, reachable: false }).locality, "unknown");

  const live = describeWatchTransport({ platform: "watchos", companionPaired: true, appInstalled: true, reachable: true });
  assert.equal(live.locality, "verified-local");
  assert.equal(live.transport, "bluetooth");
  assert.equal(isStrictlyLocal(live), true);
});

test("wrist raise and lower use hysteresis so a resting arm cannot chatter", () => {
  const recognizer = new WatchGestureRecognizer();
  const still = { acceleration: [0, 0, 0], angularVelocity: [0, 0, 0] } as const;
  // Rotation of theta about X is [sin(theta/2), 0, 0, cos(theta/2)]; thresholds are 35 and 20 degrees.
  const pitchPose = (degrees: number) => [Math.sin((degrees * Math.PI) / 360), 0, 0, Math.cos((degrees * Math.PI) / 360)] as const;
  const raisedPose = pitchPose(45);
  const midPose = pitchPose(25);
  const lowPose = pitchPose(0);

  assert.equal(recognizer.update({ timestamp: 0, orientation: lowPose, ...still }).raise, false);
  assert.equal(recognizer.update({ timestamp: 100, orientation: raisedPose, ...still }).raise, true, "crossing the raise threshold reports once");
  assert.equal(recognizer.update({ timestamp: 200, orientation: raisedPose, ...still }).raise, false, "holding raised must not repeat the edge");

  // 25 degrees sits between the lower (20) and raise (35) thresholds: still raised, no event.
  const between = recognizer.update({ timestamp: 300, orientation: midPose, ...still });
  assert.equal(between.lower, false, "the dead band must not report a lower event");
  assert.equal(recognizer.wristRaised, true);

  assert.equal(recognizer.update({ timestamp: 400, orientation: lowPose, ...still }).lower, true);
  assert.equal(recognizer.wristRaised, false);
});

test("wrist gestures are edge-triggered and respect their cooldown", () => {
  const recognizer = new WatchGestureRecognizer();
  const fast = { orientation: LEVEL, acceleration: [0, 0, 0], angularVelocity: [400, 0, 0] } as const;
  assert.equal(recognizer.update({ timestamp: 0, ...fast }).flick, true);
  assert.equal(recognizer.update({ timestamp: 50, ...fast }).flick, false, "a continuing motion must not retrigger inside the cooldown");
  assert.equal(recognizer.update({ timestamp: 400, ...fast }).flick, true);

  // A flick already covers this motion, so twist must not double-report the same event.
  assert.equal(recognizer.update({ timestamp: 800, ...fast }).twist, false);

  const twisting = { orientation: LEVEL, acceleration: [0, 0, 0], angularVelocity: [250, 0, 0] } as const;
  assert.equal(recognizer.update({ timestamp: 2000, ...twisting }).twist, true, "a deliberate slower rotation reports as twist");

  const strike = { orientation: LEVEL, acceleration: [0, 3, 0], angularVelocity: [0, 0, 0] } as const;
  assert.equal(recognizer.update({ timestamp: 3000, ...strike }).strike, true);
  assert.equal(recognizer.update({ timestamp: 3100, ...strike }).strike, false);
});

test("crown travel becomes a bounded dial without a spurious first delta", () => {
  const crown = new WatchCrownTracker(24);
  assert.deepEqual(crown.update(5000), { crown: 0, crownDelta: 0 }, "the first sample establishes the origin");
  assert.deepEqual(crown.update(5012), { crown: 0.5, crownDelta: 0.5 });
  assert.deepEqual(crown.update(5024), { crown: 1, crownDelta: 0.5 });
  assert.deepEqual(crown.update(5060), { crown: 1, crownDelta: 1 }, "the dial saturates rather than growing without bound");
  // The overshoot past saturation must be discarded, not stored: a small reversal has to move the
  // dial immediately instead of first unwinding travel the user can no longer see.
  assert.equal(crown.update(5048).crown, 0.5, "reversing responds at once rather than unwinding");
  // A watch with no crown, or a sample that omits it, reports no movement and holds the dial
  // where the user left it rather than snapping it back to centre.
  assert.deepEqual(crown.update(undefined), { crown: 0.5, crownDelta: 0 });
  assert.deepEqual(new WatchCrownTracker().update(undefined), { crown: 0, crownDelta: 0 });
});

test("the adapter emits watch-motion frames and releases them when the route drops", () => {
  const frames: InputFrame[] = [];
  const statuses: string[] = [];
  const adapter = new WatchInputAdapter({ platform: "wearos", onStatus: (status) => statuses.push(status.locality) });
  adapter.start((frame) => frames.push(frame));

  adapter.updateLink({ companionPaired: true, appInstalled: true, reachable: true, nearby: true });
  assert.deepEqual(statuses, ["verified-local"]);

  const frame = adapter.push({ timestamp: 10, orientation: LEVEL, acceleration: [0, 3, 0], angularVelocity: [400, 0, 0], crown: 100, tap: true });
  assert.equal(frame?.source, "watch-motion");
  assert.equal(frame?.actions["watch.flick"], true);
  assert.equal(frame?.actions["watch.tap"], true);
  assert.equal(frame?.axes?.crown, 0, "the first crown sample only establishes the origin");
  assert.ok(frame?.vectors?.wrist, "wrist orientation is available as a vector");

  adapter.updateLink({ companionPaired: true, appInstalled: true, reachable: false, nearby: false });
  assert.deepEqual(frames.at(-1)?.actions, {}, "losing the route must not leave a wrist action held");

  adapter.stop();
  assert.deepEqual(frames.at(-1)?.actions, {}, "stopping releases as well");
  assert.equal(adapter.push({ timestamp: 20, orientation: LEVEL, acceleration: [0, 0, 0], angularVelocity: [0, 0, 0] }), undefined, "a stopped adapter emits nothing");
});

test("the wire format decodes the exact bytes both watch apps produce", () => {
  // This buffer is the contract between three independent implementations: Swift on watchOS,
  // Kotlin on Wear OS, and this decoder. Its sibling tests assert the same offsets, so a change
  // on any one platform fails here instead of silently producing garbage wrist input.
  const bytes = new Uint8Array(WATCH_PAYLOAD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, WATCH_PAYLOAD_MAGIC);
  view.setUint8(1, WATCH_PAYLOAD_VERSION);
  view.setUint16(2, 4321, true);
  view.setUint32(4, 1_234_567, true);
  view.setFloat32(8, 0.1, true);
  view.setFloat32(12, -0.2, true);
  view.setFloat32(16, 0.3, true);
  view.setFloat32(20, 1, true);
  view.setFloat32(24, 0.5, true);
  view.setFloat32(28, -1.25, true);
  view.setFloat32(32, 0.125, true);
  view.setFloat32(36, 120.5, true);
  view.setFloat32(40, -45.25, true);
  view.setFloat32(44, 8, true);
  view.setFloat32(48, 42.5, true);
  view.setUint8(52, 1);

  // Quaternion w = 1.0f is 00 00 80 3F little-endian; both watch suites pin the same four bytes.
  assert.deepEqual([...bytes.slice(20, 24)], [0x00, 0x00, 0x80, 0x3f]);

  const sample = decodeWatchPayload(bytes);
  assert.equal(sample?.timestamp, 1_234_567);
  assert.equal(sample?.orientation[3], 1);
  assert.equal(sample?.acceleration[1], -1.25);
  assert.equal(sample?.angularVelocity[0], 120.5);
  assert.equal(sample?.crown, 42.5);
  assert.equal(sample?.tap, true);

  assert.equal(decodeWatchPayload(new Uint8Array(0)), undefined);
  assert.equal(decodeWatchPayload(new Uint8Array(WATCH_PAYLOAD_BYTES)), undefined, "a zeroed buffer has no magic byte");
  const wrongVersion = bytes.slice();
  wrongVersion[1] = 99;
  assert.equal(decodeWatchPayload(wrongVersion), undefined, "an unknown protocol version is rejected");
  const poisoned = bytes.slice();
  new DataView(poisoned.buffer).setFloat32(8, Number.NaN, true);
  assert.equal(decodeWatchPayload(poisoned), undefined, "a non-finite quaternion never reaches the motion pipeline");
});

test("a decoded watch payload drives the adapter end to end", () => {
  const adapter = new WatchInputAdapter({ platform: "watchos" });
  adapter.start(() => {});
  adapter.updateLink({ companionPaired: true, appInstalled: true, reachable: true });

  const bytes = new Uint8Array(WATCH_PAYLOAD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, WATCH_PAYLOAD_MAGIC);
  view.setUint8(1, WATCH_PAYLOAD_VERSION);
  view.setUint32(4, 40, true);
  view.setFloat32(20, 1, true);
  view.setFloat32(36, 500, true);
  view.setUint8(52, 1);

  const sample = decodeWatchPayload(bytes);
  assert.ok(sample);
  const frame = adapter.push(sample);
  assert.equal(frame?.source, "watch-motion");
  assert.equal(frame?.actions["watch.flick"], true, "a fast relayed rotation becomes a semantic flick");
  assert.equal(frame?.actions["watch.tap"], true);
});

test("a watch adapter never reports raw health or identity data", () => {
  const adapter = new WatchInputAdapter({ platform: "watchos" });
  adapter.start(() => {});
  const frame = adapter.push({ timestamp: 5, orientation: LEVEL, acceleration: [0, 0, 0], angularVelocity: [0, 0, 0] });
  const keys = [...Object.keys(frame?.actions ?? {}), ...Object.keys(frame?.axes ?? {}), ...Object.keys(frame?.vectors ?? {})];
  for (const forbidden of ["heart", "hr", "bpm", "health", "workout", "calories", "user", "name", "serial"]) {
    assert.equal(keys.some((key) => key.toLowerCase().includes(forbidden)), false, `watch frames must not carry ${forbidden} data`);
  }
});
