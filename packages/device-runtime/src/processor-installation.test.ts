import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createAssetReference } from '../../device-model/src/resource.ts';
import { processorExtensionManifestSha256, processorExtensionSigningBytes } from '../../device-model/src/extension-release.ts';
import type { ProcessorExtensionRelease } from '../../device-model/src/extension-release.ts';
import type { ProcessorInstallationStorage, ProcessorInstallationApproval } from './processor-installation.ts';
import { createTemperatureBand } from '../../../examples/external-processor/processor.mjs';

// Resolve the actual public model barrel of this candidate, including in an isolated worktree.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === '@101/device-model' ? new URL('../../device-model/src/index.ts', import.meta.url).href : specifier, context);
} });
test.after(() => hooks.deregister());
const api = await import('./processor-installation.ts').catch(() => undefined);
const source = new Uint8Array(readFileSync(new URL('../../../examples/external-processor/processor.mjs', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../../../examples/external-processor/manifest.json', import.meta.url), 'utf8'));
const fixture = { configuration: { onAt: 30, offAt: 28 }, invalidConfiguration: { onAt: 'bad', offAt: 28 },
  invalidInputs: { temperature: 'bad' }, cases: [{ inputs: { temperature: 30 }, outputs: { switch: true } },
    { inputs: { temperature: 29 } }, { inputs: { temperature: 28 }, outputs: { switch: false } }] };
const memory = () => {
  const values = new Map<string, string>();
  let fail = false, reject = false;
  const storage: ProcessorInstallationStorage = {
    async read(key) { if (fail) throw new Error('private storage error'); return values.get(key); },
    async compareAndSwap(key, expected, value, guard) {
      if (fail) throw new Error('private storage error');
      if (reject || values.get(key) !== expected || guard.signal.aborted || !guard.isCurrent()) return false;
      values.set(key, value); return true;
    },
    isCurrent(key, expected) { return !fail && values.get(key) === expected; },
  };
  return { storage, values, setFailure(value: boolean) { fail = value; }, setConflict(value: boolean) { reject = value; } };
};
async function setup() {
  assert.ok(api, 'verified installation lifecycle API must exist');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const release = async (version = '1.0.0', sequence = 1, bytes = source, packageId = base.id) => {
    const reference = await createAssetReference('example:processor-source', 'blob', bytes);
    const manifest = { ...base, id: packageId, version, codeSha256: reference.sha256 };
    const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
      packageId: manifest.id, version, sequence, abi: '101:processor/1', runtimeVersion: '0.1.0', manifest,
      manifestSha256: await processorExtensionManifestSha256(manifest), source: reference,
      privileges: ['compute-local'] as const, dependencies: [] as const } as const;
    return { ...unsigned, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey, processorExtensionSigningBytes(unsigned))).toString('hex') } as ProcessorExtensionRelease;
  };
  const db = memory(); let now = 1000, trusted = true, approved = true, current = true, floor = 1, retired = 0, clockThrows = false;
  let grant: ProcessorInstallationApproval | undefined;
  const options = { ownerId: 'owner', storage: db.storage, now: () => { if (clockThrows) throw new Error('clock'); return now; },
    publisherTrust: () => trusted ? { key: keys.publicKey, minimumSequence: floor } : undefined,
    authorize: () => approved ? grant ?? { expiresAt: now + 60_000, isCurrent: () => current } : undefined };
  const store = api.createProcessorInstallation(options);
  const activation = (r: ProcessorExtensionRelease, extra = {}) => ({ packageId: r.packageId, version: r.version,
    codeSha256: r.source.sha256, trusted: { manifest: r.manifest, source, factory: createTemperatureBand }, fixture,
    configuration: fixture.configuration, retireOwned() { retired++; }, ...extra });
  return { store, options, db, release, activation, getRetired: () => retired,
    setNow(value: number) { now = value; }, setTrust(value: boolean) { trusted = value; },
    setApproved(value: boolean) { approved = value; }, setCurrent(value: boolean) { current = value; },
    setFloor(value: number) { floor = value; }, setGrant(value: ProcessorInstallationApproval) { grant = value; },
    setClockThrows(value: boolean) { clockThrows = value; } };
}
function success<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T { assert.equal(result.ok, true, JSON.stringify(result)); return (result as { value: T }).value; }

test('installation reserves an actual stalled storage call after logical timeout', async () => {
  const s = await setup();
  let reads = 0, settle!: (value: string | undefined) => void;
  const raw = new Promise<string | undefined>(resolve => { settle = resolve; });
  const store = api!.createProcessorInstallation({ ...s.options, storage: {
    ...s.db.storage, read: async () => { reads++; return reads === 1 ? raw : undefined; },
  } });
  try {
    assert.deepEqual(await store.inspect(), { ok: false, reason: 'unavailable' });
    assert.equal(reads, 1);
    assert.deepEqual(await store.inspect(), { ok: false, reason: 'busy' }, 'a deadline does not settle the actual storage call');
    assert.equal(reads, 1, 'do not issue a replacement while raw work is unresolved');
    settle(undefined); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await store.inspect()).ok, true, 'an explicit new operation may start after actual settlement');
    assert.equal(reads, 2);
  } finally { settle(undefined); await raw; store.close(); s.store.close(); }
});

test('installation reserves actual signed-release approval after logical timeout', async () => {
  const s = await setup(), release = await s.release();
  let approvals = 0, settle!: (value: ProcessorInstallationApproval | undefined) => void;
  const raw = new Promise<ProcessorInstallationApproval | undefined>(resolve => { settle = resolve; });
  const store = api!.createProcessorInstallation({ ...s.options, authorize: scope => {
    approvals++;
    assert.equal(scope.action, 'install');
    assert.equal(scope.release?.source.sha256, release.source.sha256);
    return raw;
  } });
  try {
    assert.deepEqual(await store.install(release, source), { ok: false, reason: 'unavailable' });
    assert.equal(approvals, 1);
    assert.deepEqual(await store.inspect(), { ok: false, reason: 'busy' }, 'a deadline does not settle the actual approval call');
    assert.equal(s.db.values.size, 0, 'a timed-out approval never writes the real source installation');
    settle({ expiresAt: 60_000, isCurrent: () => true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(success(await store.inspect()).packages.length, 0, 'late approval cannot resurrect a timed-out operation');
    assert.equal(approvals, 1);
  } finally { settle(undefined); await raw; store.close(); s.store.close(); }
});

test('actual source installation is inactive, idempotent and persists no trust or grant', async () => {
  const s = await setup(), release = await s.release();
  success(await s.store.install(release, source)); success(await s.store.install(release, source));
  const record = success(await s.store.inspect());
  assert.equal(record.packages[0]?.releases.length, 1); assert.equal(record.packages[0]?.active, false);
  const saved = success(await s.store.readRelease(release.packageId, release.version));
  assert.deepEqual(saved.source, source);
  const encoded = [...s.db.values.values()][0]!;
  for (const forbidden of ['expiresAt', 'isCurrent', 'factory', 'configuration', 'private storage error']) {
    // A manifest legitimately contains a configuration schema; no selected configuration values or callbacks are stored.
    if (forbidden !== 'configuration') assert.equal(encoded.includes(forbidden), false);
  }
  const restarted = api!.createProcessorInstallation(s.options);
  assert.equal(success(await restarted.inspect()).packages[0]?.active, false);
  s.store.close(); restarted.close();
});

test('verification and exact host binding reject tampering before any factory callback', async () => {
  const s = await setup(), release = await s.release(); let calls = 0;
  assert.equal((await s.store.install(release, new TextEncoder().encode('changed'))).ok, false);
  assert.equal((await s.store.install({ ...release, sequence: 2 }, source)).ok, false);
  success(await s.store.install(release, source));
  const request = s.activation(release, { trusted: { manifest: release.manifest, source: new Uint8Array([1]),
    factory() { calls++; return createTemperatureBand(fixture.configuration); } } });
  assert.equal((await s.store.activateReviewed(request)).ok, false); assert.equal(calls, 0);
  s.setApproved(false); assert.equal((await s.store.activateReviewed(s.activation(release))).ok, false);
  assert.equal(calls, 0); s.store.close();
});

test('real conformance, successful update and explicit rollback fence old instances', async () => {
  const s = await setup(), first = await s.release(), second = await s.release('2.0.0', 2);
  success(await s.store.install(first, source));
  const one = success(await s.store.activateReviewed(s.activation(first)));
  assert.deepEqual(one.processor.process({ temperature: 30 }), { switch: true });
  success(await s.store.install(second, source));
  assert.equal(one.isCurrent(), true, 'staging must preserve the active release');
  const failed = await s.store.activateReviewed(s.activation(second, { fixture: { ...fixture,
    cases: [{ inputs: { temperature: 30 }, outputs: { switch: false } }] } }));
  assert.equal(failed.ok, false); assert.equal(one.isCurrent(), true);
  const two = success(await s.store.activateReviewed(s.activation(second)));
  assert.equal(one.isCurrent(), false); assert.throws(() => one.processor.process({ temperature: 30 }));
  assert.equal(s.getRetired(), 1);
  assert.equal((await s.store.activateReviewed(s.activation(first))).ok, false);
  const restored = success(await s.store.rollbackReviewed(s.activation(first)));
  assert.equal(two.isCurrent(), false); assert.equal(restored.isCurrent(), true);
  s.store.close(); assert.equal(restored.isCurrent(), false); assert.equal(s.getRetired(), 3);
});

test('revocation and removal retire authority even when storage fails', async () => {
  const s = await setup(), first = await s.release(); success(await s.store.install(first, source));
  const one = success(await s.store.activateReviewed(s.activation(first)));
  s.db.setFailure(true);
  assert.equal((await s.store.revokeRelease(first.packageId, first.version)).ok, false);
  assert.equal(one.isCurrent(), false); assert.equal(s.getRetired(), 1);
  s.db.setFailure(false);
  assert.equal((await s.store.activateReviewed(s.activation(first))).ok, false);
  success(await s.store.revokeRelease(first.packageId, first.version));
  assert.equal((await s.store.rollbackReviewed(s.activation(first))).ok, false);
  success(await s.store.remove(first.packageId));
  assert.equal((await s.store.install(first, source)).ok, false); s.store.close();
});

test('current publisher revocation, floor and fresh grant deadline fence live handles', async () => {
  for (const change of ['trust', 'floor', 'grant', 'deadline'] as const) {
    const s = await setup(), first = await s.release(); success(await s.store.install(first, source));
    const one = success(await s.store.activateReviewed(s.activation(first)));
    if (change === 'trust') s.setTrust(false);
    if (change === 'floor') s.setFloor(2);
    if (change === 'grant') s.setCurrent(false);
    if (change === 'deadline') s.setNow(61_000);
    assert.equal(one.isCurrent(), false, change); assert.equal(s.getRetired(), 1); s.store.close();
  }
});

test('publisher revocation survives removal and reload without a restored activation', async () => {
  const s = await setup(), first = await s.release(); success(await s.store.install(first, source));
  const one = success(await s.store.activateReviewed(s.activation(first)));
  success(await s.store.revokePublisher(first.publisherId)); assert.equal(one.isCurrent(), false);
  success(await s.store.remove(first.packageId)); s.store.close();
  const restarted = api!.createProcessorInstallation(s.options);
  assert.equal((await restarted.install(first, source)).ok, false); restarted.close();
});

test('owner, corrupt/future document and real source integrity fail closed', async () => {
  const s = await setup(), first = await s.release(); success(await s.store.install(first, source));
  const encoded = [...s.db.values.values()][0]!, key = s.store.key;
  for (const value of ['{', JSON.stringify({ version: 2 }), encoded.replace('"ownerId":"owner"', '"ownerId":"other"'),
    encoded.replace('"sourceBase64":"', '"sourceBase64":"AAAA')]) {
    s.db.values.set(key, value); assert.equal((await s.store.inspect()).ok, false);
    assert.equal((await s.store.activateReviewed(s.activation(first))).ok, false);
  }
  assert.equal(s.db.values.get(key)?.includes('AAAA'), true, 'corrupt evidence must be preserved');
  s.store.close();
});

test('CAS conflict and another controller mutation retire stale active revisions', async () => {
  const s = await setup(), first = await s.release(), second = await s.release('2.0.0', 2);
  success(await s.store.install(first, source)); const active = success(await s.store.activateReviewed(s.activation(first)));
  s.db.setConflict(true); assert.equal((await s.store.install(second, source)).ok, false);
  assert.equal(active.isCurrent(), true); s.db.setConflict(false);
  const other = api!.createProcessorInstallation(s.options); success(await other.revokeRelease(first.packageId, first.version));
  assert.equal(active.isCurrent(), false); assert.throws(() => active.processor.process({ temperature: 30 }));
  s.store.close(); other.close();
});

test('approval accessors, throwing clock and reentrant close cannot leave authority', async () => {
  const s = await setup(), first = await s.release(); success(await s.store.install(first, source)); let reads = 0;
  s.setGrant(Object.defineProperty({ isCurrent: () => true }, 'expiresAt', { enumerable: true,
    get() { reads++; return 1_000_000; } }) as ProcessorInstallationApproval);
  assert.equal((await s.store.activateReviewed(s.activation(first))).ok, false); assert.equal(reads, 0);
  const t = await setup(), release = await t.release(); success(await t.store.install(release, source));
  const active = success(await t.store.activateReviewed(t.activation(release)));
  t.setClockThrows(true); assert.equal(active.isCurrent(), false);
  t.setClockThrows(false); t.setNow(1001); assert.equal(active.isCurrent(), false);
  s.store.close(); t.store.close();
  const c = await setup(), r = await c.release(); success(await c.store.install(r, source));
  const closed = await c.store.activateReviewed(c.activation(r, { trusted: { manifest: r.manifest, source,
    factory(configuration: { onAt: number; offAt: number }) { c.store.close(); return createTemperatureBand(configuration); } } }));
  assert.equal(closed.ok, false); assert.deepEqual(await c.store.inspect(), { ok: false, reason: 'closed' });
});

test('eight live handles leave no room for activation of another newly staged package', async () => {
  const s = await setup(), first = await s.release(), second = await s.release('1.0.0', 1, source, 'example:other');
  success(await s.store.install(first, source)); success(await s.store.install(second, source));
  const handles = [];
  for (let index = 0; index < 8; index++) handles.push(success(await s.store.activateReviewed(s.activation(first))));
  assert.deepEqual(await s.store.activateReviewed(s.activation(second)), { ok: false, reason: 'capacity' });
  assert.equal(handles.every(handle => handle.isCurrent()), true);
  handles[0]!.close(); const next = success(await s.store.activateReviewed(s.activation(second)));
  assert.equal(next.isCurrent(), true); s.store.close();
});

test('a grant revoked by a conformance callback prevents every subsequent work callback', async () => {
  const s = await setup(), release = await s.release(); success(await s.store.install(release, source)); let calls = 0;
  const result = await s.store.activateReviewed(s.activation(release, { trusted: { manifest: release.manifest, source,
    factory(configuration: { onAt: number; offAt: number }) {
      const processor = createTemperatureBand(configuration);
      return { process(input: { temperature: number }) { calls++; s.setCurrent(false); return processor.process(input); }, reset: processor.reset };
    } } }));
  assert.equal(result.ok, false); assert.equal(calls, 1, 'no work can run after authority is revoked'); s.store.close();
});

test('failed atomic update leaves the previously accepted version and its live handle usable', async () => {
  const s = await setup(), first = await s.release(), second = await s.release('2.0.0', 2);
  success(await s.store.install(first, source)); const active = success(await s.store.activateReviewed(s.activation(first)));
  success(await s.store.install(second, source)); s.db.setConflict(true);
  assert.deepEqual(await s.store.activateReviewed(s.activation(second)), { ok: false, reason: 'conflict' });
  assert.equal(active.isCurrent(), true); assert.deepEqual(active.processor.process({ temperature: 30 }), { switch: true });
  s.db.setConflict(false); assert.equal(success(await s.store.inspect()).packages[0]?.selectedVersion, '1.0.0'); s.store.close();
});

test('immutable versions, four owner package slots and two retained releases are enforced', async () => {
  const s = await setup(), first = await s.release(); success(await s.store.install(first, source));
  const changed = await s.release('1.0.0', 1, new TextEncoder().encode('changed reviewed source'));
  assert.deepEqual(await s.store.install(changed, new TextEncoder().encode('changed reviewed source')), { ok: false, reason: 'duplicate-version' });
  const live = success(await s.store.activateReviewed(s.activation(first)));
  success(await s.store.install(await s.release('2.0.0', 2), source));
  success(await s.store.install(await s.release('3.0.0', 3), source));
  const record = success(await s.store.inspect()).packages[0]!;
  assert.deepEqual(record.releases.map(value => value.release.version), ['1.0.0', '3.0.0']); assert.equal(live.isCurrent(), true);
  for (let index = 1; index < 4; index++) success(await s.store.install(await s.release('1.0.0', 1, source, `example:slot-${index}`), source));
  assert.deepEqual(await s.store.install(await s.release('1.0.0', 1, source, 'example:slot-4'), source), { ok: false, reason: 'capacity' });
  success(await s.store.remove(first.packageId));
  assert.deepEqual(await s.store.install(await s.release('1.0.0', 1, source, 'example:slot-4'), source), { ok: false, reason: 'capacity' });
  s.store.close();
});

test('simultaneous controllers atomically accept only one absent owner document', async () => {
  const s = await setup(), release = await s.release(); let reads = 0, resume!: () => void;
  const readBarrier = new Promise<void>(resolve => { resume = resolve; });
  const options = { ...s.options, storage: { ...s.db.storage, async read(key: string) {
    const value = await s.db.storage.read(key);
    if (++reads <= 2) { if (reads === 2) resume(); await readBarrier; } return value;
  } } };
  const first = api!.createProcessorInstallation(options), other = api!.createProcessorInstallation(options);
  const results = await Promise.all([first.install(release, source), other.install(release, source)]);
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(s.db.values.size, 1);
  assert.equal(success(await s.store.inspect()).packages[0]?.releases.length, 1); first.close(); s.store.close(); other.close();
});

test('close fences a delayed atomic write and prevents reentrant mutation admission', async () => {
  const s = await setup(), release = await s.release();
  let entered!: () => void, finish!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { finish = resolve; });
  const delayed = api!.createProcessorInstallation({ ...s.options, storage: { ...s.db.storage,
    async compareAndSwap(key, expected, value, guard) {
      entered(); await resumed; return s.db.storage.compareAndSwap(key, expected, value, guard);
    } } });
  const pending = delayed.install(release, source); await entry; delayed.close(); finish();
  assert.equal((await pending).ok, false); assert.equal(s.db.values.size, 0);
  let nested: Promise<unknown> | undefined;
  const reentrant = api!.createProcessorInstallation({ ...s.options, authorize() {
    nested = reentrant.install(release, source); return { expiresAt: 61_000, isCurrent: () => true };
  } });
  success(await reentrant.install(release, source)); assert.deepEqual(await nested, { ok: false, reason: 'busy' });
  reentrant.close(); s.store.close();
});

test('externally revoked publisher artifacts remain inspectable and removable without activation', async () => {
  const s = await setup(), release = await s.release(); success(await s.store.install(release, source));
  const active = success(await s.store.activateReviewed(s.activation(release))); s.setTrust(false);
  assert.equal(active.isCurrent(), false); assert.equal(success(await s.store.inspect()).packages[0]?.active, false);
  assert.equal((await s.store.readRelease(release.packageId, release.version)).ok, false);
  success(await s.store.revokePublisher(release.publisherId)); success(await s.store.remove(release.packageId)); s.store.close();
});

test('a live reset failure retires its handle and exposes only a fixed error', async () => {
  const s = await setup(), release = await s.release(); success(await s.store.install(release, source)); let factories = 0;
  const active = success(await s.store.activateReviewed(s.activation(release, { trusted: { manifest: release.manifest, source,
    factory(configuration: { onAt: number; offAt: number }) {
      const processor = createTemperatureBand(configuration), instance = ++factories;
      return { process: processor.process, reset() { if (instance >= 3) throw new Error('private-reset-reason'); processor.reset(); } };
    } } })));
  assert.throws(() => active.processor.reset(), /extension-processor-failed/);
  assert.equal(active.isCurrent(), false); assert.equal(s.getRetired(), 1); s.store.close();
});


test('read approval cannot return a release changed by another controller while awaiting the owner', async () => {
  for (const action of ['revokeRelease', 'revokePublisher', 'remove'] as const) {
    const s = await setup(), release = await s.release();
    success(await s.store.install(release, source));
    let approve!: (value: ProcessorInstallationApproval) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const reader = api!.createProcessorInstallation({ ...s.options, authorize(scope) {
      if (scope.action !== 'read-release') return s.options.authorize();
      entered(); return new Promise<ProcessorInstallationApproval>(resolve => { approve = resolve; });
    } });
    try {
      const pending = reader.readRelease(release.packageId, release.version); await waiting;
      if (action === 'revokeRelease') success(await s.store.revokeRelease(release.packageId, release.version));
      else if (action === 'revokePublisher') success(await s.store.revokePublisher(release.publisherId));
      else success(await s.store.remove(release.packageId));
      approve({ expiresAt: 61_000, isCurrent: () => true });
      const result = await pending;
      assert.deepEqual(result, { ok: false, reason: 'conflict' }, action);
    } finally { reader.close(); s.store.close(); }
  }
});
