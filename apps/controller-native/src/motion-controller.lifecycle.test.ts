import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const availability = deferred<boolean>();
  const listeners: Array<{ callback: (measurement: unknown) => void; removed: boolean }> = [];
  let availabilityCalls = 0;
  let failRemoval = false;
  const hooks = { beforeAdd: () => {} };
  const platform = { OS: "android" };
  const sensors = {
    isAvailableAsync() { availabilityCalls++; return availability.promise; },
    requestPermissionsAsync: async () => ({ granted: true }),
    setUpdateInterval() {},
    addListener(callback: (measurement: unknown) => void) {
      hooks.beforeAdd();
      const entry = { callback, removed: false };
      listeners.push(entry);
      return { remove() { if (failRemoval) throw new Error("native removal failed"); entry.removed = true; } };
    },
  };
  const source = readFileSync(new URL("./motion-controller.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  class Pipeline {
    calibration = { neutral: [0, 0, 0, 1], sensitivity: 1 };
    process(sample: unknown) { return sample; }
    reset() {}
    calibrateNeutral(sample: unknown) { this.calibration.neutral = (sample as { orientation: number[] }).orientation; }
    setSensitivity() {}
    setDeadZone() {}
  }
  const modules: Record<string, unknown> = {
    "react-native": { Platform: platform },
    "expo-sensors": { DeviceMotion: sensors },
    "./motion-axes": { expoAngularVelocity: () => [0, 0, 0] },
    "@101/motion": {
      MotionPipeline: Pipeline,
      MotionGestureRecognizer: class { update() { return {}; } reset() {} },
      quaternionFromDeviceOrientation: () => [0, 0, 0, 1],
      quaternionToAngles: () => ({ roll: 0, pitch: 0, yaw: 0 }),
    },
  };
  runInNewContext(compiled, { exports, require(name: string) { assert.ok(name in modules); return modules[name]; }, Date, Math, Error });
  const Controller = exports.NativeMotionController as new (emit: (value: unknown) => void) => {
    start(): Promise<boolean>; stop(): void; readonly active: boolean; calibrateNeutral(): void;
  };
  const emitted: unknown[] = [];
  const controller = new Controller(value => emitted.push(value));
  return { controller, availability, listeners, emitted, availabilityCalls: () => availabilityCalls,
    hooks, platform, sensors, createController: () => new Controller(value => emitted.push(value)),
    failRemoval(value: boolean) { failRemoval = value; } };
}

test("concurrent starts reserve one listener, and Stop invalidates pending starts", { timeout: 3_000 }, async () => {
  const f = fixture();
  const first = f.controller.start(), second = f.controller.start();
  await Promise.resolve();
  assert.equal(f.availabilityCalls(), 1);
  f.controller.stop();
  f.availability.resolve(true);
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(f.listeners.length, 0);
  assert.equal(f.controller.active, false);
});

test("a retired callback cannot publish or supply a stale calibration sample", { timeout: 3_000 }, async () => {
  const f = fixture();
  const starting = f.controller.start(); f.availability.resolve(true);
  assert.equal(await starting, true);
  const listener = f.listeners[0]!;
  listener.callback({ rotation: { alpha: 0, beta: 0, gamma: 0, timestamp: 1 }, acceleration: { x: 0, y: 0, z: 1 } });
  assert.equal(f.emitted.length, 1);
  f.controller.stop();
  listener.callback({ rotation: { alpha: 0, beta: 0, gamma: 0, timestamp: 2 }, acceleration: { x: 0, y: 0, z: 1 } });
  assert.equal(f.emitted.length, 1);
  assert.throws(() => f.controller.calibrateNeutral(), /Start motion sensing/);
});

test("a fresh start after Stop may recover while an older permission wait is pending", { timeout: 3_000 }, async () => {
  const f = fixture();
  const oldStart = f.controller.start();
  f.controller.stop();
  const freshStart = f.controller.start();
  f.availability.resolve(true);
  assert.equal(await oldStart, false);
  assert.equal(await freshStart, true);
  assert.equal(f.listeners.length, 1);
  assert.equal(f.controller.active, true);
  f.controller.stop();
});

test("failed native removal retains the old handle and blocks replacement", { timeout: 3_000 }, async () => {
  const f = fixture();
  const starting = f.controller.start(); f.availability.resolve(true);
  assert.equal(await starting, true);
  f.failRemoval(true);
  f.controller.stop();
  assert.equal(f.controller.active, false);
  await assert.rejects(f.controller.start(), /could not be removed/);
  assert.equal(f.listeners.length, 1);
  f.failRemoval(false);
  assert.equal(await f.controller.start(), true);
  assert.equal(f.listeners[0]!.removed, true);
  assert.equal(f.listeners.length, 2);
  f.controller.stop();
});

test("stale listener cleanup preserves a fresh reentrant start", { timeout: 3_000 }, async () => {
  const f = fixture();
  let fresh!: Promise<boolean>;
  f.hooks.beforeAdd = () => {
    f.hooks.beforeAdd = () => {};
    f.controller.stop();
    fresh = f.controller.start();
  };
  const old = f.controller.start(); f.availability.resolve(true);
  assert.equal(await old, false);
  assert.equal(await fresh, true);
  assert.equal(f.listeners.length, 2);
  assert.equal(f.listeners[0]!.removed, true);
  assert.equal(f.controller.active, true);
  f.controller.stop();
});

test("Stop before the opening turn issues no availability call", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); f.controller.stop();
  f.availability.resolve(true);
  assert.equal(await opening, false);
  assert.equal(f.availabilityCalls(), 0);
});

test("retired availability and permission errors resolve without stale errors", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); await Promise.resolve();
  assert.equal(f.availabilityCalls(), 1);
  f.controller.stop(); f.availability.reject(new Error("retired availability"));
  assert.equal(await opening, false);

  const ios = fixture(), permission = deferred<{ granted: boolean }>(), entered = deferred<void>();
  ios.platform.OS = "ios";
  ios.sensors.requestPermissionsAsync = () => { entered.resolve(); return permission.promise; };
  const asking = ios.controller.start(); ios.availability.resolve(true);
  await entered.promise;
  ios.controller.stop(); permission.reject(new Error("retired permission"));
  assert.equal(await asking, false);
});

test("replacement controller retains and retries failed unmount cleanup", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); f.availability.resolve(true);
  assert.equal(await opening, true);
  f.failRemoval(true); f.controller.stop();
  const replacement = f.createController();
  await assert.rejects(replacement.start(), /could not be removed/);
  assert.equal(f.listeners.length, 1);
  f.failRemoval(false);
  assert.equal(await replacement.start(), true);
  assert.equal(f.listeners.length, 2);
  assert.equal(f.listeners[0]!.removed, true);
  f.listeners[0]!.callback({ rotation: { timestamp: 1 } });
  assert.equal(f.emitted.length, 0);
  replacement.stop();
});

test("another controller cannot replace an active sensor owner", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); f.availability.resolve(true);
  assert.equal(await opening, true);
  const replacement = f.createController();
  await assert.rejects(replacement.start(), /already in use/);
  assert.equal(f.listeners.length, 1);
  assert.equal(f.controller.active, true);
  f.controller.stop();
});

test("another controller cannot take an owned pending sensor start", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); await Promise.resolve();
  const replacement = f.createController();
  const replacing = replacement.start();
  f.availability.resolve(true);
  await assert.rejects(replacing, /already in use/);
  assert.equal(await opening, true);
  assert.equal(f.listeners.length, 1);
  f.controller.stop();
});

test("current sensor errors and permission denial remain visible", { timeout: 3_000 }, async () => {
  const f = fixture();
  const opening = f.controller.start(); await Promise.resolve();
  f.availability.reject(new Error("current availability failed"));
  await assert.rejects(opening, /current availability failed/);
  const replacement = f.createController();
  await assert.rejects(replacement.start(), /current availability failed/);

  const ios = fixture(); ios.platform.OS = "ios";
  ios.sensors.requestPermissionsAsync = async () => ({ granted: false });
  const asking = ios.controller.start(); ios.availability.resolve(true);
  await assert.rejects(asking, /permission was not granted/);
  assert.equal(ios.listeners.length, 0);
});
