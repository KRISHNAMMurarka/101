import assert from 'node:assert/strict';
import test from 'node:test';
import * as model from './index.ts';

type Catalog = {
  getInputProfile?: (id: string) => {
    id: string;
    capabilities: readonly { id: string; schemaVersion: number; kind: string; delivery: { mode: string }; permissions: readonly string[] }[];
    sinkOperations: Readonly<Record<string, 'write' | 'invoke'>>;
  };
  INPUT_PROFILE_IDS?: readonly string[];
};

const catalog = model as Catalog;

test('input profiles declare the seven bounded source families and reject unknown support', () => {
  assert.equal(typeof catalog.getInputProfile, 'function');
  assert.deepEqual(catalog.INPUT_PROFILE_IDS, [
    'app:pointer/1', 'app:keyboard/1', 'app:text/1', 'app:gamepad/1',
    'app:touch/1', 'app:pen/1', 'app:switch/1',
  ]);
  assert.throws(() => catalog.getInputProfile!('app:unknown/1'), /Unknown input profile/);
});

test('each profile is a valid source descriptor with explicit sink operations and bounded delivery', () => {
  assert.equal(catalog.INPUT_PROFILE_IDS?.length, 7);
  for (const id of catalog.INPUT_PROFILE_IDS ?? []) {
    const profile = catalog.getInputProfile!(id);
    const parsed = model.parseDeviceDescriptor({ schemaVersion: 1, id: 'profile-source', label: 'Profile source', revision: 1,
      adapter: { id: 'test:profile', version: '1' }, runtime: { platform: 'contract' }, capabilities: profile.capabilities });
    assert.equal(parsed.capabilities.length, profile.capabilities.length);
    assert.ok(parsed.capabilities.length > 0);
    for (const capability of parsed.capabilities) {
      assert.deepEqual(capability.permissions, ['subscribe']);
      assert.equal(profile.sinkOperations[capability.id], 'write');
      assert.equal(capability.kind === 'sample' ? capability.delivery.mode : capability.kind === 'event' ? capability.delivery.mode : '',
        capability.kind === 'sample' ? 'latest' : 'reliable');
    }
    assert.deepEqual(Object.keys(profile.sinkOperations).sort(), parsed.capabilities.map(value => value.id).sort());
  }
});

test('pointer, gamepad and edge-bearing profiles keep their distinct semantics', () => {
  const pointer = catalog.getInputProfile!('app:pointer/1');
  assert.deepEqual(pointer.capabilities.map(value => [value.id, value.kind, value.delivery.mode]),
    [['position', 'sample', 'latest'], ['contact', 'event', 'reliable']]);
  assert.equal((pointer.capabilities[1]?.delivery as { maxAgeMs?: number })?.maxAgeMs, 100);
  const gamepad = catalog.getInputProfile!('app:gamepad/1');
  assert.deepEqual(gamepad.capabilities.map(value => [value.id, value.kind, value.delivery.mode]),
    [['axes', 'sample', 'latest'], ['button', 'event', 'reliable']]);
  for (const id of ['app:keyboard/1', 'app:text/1', 'app:touch/1', 'app:pen/1', 'app:switch/1']) {
    assert.ok(catalog.getInputProfile!(id).capabilities.every(value => value.kind === 'event' && value.delivery.mode === 'reliable'));
  }
});
