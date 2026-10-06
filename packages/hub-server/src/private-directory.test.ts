import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerSourceDescriptor } from '@101/device-web';
import { createCoordinatorDirectory } from './private-directory.ts';
import type { CoordinatorDirectoryAuthority, ProvisionedDirectoryResource } from './private-directory.ts';

const descriptor = () => ({ ...pointerSourceDescriptor('node'), id: 'reviewed-surface', label: 'Reviewed surface',
  metadata: { privateNote: 'never-export', hostToken: 'not-a-credential-source' } });
const enrollment = { principalId: 'host-a', deviceId: 'device-host-a' };
const resource = () => ({ ...enrollment, descriptor: descriptor(), capabilityIds: ['position'] });
function authority(overrides: Partial<CoordinatorDirectoryAuthority> = {}): CoordinatorDirectoryAuthority {
  return { sessionId: 'ROOM101', ...enrollment, role: 'host', generation: 0, now: 1000, expiresAt: 61000,
    peers: new Map([['peer-a', 1]]), current: () => true, ...overrides };
}
// These checks exercise state/projection only; native TLS authority is qualified by https-coordinator.test.ts.
test('provisioning pins actual producer descriptors, enrollment ownership and explicit metadata projection', () => {
  const config = resource(), store = createCoordinatorDirectory([config], [enrollment]);
  config.descriptor.label = 'changed';
  store.dispatch(authority(), 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000 });
  const listed = store.dispatch(authority(), 'GET', []).body!;
  assert.equal(listed.resources[0]!.label, 'Reviewed surface');
  assert.equal(JSON.stringify(listed).includes('never-export'), false);
  assert.equal(JSON.stringify(listed).includes('metadata'), false);
  assert.equal(JSON.stringify(listed).includes('permissions'), false);
  assert.equal(listed.resources[0]!.capabilities.length, 1);
  assert.throws(() => createCoordinatorDirectory([{ ...resource(), principalId: 'claimed-owner' }], [enrollment]));
  assert.throws(() => createCoordinatorDirectory([{ ...resource(), capabilityIds: ['invented'] }], [enrollment]));
  assert.throws(() => createCoordinatorDirectory([{ ...resource(), extra: 'private' }], [enrollment]));
});

test('membership gives no visibility, and explicit visibility retires on resource removal, epoch change and expiry', () => {
  const store = createCoordinatorDirectory([resource()], [enrollment]), host = authority();
  const peer = authority({ role: 'peer', principalId: 'peer-a', deviceId: 'device-peer-a', peerId: 'peer-a', generation: 1 });
  store.dispatch(host, 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000 });
  assert.deepEqual(store.dispatch(peer, 'GET', []).body!.resources, []);
  store.dispatch(host, 'PUT', ['members', 'peer-a'], { resourceIds: ['reviewed-surface'], expiresAt: 4000 });
  assert.equal(store.dispatch(peer, 'GET', []).body!.resources.length, 1);
  assert.equal(store.dispatch({ ...peer, sessionId: 'ROOM202' }, 'GET', []).body!.resources.length, 0);
  store.retirePeer('ROOM101', 'peer-a'); assert.equal(store.dispatch(peer, 'GET', []).body!.resources.length, 0);
  store.dispatch(host, 'PUT', ['members', 'peer-a'], { resourceIds: ['reviewed-surface'], expiresAt: 4000 });
  const next = { ...peer, generation: 2, peers: new Map([['peer-a', 2]]) };
  assert.equal(store.dispatch(next, 'GET', []).body!.resources.length, 0);
  store.dispatch({ ...host, peers: next.peers }, 'PUT', ['members', 'peer-a'], { resourceIds: ['reviewed-surface'], expiresAt: 4000 });
  store.dispatch({ ...host, peers: next.peers }, 'DELETE', ['resources', 'reviewed-surface']);
  store.dispatch({ ...host, peers: next.peers }, 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000 });
  assert.equal(store.dispatch(next, 'GET', []).body!.resources.length, 0, 'reenrollment does not restore removed visibility');
  store.dispatch({ ...host, peers: next.peers }, 'PUT', ['members', 'peer-a'], { resourceIds: ['reviewed-surface'], expiresAt: 4000 });
  assert.equal(store.dispatch({ ...next, now: 4000 }, 'GET', []).body!.resources.length, 0);
  store.retireSession('ROOM101'); assert.equal(store.dispatch({ ...next, now: 4000 }, 'GET', []).body!.resources.length, 0);
});

test('invalid scopes, expired/currentness callbacks and closed input cannot mutate state', () => {
  const store = createCoordinatorDirectory([resource()], [enrollment]);
  assert.throws(() => store.dispatch(authority({ principalId: 'host-b' }), 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000 }));
  assert.throws(() => store.dispatch(authority({ current: () => false }), 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000 }));
  assert.throws(() => store.dispatch(authority(), 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 61001 }));
  assert.throws(() => store.dispatch(authority(), 'POST', ['resources'], { resourceId: 'reviewed-surface', expiresAt: 5000, principalId: 'claimed' }));
  assert.deepEqual(store.dispatch(authority(), 'GET', []).body!.resources, []);
  assert.throws(() => store.dispatch(authority({ now: 61000 }), 'GET', []));
  store.close(); assert.throws(() => store.dispatch(authority(), 'GET', []));
});

test('aggregate escaped UTF8 response budget rejects before mutation and accepted smaller enrollment retry remains readable', () => {
  const template = pointerSourceDescriptor('node').capabilities[0]!;
  const catalog: ProvisionedDirectoryResource[] = Array.from({ length: 17 }, (_, index) => ({ ...enrollment,
    descriptor: { ...descriptor(), id: `resource-${index}`, label: '界'.repeat(128), capabilities: Array.from({ length: 8 }, (_, cap) => ({ ...template,
      id: `c${cap}` + 'x'.repeat(126), semantic: 'test:' + '界'.repeat(123) })) },
    capabilityIds: Array.from({ length: 8 }, (_, cap) => `c${cap}` + 'x'.repeat(126)) }));
  catalog.push({ ...resource(), descriptor: { ...descriptor(), id: 'small' } });
  const store = createCoordinatorDirectory(catalog, [enrollment]);
  let accepted = 0;
  for (const row of catalog.slice(0, 17)) {
    try { store.dispatch(authority(), 'POST', ['resources'], { resourceId: row.descriptor.id, expiresAt: 5000 }); accepted++; }
    catch { break; }
  }
  assert.ok(accepted > 0 && accepted < 16);
  const prior = store.dispatch(authority(), 'GET', []).body!;
  assert.equal(prior.resources.length, accepted);
  assert.ok(Buffer.byteLength(JSON.stringify(prior)) <= 65536);
  store.dispatch(authority(), 'POST', ['resources'], { resourceId: 'small', expiresAt: 5000 });
  assert.equal(store.dispatch(authority(), 'GET', []).body!.resources.length, accepted + 1);
});

test('a currentness callback retiring the store cannot install directory state after retirement', () => {
  const store = createCoordinatorDirectory([resource()], [enrollment]);
  let calls = 0;
  assert.throws(() => store.dispatch(authority({ current() { if (++calls === 2) store.close(); return true; } }), 'POST', ['resources'],
    { resourceId: 'reviewed-surface', expiresAt: 5000 }));
});

test('catalog/session/member counts and TTL are finite independently of producer metadata size', () => {
  const catalog = Array.from({ length: 33 }, (_, index) => ({ ...resource(), descriptor: { ...descriptor(), id: `small-${index}` } }));
  assert.throws(() => createCoordinatorDirectory(catalog, [enrollment]));
  const store = createCoordinatorDirectory(catalog.slice(0, 17), [enrollment]);
  const host = authority({ peers: new Map(Array.from({ length: 9 }, (_, index) => [`peer-${index}`, 1])) });
  for (let index = 0; index < 16; index++) store.dispatch(host, 'POST', ['resources'], { resourceId: `small-${index}`, expiresAt: 5000 });
  assert.throws(() => store.dispatch(host, 'POST', ['resources'], { resourceId: 'small-16', expiresAt: 5000 }));
  for (let index = 0; index < 8; index++) store.dispatch(host, 'PUT', ['members', `peer-${index}`], { resourceIds: ['small-0'], expiresAt: 5000 });
  assert.throws(() => store.dispatch(host, 'PUT', ['members', 'peer-8'], { resourceIds: ['small-0'], expiresAt: 5000 }));
  assert.throws(() => store.dispatch(authority({ expiresAt: 1000000 }), 'POST', ['resources'], { resourceId: 'small-0', expiresAt: 61001 }));
  assert.equal(store.dispatch(host, 'GET', []).body!.resources.length, 16);
});
