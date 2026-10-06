import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { registerHooks } from 'node:module';
import type { ImpactFeedbackStyle, NotificationFeedbackType } from 'expo-haptics';

registerHooks({ resolve(specifier, context, next) {
  const packages = { '@101/connect': 'connect', '@101/device-model': 'device-model', '@101/device-runtime': 'device-runtime' };
  const selected = packages[specifier as keyof typeof packages];
  if (selected) return { shortCircuit: true, url: new URL(`../../../packages/${selected}/src/index.ts`, import.meta.url).href };
  return next(specifier, context);
} });

// The actual App callback is extracted because the Node test runner cannot load React Native TSX.
// Only the unavailable native bridge is replaced; this is callback evidence, never hardware proof.
async function appCallback() {
  const path = process.env.HAPTIC_OLD_APP_PATH ?? new URL('../App.tsx', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'haptic' && node.initializer && ts.isCallExpression(node.initializer))
      callback = node.initializer.arguments[0]?.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(callback, 'the current native App must have its actual haptic callback');
  const enums = ts.transpileModule(readFileSync(new URL('../../../node_modules/expo-haptics/src/Haptics.types.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = await import(`data:text/javascript,${encodeURIComponent(enums)}`);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const invoke = () => { calls++; return held; };
  const port = { selectionAsync: invoke, impactAsync: invoke, notificationAsync: invoke,
    ImpactFeedbackStyle: values.ImpactFeedbackStyle, NotificationFeedbackType: values.NotificationFeedbackType };
  let haptics: unknown;
  if (existsSync(new URL('./controller-haptics.ts', import.meta.url))) {
    const helper = await import('./controller-haptics.ts');
    haptics = helper.createControllerHaptics(port, { now: () => 1000 });
    (haptics as { setActive(value: boolean): void }).setActive(true);
  }
  const javascript = ts.transpileModule(`const appHaptic = (${callback});`,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function('Haptics', 'haptics', `${javascript}\nreturn appHaptic;`)(port, haptics) as (pattern: 'tap' | 'impact' | 'warning') => Promise<unknown>;
  return { run, calls: () => calls, release, close: () => (haptics as { close(): void } | undefined)?.close() };
}

test('the actual native App callback admits one held Expo invocation', async () => {
  const app = await appCallback();
  const first = app.run('tap');
  const second = app.run('impact');
  try { assert.equal(app.calls(), 1, 'a second held API invocation must be dropped'); }
  finally { app.release(); await Promise.all([first, second]); app.close(); }
});

async function nativeFixture() {
  const { createControllerHaptics } = await import('./controller-haptics.ts');
  let time = 1000;
  const calls: string[] = [];
  let next: () => Promise<void> = async () => undefined;
  const port = {
    selectionAsync() { calls.push('selection'); return next(); },
    impactAsync(style: string) { calls.push(`impact:${style}`); return next(); },
    notificationAsync(type: string) { calls.push(`notification:${type}`); return next(); },
    ImpactFeedbackStyle: { Heavy: 'heavy' as ImpactFeedbackStyle.Heavy }, NotificationFeedbackType: { Warning: 'warning' as NotificationFeedbackType.Warning },
  };
  const controller = createControllerHaptics(port, { now: () => time });
  return { controller, port, calls, time(value: number) { time = value; }, next(value: () => Promise<void>) { next = value; } };
}

test('native feedback maps exact installed preset arguments and drops background feedback', async () => {
  const f = await nativeFixture();
  try {
    assert.equal(await f.controller.play('tap'), 'cancelled'); assert.deepEqual(f.calls, []);
    f.controller.setActive(true);
    assert.equal(await f.controller.play('tap'), 'api-returned'); f.time(1100);
    assert.equal(await f.controller.play('impact'), 'api-returned'); f.time(1200);
    assert.equal(await f.controller.play('warning'), 'api-returned');
    assert.deepEqual(f.calls, ['selection', 'impact:heavy', 'notification:warning']);
    f.controller.setActive(false); assert.equal(await f.controller.play('tap'), 'cancelled');
    assert.equal(f.calls.length, 3);
  } finally { f.controller.close(); }
});

test('native rejection is handled and close fences late completion without pretending to cancel hardware', async () => {
  const f = await nativeFixture();
  let resolve!: () => void;
  try {
    f.controller.setActive(true); f.next(() => Promise.reject(Error('private bridge error')));
    assert.equal(await f.controller.play('tap'), 'api-rejected');
    f.time(1100); f.next(() => new Promise<void>(done => { resolve = done; }));
    const pending = f.controller.play('warning'); f.controller.close();
    assert.equal(await pending, 'cancelled'); resolve(); await Promise.resolve();
    assert.equal(await f.controller.play('impact'), 'cancelled'); assert.equal(f.calls.length, 2);
    assert.equal(f.controller.backend.profileId, 'app:expo-haptic-presets/1');
  } finally { resolve?.(); f.controller.close(); }
});

test('legacy cancel retains the physical API reservation until the issued promise settles', async () => {
  const f = await nativeFixture(); let resolve!: () => void;
  try {
    f.controller.setActive(true); f.next(() => new Promise<void>(done => { resolve = done; }));
    const pending = f.controller.play('tap'); f.controller.cancel();
    assert.equal(await pending, 'cancelled'); f.time(1100);
    assert.equal(await f.controller.play('impact'), 'busy'); assert.equal(f.calls.length, 1);
    resolve(); await Promise.resolve(); await Promise.resolve();
  } finally { resolve?.(); f.controller.close(); }
});

test('SDK backend and legacy callback share the actual native invocation reservation', async () => {
  const f = await nativeFixture(); let release!: () => void;
  try {
    f.controller.setActive(true); f.next(() => new Promise<void>(done => { release = done; }));
    const legacy = f.controller.play('tap');
    const sdk = f.controller.backend.invoke('impact');
    try { assert.equal(f.calls.length, 1, 'mixed entry points must not issue two Expo requests'); }
    finally { release(); await Promise.all([legacy, sdk]); }
    f.time(1100);
    const issued = f.controller.backend.invoke('warning');
    assert.equal(await f.controller.play('tap'), 'busy'); release(); await issued;
    assert.equal(f.calls.length, 2);
  } finally { release?.(); f.controller.close(); }
});

test('replacement helper retains the same native port reservation until the original invocation settles', async () => {
  const { createControllerHaptics } = await import('./controller-haptics.ts');
  for (const failed of [false, true]) {
    const f = await nativeFixture();
    let release!: () => void;
    const replacement = createControllerHaptics(f.port, { now: () => 1100 });
    try {
      f.controller.setActive(true);
      f.next(() => new Promise<void>((resolve, reject) => { release = () => failed ? reject(Error('private native failure')) : resolve(); }));
      const original = f.controller.play('tap');
      f.controller.close();
      assert.equal(await original, 'cancelled');
      replacement.setActive(true);
      assert.equal(await replacement.play('impact'), 'busy');
      assert.equal(await replacement.backend.invoke('warning'), 'busy');
      assert.equal(f.calls.length, 1, 'helper replacement must not issue another unsettled Expo request');
      release();
      await Promise.resolve(); await Promise.resolve();
      f.next(async () => undefined);
      assert.equal(await replacement.play('impact'), 'api-returned', 'actual native settlement releases the shared reservation');
      assert.equal(f.calls.length, 2);
    } finally { release?.(); f.controller.close(); replacement.close(); }
  }
});

test('the exposed native backend needs active lifetime and stays inert after close', async () => {
  const f = await nativeFixture();
  try {
    assert.equal(await f.controller.backend.invoke('tap'), 'unavailable'); assert.equal(f.calls.length, 0);
    f.controller.setActive(true); assert.equal(await f.controller.backend.invoke('tap'), 'api-returned');
    f.controller.setActive(false); assert.equal(await f.controller.backend.invoke('impact'), 'unavailable');
    f.controller.close(); f.controller.setActive(true);
    assert.equal(await f.controller.backend.invoke('warning'), 'unavailable'); assert.equal(f.calls.length, 1);
  } finally { f.controller.close(); }
});

test('background retirement fences an issued SDK callback but holds the shared reservation until native return', async () => {
  const f = await nativeFixture(); let release!: () => void;
  try {
    f.controller.setActive(true); f.next(() => new Promise<void>(done => { release = done; }));
    const issued = f.controller.backend.invoke('warning'); f.controller.setActive(false);
    assert.equal(await issued, 'cancelled');
    f.controller.setActive(true); f.time(1100);
    assert.equal(await f.controller.play('tap'), 'busy');
    assert.equal(await f.controller.backend.invoke('impact'), 'busy'); assert.equal(f.calls.length, 1);
    release(); await Promise.resolve(); await Promise.resolve();
    f.controller.close(); assert.equal(await f.controller.backend.invoke('tap'), 'unavailable');
    assert.equal(f.calls.length, 1);
  } finally { release?.(); f.controller.close(); }
});

test('native burst limits, missing methods and invalid monotonic clock cause no invented feedback', async () => {
  const f = await nativeFixture();
  try {
    f.controller.setActive(true); await f.controller.play('tap');
    assert.equal(await f.controller.play('tap'), 'rate-limited');
    f.time(999); assert.equal(await f.controller.play('tap'), 'cancelled');
    f.time(1200); assert.equal(await f.controller.play('tap'), 'cancelled'); assert.equal(f.calls.length, 1);
  } finally { f.controller.close(); }
});
