import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/connect';
import type { AuthorizationRequest, DeviceRuntime } from '@101/connect';
import { loadTrustedProcessors } from './trusted-processors.ts';
import { createProcessorManagementTask } from './processor-management.ts';
import type { ManagementAction, ProcessorManagementTask, ManagementVersion } from './processor-management.ts';

function setup(extra: Parameters<typeof createProcessorManagementTask>[0] = {}) {
  let at = 1000;
  const effects: boolean[] = [];
  const task = createProcessorManagementTask({ now: () => at, onEffect: value => { effects.push(value); }, ...extra });
  return { task, effects, advance(amount = 100) { at += amount; }, setTime(value: number) { at = value; } };
}
async function accept(task: ProcessorManagementTask, action: ManagementAction, version?: ManagementVersion) {
  const request = task.review(action, version);
  assert.equal(request.ok, true, JSON.stringify(request));
  if (!request.ok) throw new Error('review not issued');
  if (action === 'activate-reviewed' || action === 'rollback-reviewed') {
    assert.equal(task.allowInput(request.value).ok, true); assert.equal(task.allowOutput(request.value).ok, true);
  }
  const result = await task.confirm(request.value);
  assert.equal(result.ok, true, JSON.stringify(result));
}
async function active(s: ReturnType<typeof setup>, version: ManagementVersion = '1.0.0') {
  assert.equal((await s.task.manage()).ok, true);
  await accept(s.task, 'install', version);
  await accept(s.task, 'activate-reviewed', version);
}
function send(s: ReturnType<typeof setup>, value: number) {
  s.advance();
  const sent = s.task.sendNumber(value);
  assert.equal(sent.ok, true, JSON.stringify(sent));
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// These tests exercise the real signed installer and public runtime, with page-only RAM.
// All supplied clocks/held callbacks are trusted software fixtures, not native devices.
test('arrival is inert; explicit management and install do not activate a factory or route', async () => {
  let loads = 0;
  const s = setup({ load: () => { loads++; return loadTrustedProcessors(); } });
  try {
    assert.equal(loads, 0);
    assert.equal(s.task.snapshot().phase, 'idle');
    assert.equal(s.task.snapshot().registrations, 0);
    assert.equal((await s.task.manage()).ok, true);
    assert.equal(loads, 1);
    await accept(s.task, 'install', '1.0.0');
    assert.deepEqual(s.task.snapshot().installed.map(item => item.version), ['1.0.0']);
    assert.equal(s.task.snapshot().activeVersion, undefined);
    assert.equal(s.task.snapshot().registrations, 0);
    assert.deepEqual(s.effects, []);
  } finally { await s.task.close(); }
});

test('real v1/v2 factories, update and explicit rollback have different threshold effects', async () => {
  const s = setup();
  try {
    await active(s);
    send(s, 30); send(s, 28);
    assert.deepEqual(s.effects, [true, false]);
    await accept(s.task, 'install', '2.0.0');
    assert.equal(s.task.snapshot().activeVersion, '1.0.0', 'installing does not switch live code');
    await accept(s.task, 'activate-reviewed', '2.0.0');
    send(s, 30); assert.deepEqual(s.effects, [true, false]);
    send(s, 31); send(s, 28); assert.deepEqual(s.effects, [true, false, true, false]);
    await accept(s.task, 'rollback-reviewed', '1.0.0');
    send(s, 30); assert.deepEqual(s.effects, [true, false, true, false, true]);
    assert.equal(s.task.snapshot().activeVersion, '1.0.0');
  } finally { await s.task.close(); }
});

test('decline retains current management, incumbent and indicator; forged or stale reviews refuse', async () => {
  const s = setup();
  try {
    await active(s); send(s, 30);
    const before = s.task.snapshot();
    const request = s.task.review('remove'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.equal(s.task.decline(request.value).ok, true);
    assert.equal(s.task.snapshot().managementUntil, before.managementUntil);
    assert.equal(s.task.snapshot().activeVersion, '1.0.0');
    assert.equal(s.task.snapshot().indicator, true);
    assert.equal((await s.task.confirm(request.value)).ok, false);
    assert.equal((await s.task.confirm(Object.freeze({ ...request.value }))).ok, false);
    send(s, 28); assert.deepEqual(s.effects, [true, false]);
  } finally { await s.task.close(); }
});

test('actual source content tamper is refused before install and activation', async () => {
  const s = setup({ load: async () => {
    const bundle = await loadTrustedProcessors();
    const first = bundle.versions[0]!;
    const source = first.trusted.source.slice(); source[0] = (source[0] ?? 0) ^ 1;
    return { ...bundle, versions: [{ ...first, trusted: { ...first.trusted, source } }, bundle.versions[1]!] };
  } });
  try {
    assert.equal((await s.task.manage()).ok, true);
    const request = s.task.review('install', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.deepEqual(await s.task.confirm(request.value), { ok: false, reason: 'integrity' });
    assert.deepEqual(s.task.snapshot().installed, []);
    assert.deepEqual(s.effects, []);
  } finally { await s.task.close(); }
});

test('source and output grants are separately denied by exact actual authorization requests', async () => {
  for (const denied of ['write', 'invoke'] as const) {
    const seen: AuthorizationRequest[] = [];
    const s = setup({ allowRoute: request => { seen.push(request); return request.sinkOperation !== denied; } });
    try {
      assert.equal((await s.task.manage()).ok, true); await accept(s.task, 'install', '1.0.0');
      const request = s.task.review('activate-reviewed', '1.0.0'); assert.equal(request.ok, true);
      if (!request.ok) throw new Error('review');
      assert.equal(s.task.allowInput(request.value).ok, true); assert.equal(s.task.allowOutput(request.value).ok, true);
      const result = await s.task.confirm(request.value);
      assert.equal(result.ok, false);
      assert.equal(seen.some(item => item.sinkOperation === denied), true);
      assert.equal(s.task.snapshot().activeVersion, undefined);
      assert.equal(s.task.snapshot().routes, 0); assert.equal(s.task.snapshot().registrations, 0);
      assert.deepEqual(s.effects, []);
    } finally { await s.task.close(); }
  }
});

test('failed candidate conformance retains genuine incumbent', async () => {
  const s = setup({ load: async () => {
    const bundle = await loadTrustedProcessors();
    const second = bundle.versions[1]!;
    return { ...bundle, versions: [bundle.versions[0]!, { ...second, fixture: {
      ...second.fixture, cases: [{ inputs: { temperature: 30 }, outputs: { switch: true } }],
    } }] };
  } });
  try {
    await active(s); send(s, 30); await accept(s.task, 'install', '2.0.0');
    const request = s.task.review('activate-reviewed', '2.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.equal(s.task.allowInput(request.value).ok, true); assert.equal(s.task.allowOutput(request.value).ok, true);
    assert.deepEqual(await s.task.confirm(request.value), { ok: false, reason: 'conformance' });
    assert.equal(s.task.snapshot().activeVersion, '1.0.0');
    send(s, 28); assert.deepEqual(s.effects, [true, false]);
  } finally { await s.task.close(); }
});

test('revocation and removal retire actual routes; revoke tombstones survive fresh management', async () => {
  const s = setup();
  try {
    await active(s); send(s, 30);
    await accept(s.task, 'revoke-release', '1.0.0');
    assert.equal(s.task.snapshot().activeVersion, undefined); assert.equal(s.task.snapshot().indicator, null);
    assert.equal(s.task.sendNumber(31).ok, false);
    s.task.stopManagement(); assert.equal((await s.task.manage()).ok, true);
    const request = s.task.review('install', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.deepEqual(await s.task.confirm(request.value), { ok: false, reason: 'revoked' });
    await accept(s.task, 'install', '2.0.0'); await accept(s.task, 'activate-reviewed', '2.0.0');
    send(s, 31); await accept(s.task, 'remove');
    assert.equal(s.task.snapshot().installed.length, 0);
    assert.equal(s.task.snapshot().activeVersion, undefined); assert.equal(s.task.sendNumber(31).ok, false);
    assert.deepEqual(s.effects, [true, true]);
  } finally { await s.task.close(); }
});

test('publisher revocation forbids both known signed versions without restoring trust', async () => {
  const s = setup();
  try {
    await active(s); await accept(s.task, 'revoke-publisher');
    const request = s.task.review('install', '2.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.deepEqual(await s.task.confirm(request.value), { ok: false, reason: 'revoked' });
    assert.equal(s.task.snapshot().publisherRevoked, true);
    assert.equal(s.task.snapshot().indicator, null);
  } finally { await s.task.close(); }
});

test('quiet current management expiry retires the live application before a caller snapshot', async () => {
  let notify = 0;
  const s = setup({ managementMs: 300, onChange: () => { notify++; } });
  try {
    await active(s); send(s, 30);
    s.setTime(1300);
    const notifiedBefore = notify;
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.equal(notify > notifiedBefore, true, 'quiet timer actually notifies before any status read');
    assert.equal(s.task.snapshot().phase, 'expired');
    assert.equal(s.task.snapshot().activeVersion, undefined);
    assert.equal(s.task.snapshot().indicator, null);
    assert.equal(s.task.snapshot().routes, 0);
  } finally { await s.task.close(); }
});

test('actual issued storage work stays busy after logical timeout; close awaits late returned work', async () => {
  const gate = held<void>(); let writes = 0;
  const s = setup({ beforeStorage: action => { if (action === 'write') { writes++; return gate.promise; } } });
  try {
    assert.equal((await s.task.manage()).ok, true);
    const request = s.task.review('install', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    const result = await s.task.confirm(request.value);
    assert.equal(result.ok, false); assert.equal(writes, 1);
    assert.equal(s.task.snapshot().rawPending > 0, true);
    assert.deepEqual(s.task.review('install', '2.0.0'), { ok: false, reason: 'busy' });
    const closed = s.task.close(); assert.equal(s.task.close(), closed);
    let done = false; void closed.then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    gate.resolve(); await closed;
    assert.equal(s.task.snapshot().rawPending, 0);
    assert.equal(s.task.snapshot().documentBytes, 0);
  } finally { gate.resolve(); await s.task.close(); }
});

test('held actual approval cannot write after Stop and later return; same close Promise settles', async () => {
  const gate = held<void>(); let entered = false;
  const s = setup({ beforeApprove: () => { entered = true; return gate.promise; } });
  try {
    assert.equal((await s.task.manage()).ok, true);
    const request = s.task.review('install', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    const result = s.task.confirm(request.value);
    for (let turns = 0; !entered && turns < 100; turns++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, true, 'The actual installer must reach the held approval');
    s.task.stopManagement();
    const closed = s.task.close(); let done = false; void closed.then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    gate.resolve(); assert.equal((await result).ok, false); await closed;
    assert.equal(s.task.snapshot().documentBytes, 0); assert.deepEqual(s.effects, []);
  } finally { gate.resolve(); await s.task.close(); }
});

test('reentrant real source registration Stop cleans the late genuine public handle exactly once', async () => {
  let returned: Parameters<DeviceRuntime['unregister']>[0] | undefined, removals = 0;
  const s = setup({ makeRuntime: options => {
    const runtime = createDeviceRuntime(options), original = runtime.registerSource.bind(runtime), unregister = runtime.unregister.bind(runtime);
    runtime.registerSource = provider => {
      task.stopManagement(); returned = original(provider); return returned;
    };
    runtime.unregister = handle => { if (handle === returned) removals++; return unregister(handle); };
    return runtime;
  } }); const task = s.task;
  try {
    assert.equal((await s.task.manage()).ok, true); await accept(s.task, 'install', '1.0.0');
    const request = s.task.review('activate-reviewed', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.equal(s.task.allowInput(request.value).ok, true); assert.equal(s.task.allowOutput(request.value).ok, true);
    assert.equal((await s.task.confirm(request.value)).ok, false);
    await s.task.close(); assert.equal(removals, 1);
    assert.equal(s.task.snapshot().registrations, 0); assert.equal(s.task.snapshot().routes, 0);
  } finally { await s.task.close(); }
});


test('installation and one-sided live approval do not grant the other runtime operation', async () => {
  const s = setup();
  try {
    assert.equal((await s.task.manage()).ok, true); await accept(s.task, 'install', '1.0.0');
    const request = s.task.review('activate-reviewed', '1.0.0'); assert.equal(request.ok, true);
    if (!request.ok) throw new Error('review');
    assert.equal(s.task.allowInput(request.value).ok, true);
    assert.deepEqual(await s.task.confirm(request.value), { ok: false, reason: 'denied' });
    assert.equal(s.task.snapshot().activeVersion, undefined); assert.equal(s.task.snapshot().registrations, 0);
    assert.equal(s.task.allowOutput(request.value).ok, true);
    assert.equal((await s.task.confirm(request.value)).ok, true);
    send(s, 30); assert.deepEqual(s.effects, [true]);
  } finally { await s.task.close(); }
});

test('actual returned indicator work and route settlement remain held after local Stop and close', async () => {
  const gate = held<void>(); let calls = 0;
  const s = setup({ onEffect: () => { calls++; return gate.promise; } });
  try {
    await active(s); send(s, 30);
    assert.equal(calls, 1); assert.equal(s.task.snapshot().indicator, true);
    assert.equal(s.task.snapshot().rawPending > 0, true);
    s.task.stopLive(); assert.equal(s.task.snapshot().indicator, null);
    assert.deepEqual(s.task.review('remove'), { ok: false, reason: 'busy' });
    const closed = s.task.close(); assert.equal(s.task.close(), closed);
    let settled = false; void closed.then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    gate.resolve(); await closed;
    const after = s.task.snapshot();
    assert.equal(after.rawPending, 0); assert.equal(after.routes, 0); assert.equal(after.registrations, 0);
    assert.equal(after.documentBytes, 0); assert.equal(after.indicator, null); assert.equal(after.effectCount, 1);
    assert.equal(calls, 1, 'Late settlement must not repeat the effect or restore authority');
  } finally { gate.resolve(); await s.task.close(); }
});

test('rapid real-clock inputs drain the final admitted latest number without another user action', async () => {
  const s = setup({ now: () => Math.floor(performance.now()) });
  try {
    await active(s);
    assert.equal(s.task.sendNumber(30).ok, true);
    assert.equal(s.task.snapshot().indicator, true);
    assert.equal(s.task.sendNumber(28).ok, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(s.task.snapshot().indicator, false, 'The admitted final number must not remain indefinitely queued');
    assert.deepEqual(s.effects, [true, false]);
  } finally { await s.task.close(); }
});


test('Stop retires an armed latest drain before a later timer callback can apply it', async () => {
  const s = setup({ now: () => Math.floor(performance.now()) });
  try {
    await active(s); s.task.sendNumber(30); s.task.sendNumber(28);
    assert.equal(s.task.snapshot().flushArmed, true);
    s.task.stopLive(); assert.equal(s.task.snapshot().flushArmed, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(s.effects, [true]); assert.equal(s.task.snapshot().indicator, null);
    await s.task.close(); assert.equal(s.task.snapshot().flushArmed, false);
    assert.equal(s.task.snapshot().timerArmed, false);
  } finally { await s.task.close(); }
});

test('Stop during a held genuine provision return stays stopped after the return settles', async () => {
  const provision = await loadTrustedProcessors(), gate = held<void>();
  const s = setup({ load: async () => { await gate.promise; return provision; } });
  const opening = s.task.manage();
  try {
    await Promise.resolve(); assert.equal(s.task.snapshot().phase, 'opening');
    s.task.stopManagement(); assert.equal(s.task.snapshot().phase, 'stopped');
    gate.resolve(); await opening;
    assert.equal(s.task.snapshot().phase, 'stopped', 'Late setup must preserve explicit Stop rather than relabel it as expiry');
    assert.equal(s.task.snapshot().reason, 'stopped'); assert.deepEqual(s.effects, []);
  } finally { gate.resolve(); await opening; await s.task.close(); }
});
