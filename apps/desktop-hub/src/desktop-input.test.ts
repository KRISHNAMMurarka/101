import assert from "node:assert/strict";
import test from "node:test";
import { NativeDeadlineMap, createDesktopInputBridge } from "./desktop-input.ts";

test("remote clock maps an original deadline conservatively and never renews it", () => {
  const map = new NativeDeadlineMap({ nativeNowNs: "1000000000", sentAtMs: 100, receivedAtMs: 120 });
  assert.equal(map.deadlineNs(200), "1058950000");
  assert.equal(map.deadlineNs(119), undefined);
  assert.equal(map.deadlineNs(120), undefined);
});

test("Stop during the last clock callback prevents a native event invoke", async () => {
  const calls: string[] = [];
  const at = 100;
  let arm = 0;
  const bridge = createDesktopInputBridge({
    invoke: async command => { calls.push(command); if (command === "native_input_select") return {
      token: "01234567-89ab-4cde-8f01-23456789abcd",
      target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } };
      if (command === "native_input_clock") { arm = 2; return { nativeNowNs: "1000000000" }; } return undefined; },
    now: () => { if (arm > 0 && --arm === 0) void bridge.stop(); return at; },
    principalId: "local", applicationId: "hub", sessionId: "one",
    authorizeRoute: () => ({ expiresAt: 1000, maxAgeMs: 500 }),
  });
  await bridge.select(); assert.equal(bridge.startRoutes(), true);
  bridge.publish({ type: "key", key: "Left", down: true }, 200);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(calls.includes("native_input_event"), false);
  await bridge.close();
});

test("concurrent Stop joins settlement and a new select cannot overtake it", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const bridge = createDesktopInputBridge({ invoke: async command => {
    calls.push(command); if (command === "native_input_stop") await pending;
    if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd",
      target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } }; return undefined; },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one" });
  await bridge.select();
  const first = bridge.stop(), second = bridge.stop();
  assert.equal(first, second);
  const fresh = bridge.select();
  await Promise.resolve();
  assert.equal(calls.filter(value => value === "native_input_select").length, 1);
  release(); await first; await fresh;
  assert.equal(calls.filter(value => value === "native_input_select").length, 2);
  await bridge.close();
});

test("synchronous route release joins the first Stop instead of issuing a second native Stop", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const bridge = createDesktopInputBridge({
    invoke: async command => {
      calls.push(command);
      if (command === "native_input_stop") await pending;
      if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd",
        target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } };
      return undefined;
    },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
    authorizeRoute: () => ({ expiresAt: 1000, maxAgeMs: 500 }),
  });
  await bridge.select();
  assert.equal(bridge.startRoutes(), true);
  const first = bridge.stop();
  assert.equal(bridge.stop(), first);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.filter(command => command === "native_input_stop").length, 1);
  release();
  await first;
  await bridge.close();
});

test("a new selection releases the prior lease before requesting fresh native approval", async () => {
  const calls: string[] = [];
  const bridge = createDesktopInputBridge({
    invoke: async command => {
      calls.push(command);
      if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd",
        target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } };
      return undefined;
    },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
  });
  await bridge.select();
  await bridge.select();
  assert.deepEqual(calls, ["native_input_select", "native_input_stop", "native_input_select"]);
  await bridge.close();
});

test("Stop fences a pending native selection before another selection can begin", async () => {
  let resolveSelection!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { resolveSelection = resolve; });
  const calls: string[] = [];
  const bridge = createDesktopInputBridge({
    invoke: async command => {
      calls.push(command);
      if (command === "native_input_select" && calls.filter(value => value === command).length === 1) return pending;
      if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd",
        target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } };
      return undefined;
    },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
  });
  const first = bridge.select();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(calls.filter(command => command === "native_input_select").length, 1);
  const stopped = bridge.stop();
  await assert.rejects(bridge.select(), /progress|pending|stopping|cancelled/i);
  assert.equal(calls.filter(command => command === "native_input_select").length, 1);
  resolveSelection({ token: "01234567-89ab-4cde-8f01-23456789abcd",
    target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } });
  await assert.rejects(first, /cancelled/i);
  await stopped;
  await bridge.select();
  assert.equal(calls.filter(command => command === "native_input_select").length, 2);
  await bridge.close();
});

test("Stop called inside native selection waits for that selection to settle", async () => {
  let resolveSelection!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { resolveSelection = resolve; });
  let stopped: Promise<void> | undefined;
  const bridge = createDesktopInputBridge({
    invoke: async command => {
      if (command === "native_input_select") { stopped = bridge.stop(); return pending; }
      return undefined;
    },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
  });
  const selecting = bridge.select();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.ok(stopped);
  let settled = false;
  void stopped.then(() => { settled = true; });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(settled, false);
  resolveSelection({ token: "01234567-89ab-4cde-8f01-23456789abcd",
    target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } });
  await assert.rejects(selecting, /cancelled/i);
  await stopped;
  await bridge.close();
});

test("failed native Stop still joins selection and repeated close preserves the failure", async () => {
  let resolveSelection!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { resolveSelection = resolve; });
  let stopCalls = 0, selecting = false;
  const bridge = createDesktopInputBridge({
    invoke: async command => {
      if (command === "native_input_select") { selecting = true; return pending; }
      if (command === "native_input_stop" && ++stopCalls === 1) throw new Error("first native Stop failed");
      return undefined;
    },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
  });
  const selection = bridge.select();
  const cancelled = assert.rejects(selection, /cancelled/i);
  for (let i = 0; i < 8 && !selecting; i++) await Promise.resolve();
  assert.equal(selecting, true);
  const firstClose = bridge.close();
  const firstFailure = assert.rejects(firstClose, /first native Stop failed/);
  let settled = false;
  void firstClose.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(settled, false);
  resolveSelection({ token: "01234567-89ab-4cde-8f01-23456789abcd",
    target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } });
  await cancelled; await firstFailure;
  assert.equal(stopCalls, 2);
  await assert.rejects(bridge.close(), /first native Stop failed/);
  await bridge.stop();
  await bridge.close();
});

test("runtime route authorization is independent of native approval token", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const bridge = createDesktopInputBridge({
    invoke: async (command, args) => { calls.push([command, args]); if (command === "native_input_clock") return { nativeNowNs: "1000000000" };
      if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd", target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } }; return undefined; },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
  });
  await bridge.select();
  assert.equal(bridge.publish({ type: "key", key: "Left", down: true }, 200).ok, false);
  assert.equal(calls.some(([name]) => name === "native_input_event"), false);
  await bridge.close();
});

test("approved runtime route carries an original bounded deadline to native sink", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const bridge = createDesktopInputBridge({
    invoke: async (command, args) => { calls.push({ command, args });
      if (command === "native_input_select") return { token: "01234567-89ab-4cde-8f01-23456789abcd",
        target: { application: "App", window: "Window", pid: 41, windowId: 7, displayId: 1 } };
      if (command === "native_input_clock") return { nativeNowNs: "1000000000" }; return undefined; },
    now: () => 100, principalId: "local", applicationId: "hub", sessionId: "one",
    authorizeRoute: request => request.principalId === "local" && request.sinkOperation === "invoke"
      ? { expiresAt: 1000, maxAgeMs: 500 } : undefined,
  });
  await bridge.select();
  assert.equal(bridge.startRoutes(), true);
  assert.deepEqual(bridge.publish({ type: "key", key: "Left", down: true }, 200), { ok: true });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const issued = calls.find(call => call.command === "native_input_event");
  assert.equal((issued?.args?.event as { key: string })?.key, "Left");
  assert.equal(issued?.args?.deadlineNs, "1098950000");
  assert.equal(calls.filter(call => call.command === "native_input_event").length, 1);
  await bridge.stop(); await bridge.close();
});
