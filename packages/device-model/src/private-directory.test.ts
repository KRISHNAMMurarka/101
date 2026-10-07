import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerSourceDescriptor } from '@101/device-web';
import { parseDeviceDescriptor } from './descriptor.ts';
import { assessDiscoveryCandidate } from './discovery.ts';
import { parsePrivateDirectorySnapshot, parsePrivateDirectoryPublication, privateDirectoryCandidates, PRIVATE_DIRECTORY_PROFILE } from './private-directory.ts';

const snapshot = () => ({ schemaVersion: 1, profile: 'provisioned-session-directory/1', scope: { kind: 'directory', id: 'ROOM101' },
  issuedAt: 1000, expiresAt: 2000, resources: [{ id: 'surface', revision: 1, label: 'Reviewed surface', expiresAt: 1900,
    capabilities: [{ id: 'position', semantic: 'input:pointer', kind: 'sample', schemaVersion: 1 }] }] });

test('closed immutable directory metadata preserves scope without granting resource access', () => {
  const input = snapshot(), parsed = parsePrivateDirectorySnapshot(input);
  input.resources[0]!.label = 'changed';
  assert.equal(parsed.profile, PRIVATE_DIRECTORY_PROFILE);
  assert.equal(parsed.resources[0]!.label, 'Reviewed surface');
  assert.equal(Object.isFrozen(parsed.resources[0]!.capabilities[0]), true);
  const candidates = privateDirectoryCandidates(parsed, 'local-review-receipt');
  assert.equal(candidates[0]!.evidence.length, 2);
  assert.equal(candidates[0]!.recovery.action, 'request-access');
  assert.equal(assessDiscoveryCandidate(candidates[0], parsed.scope, 1100, () => false).state, 'unverified');
  assert.equal(assessDiscoveryCandidate(candidates[0], parsed.scope, 1100, () => true).state, 'identified');
  assert.equal(assessDiscoveryCandidate(candidates[0], parsed.scope, 1900, () => true).state, 'expired');
  assert.equal(assessDiscoveryCandidate(candidates[0], { kind: 'directory', id: 'OTHER101' }, 1100, () => true).state, 'out-of-scope');
});

test('rejects unknown metadata, credentials, duplicate resources/capabilities and future profiles', () => {
  for (const change of [
    (v: ReturnType<typeof snapshot>) => Object.assign(v, { hostToken: 'secret' }),
    (v: ReturnType<typeof snapshot>) => Object.assign(v.resources[0]!, { metadata: { private: true } }),
    (v: ReturnType<typeof snapshot>) => Object.assign(v.resources[0]!.capabilities[0]!, { permissions: ['invoke'] }),
    (v: ReturnType<typeof snapshot>) => v.resources.push(v.resources[0]!),
    (v: ReturnType<typeof snapshot>) => v.resources[0]!.capabilities.push(v.resources[0]!.capabilities[0]!),
    (v: ReturnType<typeof snapshot>) => v.profile = 'future/2',
    (v: ReturnType<typeof snapshot>) => v.expiresAt = 61001,
    (v: ReturnType<typeof snapshot>) => v.resources[0]!.revision = 0,
    (v: ReturnType<typeof snapshot>) => v.resources[0]!.expiresAt = 2001,
  ]) { const value = snapshot(); change(value); assert.throws(() => parsePrivateDirectorySnapshot(value)); }
  const getter = snapshot(); Object.defineProperty(getter, 'resources', { get() { throw new Error('must not run'); } });
  assert.throws(() => parsePrivateDirectorySnapshot(getter));
});

test('rejects traversal identifiers, invalid times and actual escaped UTF8/count budgets', () => {
  const value = snapshot(); value.resources[0]!.id = '../private'; assert.throws(() => parsePrivateDirectorySnapshot(value));
  const invalid = snapshot(); invalid.issuedAt = Number.NaN; assert.throws(() => parsePrivateDirectorySnapshot(invalid));
  const tooMany = snapshot(); tooMany.resources = Array.from({ length: 17 }, (_, i) => ({ ...tooMany.resources[0]!, id: `r${i}` }));
  assert.throws(() => parsePrivateDirectorySnapshot(tooMany));
  const large = snapshot(); large.resources[0]!.label = 'x'.repeat(65537); assert.throws(() => parsePrivateDirectorySnapshot(large));
});

test('explicit publication parses the actual pointer descriptor and an immutable selected capability subset', () => {
  const input = { generation: 1, descriptor: pointerSourceDescriptor('node'), capabilityIds: ['position'], expiresAt: 5000, consent: true };
  const publication = parsePrivateDirectoryPublication(input);
  input.descriptor.label = 'changed'; input.capabilityIds.push('contact');
  assert.equal(publication.descriptor.label, 'Touch surface');
  assert.deepEqual(publication.capabilityIds, ['position']);
  assert.equal(Object.isFrozen(publication.descriptor.capabilities[0]), true);
  assert.equal(Object.isFrozen(publication), true);
});

test('publication rejects implicit consent, forged fields, invalid descriptors, capability expansion and escaped UTF8 request excess', () => {
  const valid = () => ({ generation: 1, descriptor: pointerSourceDescriptor('node'), capabilityIds: ['position'], expiresAt: 5000, consent: true });
  for (const value of [
    { ...valid(), consent: false }, { ...valid(), consent: 'yes' }, { ...valid(), generation: 0 },
    { ...valid(), generation: Number.NaN }, { ...valid(), expiresAt: -1 }, { ...valid(), principalId: 'claimed-owner' },
    { ...valid(), capabilityIds: [] }, { ...valid(), capabilityIds: ['position', 'position'] }, { ...valid(), capabilityIds: ['invented'] },
    { ...valid(), descriptor: { ...valid().descriptor, id: '../private' } },
    { ...valid(), descriptor: { ...valid().descriptor, revision: 0 } },
    { ...valid(), descriptor: { ...valid().descriptor, metadata: { private: '界'.repeat(3000) } } },
  ]) assert.throws(() => parsePrivateDirectoryPublication(value));
  let called = false;
  const accessor = valid(); Object.defineProperty(accessor, 'descriptor', { get() { called = true; return valid().descriptor; } });
  assert.throws(() => parsePrivateDirectoryPublication(accessor)); assert.equal(called, false);
});

test('publication retains the actual descriptor parser depth contract for bounded private metadata', () => {
  const descriptor = parseDeviceDescriptor({ ...pointerSourceDescriptor('node'), metadata: { private: { a: { b: { c: { d: { e: { f: 'note' } } } } } } } });
  const publication = parsePrivateDirectoryPublication({ generation: 1, descriptor, capabilityIds: ['position'], expiresAt: 5000, consent: true });
  assert.deepEqual(publication.descriptor.metadata, descriptor.metadata);
});
