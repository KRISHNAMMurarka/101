import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsStore, type SettingsStorage } from './settings-store.ts';

function storage() {
  const records = new Map<string, string>();
  let failWrite = false;
  const port: SettingsStorage = {
    async read(key) { return records.get(key); },
    async compareAndSwap(key, expected, value) {
      if (failWrite) throw new Error('private backend detail');
      if (records.get(key) !== expected) return false;
      records.set(key, value); return true;
    },
  };
  return { port, records, failWrites() { failWrite = true; } };
}
const preferences = { theme: 'dark', handedness: 'left', motion: 'reduce' };
const profile = { id: 'desk', deviceId: 'sensor', profileId: 'example:scalar', profileRevision: 1,
  calibration: { scale: 2, offset: -1 } };

test('fresh owner settings persist choices across a new store instance, without route authority', async () => {
  const disk = storage();
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => ['sensor'] });
  const fresh = await store.load(); assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(fresh.status, 'fresh'); assert.equal(fresh.value.revision, 0);
  assert.deepEqual(fresh.value.preferences, { theme: 'system', handedness: 'right', motion: 'system' });
  assert.equal((await store.save(0, { preferences, profiles: [profile] })).ok, true);
  const reloaded = await createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => ['sensor'] }).load();
  assert.equal(reloaded.ok, true);
  if (reloaded.ok) {
    assert.equal(reloaded.value.revision, 1); assert.deepEqual(reloaded.value.profiles, [profile]);
    assert.equal(Object.hasOwn(reloaded.value, 'grants'), false); assert.ok(Object.isFrozen(reloaded.value.profiles[0]));
  }
});

test('declared v1 preference records migrate atomically while unknown future formats are preserved', async () => {
  const disk = storage();
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => ['sensor'] });
  const key = store.key;
  disk.records.set(key, JSON.stringify({ version: 1, ownerId: 'alice', revision: 4,
    preferences: { theme: 'dark', handedness: 'left' }, profiles: [profile] }));
  const migrated = await store.load(); assert.equal(migrated.ok, true);
  if (migrated.ok) {
    assert.equal(migrated.status, 'migrated'); assert.equal(migrated.value.revision, 5);
    assert.deepEqual(migrated.value.preferences, { theme: 'dark', handedness: 'left', motion: 'system' });
    assert.equal(JSON.parse(disk.records.get(key)!).version, 2);
  }
  const future = JSON.stringify({ version: 3, ownerId: 'alice', revision: 6, secret: 'not returned' });
  disk.records.set(key, future);
  assert.deepEqual(await store.load(), { ok: false, reason: 'incompatible' });
  assert.equal(disk.records.get(key), future);
});

test('corrupt, foreign and rolled-back records fail closed without exposing or silently overwriting data', async () => {
  const disk = storage();
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => ['sensor'] });
  disk.records.set(store.key, '{private malformed');
  assert.deepEqual(await store.load(), { ok: false, reason: 'corrupt' });
  assert.equal(disk.records.get(store.key), '{private malformed');
  assert.equal((await store.reset()).ok, true);
  const old = disk.records.get(store.key)!;
  const ready = await store.load(); assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal((await store.save(ready.value.revision, { preferences, profiles: [] })).ok, true);
  disk.records.set(store.key, old);
  assert.deepEqual(await store.load(), { ok: false, reason: 'rollback' });
  const afterRestart = createSettingsStore({ ownerId: 'alice', storage: disk.port, minimumRevision: ready.value.revision + 1,
    availableDevices: () => [] });
  assert.deepEqual(await afterRestart.load(), { ok: false, reason: 'rollback' });
  disk.records.set(store.key, JSON.stringify({ version: 2, ownerId: 'bob', revision: 10, preferences, profiles: [] }));
  assert.deepEqual(await store.load(), { ok: false, reason: 'wrong-owner' });
  const bob = createSettingsStore({ ownerId: 'bob', storage: disk.port, availableDevices: () => [] });
  assert.notEqual(store.key, bob.key); assert.equal((await bob.load()).ok, true);
});

test('removed-device profiles are pruned and old choices never restore grants', async () => {
  const disk = storage(); let devices = ['sensor'];
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => devices });
  await store.save(0, { preferences, profiles: [profile] });
  devices = [];
  const pruned = await store.load(); assert.equal(pruned.ok, true);
  if (pruned.ok) { assert.equal(pruned.status, 'pruned'); assert.equal(pruned.value.revision, 2); assert.deepEqual(pruned.value.profiles, []); }
  devices = ['sensor'];
  assert.equal((await store.save(2, { preferences, profiles: [profile] })).ok, true);
  assert.equal((await store.removeDevice('sensor')).ok, true);
  const after = await store.load(); if (after.ok) assert.deepEqual(after.value.profiles, []); else assert.fail(after.reason);
  assert.deepEqual(await store.save(4, { preferences, profiles: [], grants: [{ expiresAt: 9999 }] }), { ok: false, reason: 'invalid' });
});

test('compare-and-swap prevents lost concurrent updates and write failure retains accepted version', async () => {
  const disk = storage();
  const a = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => [] });
  const b = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => [] });
  const outcomes = await Promise.all([a.save(0, { preferences, profiles: [] }), b.save(0, { preferences, profiles: [] })]);
  assert.equal(outcomes.filter(x => x.ok).length, 1);
  assert.equal(outcomes.filter(x => !x.ok && x.reason === 'conflict').length, 1);
  const accepted = disk.records.get(a.key); disk.failWrites();
  assert.deepEqual(await a.save(1, { preferences: { ...preferences, theme: 'light' }, profiles: [] }), { ok: false, reason: 'unavailable' });
  assert.equal(disk.records.get(a.key), accepted);
});

test('unbounded, malformed, executable and unsupported profile settings cannot enter persistence', async () => {
  const disk = storage();
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => ['sensor'] });
  let evaluated = false;
  const getter = { get theme() { evaluated = true; return 'dark'; }, handedness: 'left', motion: 'system' };
  for (const settings of [
    { preferences: getter, profiles: [] }, { preferences, profiles: [{ ...profile, token: 'secret' }] },
    { preferences, profiles: [{ ...profile, calibration: { scale: NaN, offset: 0 } }] },
    { preferences, profiles: [{ ...profile, profileRevision: 0 }] },
    { preferences, profiles: Array.from({ length: 9 }, (_, i) => ({ ...profile, id: String(i) })) },
    { preferences, profiles: [{ ...profile, deviceId: 'absent' }] },
  ]) assert.deepEqual(await store.save(0, settings), { ok: false, reason: 'invalid' });
  assert.equal(evaluated, false); assert.equal(disk.records.size, 0);
});

test('backend and inventory failures are unavailable, including TypeError without private messages', async () => {
  const disk = storage();
  const broken = async () => { throw new TypeError('private backend detail'); };
  const reader = createSettingsStore({ ownerId: 'alice', storage: { ...disk.port, read: broken }, availableDevices: () => [] });
  assert.deepEqual(await reader.load(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await reader.reset(), { ok: false, reason: 'unavailable' });
  const writer = createSettingsStore({ ownerId: 'alice', storage: { ...disk.port, compareAndSwap: broken }, availableDevices: () => [] });
  assert.deepEqual(await writer.save(0, { preferences, profiles: [] }), { ok: false, reason: 'unavailable' });
  const inventory = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices() { throw new TypeError('private inventory'); } });
  assert.deepEqual(await inventory.load(), { ok: false, reason: 'unavailable' });
});

test('reset preserves foreign rows and advances valid saved revisions across a fresh process', async () => {
  const disk = storage();
  const store = createSettingsStore({ ownerId: 'alice', storage: disk.port, availableDevices: () => [] });
  const foreign = JSON.stringify({ version: 2, ownerId: 'bob', revision: 20, preferences, profiles: [] });
  disk.records.set(store.key, foreign);
  assert.deepEqual(await store.reset(), { ok: false, reason: 'wrong-owner' });
  assert.equal(disk.records.get(store.key), foreign);
  disk.records.set(store.key, JSON.stringify({ version: 2, ownerId: 'alice', revision: 20, preferences, profiles: [] }));
  const reset = await store.reset(); assert.equal(reset.ok, true);
  if (reset.ok) assert.equal(reset.value.revision, 21);
});

test('a schema-valid oversized envelope is rejected before writing an unreadable row', async () => {
  const disk = storage(), ownerId = 'o'.repeat(128), deviceId = 'd'.repeat(128);
  const store = createSettingsStore({ ownerId, storage: disk.port, availableDevices: () => [deviceId] });
  const profiles = Array.from({ length: 8 }, (_, i) => ({ id: String(i) + 'p'.repeat(127), deviceId,
    profileId: 'f'.repeat(128), profileRevision: 1, calibration: { scale: -1000000, offset: -1000000 } }));
  assert.deepEqual(await store.save(0, { preferences, profiles }), { ok: false, reason: 'invalid' });
  assert.equal(disk.records.size, 0); assert.equal((await store.load()).ok, true);
});
