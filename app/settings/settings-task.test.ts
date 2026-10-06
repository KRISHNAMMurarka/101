import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerDataController, createSettingsStore } from '@101/connect';
import type { OwnerDataStorage } from '@101/connect';
import { createSettingsStorageSession, createSettingsTask, createSettingsThemePreview, SETTINGS_OWNER, SETTINGS_LIMITS } from './settings-task.ts';

// Cooperative atomic storage exercises the real public producers. Native IDB is
// qualified separately by the owned browser caller, never by this fixture.
function memory() {
  let value: unknown, reads = 0, beforeCommit: (() => Promise<void>) | undefined;
  const storage: OwnerDataStorage = {
    async transact(_owner, mutation, guard) {
      reads++;
      if (guard?.signal.aborted || guard && !guard.isCurrent()) throw Error('refused');
      const next = mutation(structuredClone(value));
      await beforeCommit?.();
      if (guard?.signal.aborted || guard && !guard.isCurrent() || guard?.signal.aborted) throw Error('refused');
      value = structuredClone(next.state); return next.result;
    },
  };
  return { storage, read: () => value, reads: () => reads,
    hold: (callback?: () => Promise<void>) => { beforeCommit = callback; } };
}
function fixture() {
  const data = memory(); let time = 1000, factories = 0, closes = 0;
  const task = createSettingsTask({ now: () => time, createStorage: () => {
    factories++; return { storage: data.storage, async close() { closes++; } };
  } });
  return { data, task, setTime: (value: number) => { time = value; }, factories: () => factories, closes: () => closes };
}
async function writer(storage: OwnerDataStorage, time = 1000) {
  const owner = createOwnerDataController({ ownerId: SETTINGS_OWNER, storage, trustedNow: () => time,
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  const opened = await owner.openStores({ retireOwned() {} }); assert.equal(opened.ok, true);
  if (!opened.ok) throw Error('fixture');
  const store = createSettingsStore({ ownerId: SETTINGS_OWNER, storage: opened.value.settings, availableDevices: () => [] });
  return { store, close() { opened.value.close(); owner.close(); } };
}

test('arrival and a declined management request do not open storage', async () => {
  const f = fixture(); assert.equal(f.factories(), 0); assert.equal(f.data.reads(), 0);
  const review = f.task.review('manage'); assert.ok(review);
  await f.task.decide(review, false);
  assert.equal(f.factories(), 0); assert.equal(f.task.snapshot().active, false); await f.task.close();
});

test('declined mutation reviews preserve the current draft and lease without writes', async () => {
  const f = fixture();
  try {
    await f.task.decide(f.task.review('manage')!, true); f.task.chooseTheme('dark');
    const current = f.task.snapshot(), stored = structuredClone(f.data.read()), calls = f.data.reads();
    for (const action of ['save', 'reset', 'delete'] as const) {
      const token = f.task.review(action); assert.ok(token, `${action} review is available`);
      await f.task.decide(token, false);
      const after = f.task.snapshot();
      assert.equal(after.active, true, `${action} decline retains current management`);
      assert.equal(after.deadline, current.deadline, `${action} decline does not replace or extend the lease`);
      assert.equal(after.revision, current.revision);
      assert.equal(after.theme, 'dark', `${action} decline retains the unsaved appearance draft`);
      assert.equal(after.review, undefined); assert.equal(after.pending, false);
      assert.equal(f.factories(), 1); assert.equal(f.closes(), 0);
      assert.equal(f.data.reads(), calls, `${action} decline issues no storage transaction`);
      assert.deepEqual(f.data.read(), stored, `${action} decline preserves actual producer bytes and deletion state`);
    }
  } finally { await f.task.close(); }
});

test('actual SettingsStore save and new management load preserve unexposed choices', async () => {
  const f = fixture(), seed = await writer(f.data.storage);
  assert.equal((await seed.store.save(0, { preferences: { theme: 'system', handedness: 'left', motion: 'reduce' }, profiles: [] })).ok, true);
  seed.close();
  await f.task.decide(f.task.review('manage')!, true); assert.equal(f.task.snapshot().theme, 'system');
  f.task.chooseTheme('dark'); await f.task.decide(f.task.review('save')!, true);
  assert.equal(f.task.snapshot().message, 'saved');
  const inspect = await writer(f.data.storage), loaded = await inspect.store.load();
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.value.preferences, { theme: 'dark', handedness: 'left', motion: 'reduce' });
  inspect.close(); await f.task.decide(f.task.review('reset')!, true);
  const resetReader = await writer(f.data.storage), reset = await resetReader.store.load();
  assert.equal(reset.ok, true);
  if (reset.ok) assert.deepEqual(reset.value.preferences, { theme: 'system', handedness: 'left', motion: 'reduce' });
  resetReader.close(); await f.task.close(); assert.equal(f.closes(), 1);
});

test('a concurrent real producer revision requires reload and fresh review', async () => {
  const f = fixture(); await f.task.decide(f.task.review('manage')!, true);
  const review = f.task.review('save')!, other = await writer(f.data.storage);
  assert.equal((await other.store.save(0, { preferences: { theme: 'light', handedness: 'right', motion: 'system' }, profiles: [] })).ok, true);
  other.close(); await f.task.decide(review, true);
  assert.equal(f.task.snapshot().message, 'conflict');
  await f.task.reload(); assert.equal(f.task.snapshot().theme, 'light'); await f.task.close();
});

test('review identity and absolute management expiry cannot be extended by interaction', async () => {
  const f = fixture(); await f.task.decide(f.task.review('manage')!, true);
  const review = f.task.review('save')!; f.setTime(1000 + SETTINGS_LIMITS.managementMs);
  await f.task.decide(review, true);
  assert.equal(f.task.snapshot().active, false); assert.equal(f.task.snapshot().message, 'expired');
  assert.equal((f.data.read() as { records: { settings?: string } }).records.settings, undefined);
  await f.task.close();
});

test('stop during a real producer transaction fences its late commit and close waits', async () => {
  const f = fixture(); await f.task.decide(f.task.review('manage')!, true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.data.hold(async () => { entered(); await gate; });
  const save = f.task.decide(f.task.review('save')!, true); await started;
  f.task.stop(); let closed = false; const closing = f.task.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.task.snapshot().active, false);
  release(); await save; await closing;
  assert.equal((f.data.read() as { records: { settings?: string } }).records.settings, undefined);
});

test('late storage factory returns are retired exactly once and retain the raw slot', async () => {
  const data = memory(); let resolve!: (value: { storage: OwnerDataStorage; close(): Promise<void> }) => void;
  let release!: () => void, closes = 0;
  const factory = new Promise<{ storage: OwnerDataStorage; close(): Promise<void> }>(done => { resolve = done; });
  const heldClose = new Promise<void>(done => { release = done; });
  const task = createSettingsTask({ now: () => 1000, createStorage: () => factory });
  const start = task.decide(task.review('manage')!, true); await Promise.resolve();
  task.stop(); const first = task.close(), second = task.close(); assert.equal(first, second);
  resolve({ storage: data.storage, async close() { closes++; await heldClose; } });
  await Promise.resolve(); assert.equal(task.snapshot().pending, true); assert.equal(data.reads(), 0);
  release(); await start; await first; assert.equal(closes, 1);
});

test('reentrant observer retirement occurs before the storage factory call', async () => {
  let factories = 0;
  const task = createSettingsTask({ now: () => 1000, createStorage() { factories++; throw Error('unexpected'); },
    onChange: state => { if (state.pending) task.stop(); } });
  await task.decide(task.review('manage')!, true);
  assert.equal(factories, 0); await task.close();
});

test('settings-only managed deletion keeps the redacted audit and fences old ports', async () => {
  const f = fixture(); await f.task.decide(f.task.review('manage')!, true);
  f.task.chooseTheme('dark'); await f.task.decide(f.task.review('save')!, true);
  await f.task.decide(f.task.review('delete')!, true);
  assert.equal(f.task.snapshot().message, 'pending-deletion');
  await f.task.decide(f.task.review('resume-delete')!, true);
  const envelope = f.data.read() as { epoch: number; records: { settings?: string }; audit: { kinds: string[]; state: string }[] };
  assert.equal(envelope.records.settings, undefined); assert.equal(envelope.epoch, 2);
  assert.deepEqual(envelope.audit[0]?.kinds, ['settings']); assert.equal(envelope.audit[0]?.state, 'completed');
  assert.equal(f.task.snapshot().active, false); await f.task.close();
});

test('reentrant current-clock retirement cannot publish or commit saved choices', async () => {
  const data = memory(); let armed = false;
  const task = createSettingsTask({ now() { if (armed) task.stop(); return 1000; },
    createStorage: () => ({ storage: data.storage, async close() {} }) });
  await task.decide(task.review('manage')!, true);
  const review = task.review('save')!; armed = true; await task.decide(review, true);
  assert.equal(task.snapshot().active, false);
  assert.equal((data.read() as { records: { settings?: string } }).records.settings, undefined); await task.close();
});

test('a clock Stop during fresh admission also fences the previously stopped state', async () => {
  let armed = false, factories = 0;
  const task = createSettingsTask({ now() { if (armed) task.stop(); return 1000; },
    createStorage() { factories++; throw Error('unexpected'); } });
  task.stop(); armed = true; assert.equal(task.review('manage'), undefined);
  assert.equal(factories, 0); await task.close();
});

test('a blocked adapter promise cannot release the actual open or realm session reservation', async () => {
  // Explicit software request interception, not native IndexedDB evidence.
  const request = new EventTarget() as IDBOpenDBRequest;
  let closes = 0, calls = 0;
  Object.defineProperty(request, 'result', { value: { close() { closes++; }, objectStoreNames: { length: 1, contains: () => true } } });
  const factory = { open() { calls++; return request; } } as unknown as IDBFactory;
  const session = createSettingsStorageSession(factory);
  const operation = session.storage.transact(SETTINGS_OWNER, () => ({ state: undefined, result: 1 }));
  request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
  await assert.rejects(operation);
  let closed = false; const first = session.close(), second = session.close(); assert.equal(first, second);
  void first.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  assert.throws(() => createSettingsStorageSession(factory)); assert.equal(calls, 1);
  request.dispatchEvent(new Event('success')); request.onsuccess?.call(request, new Event('success'));
  await first; assert.equal(closed, true); assert.ok(closes >= 1);
  const next = createSettingsStorageSession(factory); await next.close();
});

test('owned theme restore retains a competing owner change', () => {
  let attribute: string | null = null;
  const element = { getAttribute: () => attribute, setAttribute(_name: string, value: string) { attribute = value; }, removeAttribute() { attribute = null; } };
  const preview = createSettingsThemePreview(element); preview.apply('dark'); attribute = 'light'; preview.restore();
  assert.equal(attribute, 'light');
  const next = createSettingsThemePreview(element); next.apply('system'); next.restore(); assert.equal(attribute, 'light');
});

test('managed future and foreign headers remain untouched; valid private headers allow reviewed preference recovery', async () => {
  const f = fixture(); await f.task.decide(f.task.review('manage')!, true);
  await f.task.decide(f.task.review('save')!, true); f.task.stop();
  await f.task.close();
  const data = f.data;
  async function inject(owner: string, version: number, corruptPreference = false) {
    await data.storage.transact(SETTINGS_OWNER, raw => {
      const value = raw as { records: { settings: string } };
      const original = JSON.parse(value.records.settings) as { version: number; ownerId: string; revision: number; preferences: { theme: string } };
      const document = { ...original, version, ownerId: owner, revision: 7,
        preferences: { ...original.preferences, theme: corruptPreference ? 'invalid-theme' : 'system' } };
      value.records.settings = JSON.stringify(document); return { state: value, result: undefined };
    });
  }
  for (const scenario of [{ owner: SETTINGS_OWNER, version: 99, reason: 'incompatible' },
    { owner: 'different-owner', version: 2, reason: 'wrong-owner' }]) {
    await inject(scenario.owner, scenario.version); const before = structuredClone(data.read());
    const refused = createSettingsTask({ now: () => 1000, createStorage: () => ({ storage: data.storage, async close() {} }) });
    try {
      await refused.decide(refused.review('manage')!, true); assert.equal(refused.snapshot().message, scenario.reason);
      assert.equal(refused.snapshot().active, false); assert.equal(refused.snapshot().canReset, false); assert.equal(refused.snapshot().canDelete, false);
      assert.equal(refused.review('reset'), undefined); assert.equal(refused.review('delete'), undefined);
      assert.deepEqual(data.read(), before, 'Rejected producer headers do not open authority or mutate managed bytes');
    } finally { await refused.close(); }
  }
  await inject(SETTINGS_OWNER, 2, true);
  const repaired = createSettingsTask({ now: () => 1000, createStorage: () => ({ storage: data.storage, async close() {} }) });
  try {
    await repaired.decide(repaired.review('manage')!, true); assert.equal(repaired.snapshot().message, 'corrupt');
    assert.equal(repaired.snapshot().active, true); assert.equal(repaired.snapshot().canReset, true);
    await repaired.decide(repaired.review('reset')!, true); assert.equal(repaired.snapshot().message, 'reset');
    const choices = JSON.parse((data.read() as { records: { settings: string } }).records.settings);
    assert.equal(choices.version, 2); assert.equal(choices.ownerId, SETTINGS_OWNER); assert.equal(choices.revision, 8);
    assert.deepEqual(choices.preferences, { theme: 'system', handedness: 'right', motion: 'system' });
  } finally { await repaired.close(); }
});
