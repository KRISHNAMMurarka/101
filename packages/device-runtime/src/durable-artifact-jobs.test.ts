import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssetReference, verifyAssetContent } from '@101/device-model';
import type { ArtifactJobAuthorization, ArtifactJobStorage, DurableArtifactJobStore } from './durable-artifact-jobs.ts';

const exported = await import('./durable-artifact-jobs.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {} as typeof import('./durable-artifact-jobs.ts');
  throw error;
});
function memoryStorage() {
  const records = new Map<string, string>(); let unavailable = false;
  const storage: ArtifactJobStorage = {
    async read(key) { if (unavailable) throw new Error('private storage failure'); return records.get(key); },
    async compareAndSwap(key, expected, value, guard) {
      if (unavailable) throw new Error('private storage failure');
      if (records.get(key) !== expected || guard?.signal?.aborted || guard?.isCurrent && !guard.isCurrent()) return false;
      records.set(key, value); return true;
    },
  };
  return { storage, records, fail() { unavailable = true; } };
}
const inputBytes = new TextEncoder().encode('bounded input for a local artifact');
const outputBytes = new TextEncoder().encode('local artifact: 34 input bytes\n');
async function request(idempotencyKey = 'job-1') {
  return { idempotencyKey, applicationId: 'artifact-app', profileId: '101:local-artifact' as const,
    profileRevision: 1 as const, destinationId: 'owner-local-store', totalUnits: 4,
    input: await createAssetReference('artifact:input', 'text', inputBytes) };
}
function factory(options: Parameters<typeof exported.createDurableArtifactJobStore>[0]): DurableArtifactJobStore {
  assert.equal(typeof exported.createDurableArtifactJobStore, 'function', 'durable local artifact API is missing');
  return exported.createDurableArtifactJobStore(options);
}
function host(storage: ArtifactJobStorage, ownerId = 'alice') {
  let now = 1000, allowed = true, current = true;
  const authorizations: ArtifactJobAuthorization[] = [];
  const authorize = (scope: ArtifactJobAuthorization) => {
    authorizations.push(scope);
    return allowed ? { expiresAt: now + 1000, isCurrent: () => current } : undefined;
  };
  const store = factory({ ownerId, storage, now: () => now, authorize });
  return { store, authorize, authorizations, setNow(value: number) { now = value; },
    deny() { allowed = false; }, revoke() { current = false; } };
}
async function started(store: DurableArtifactJobStore, input?: Awaited<ReturnType<typeof request>>) {
  const selected = input ?? await request();
  const admitted = await store.submit(selected); assert.equal(admitted.ok, true);
  const start = await store.start(selected.idempotencyKey, inputBytes); assert.equal(start.ok, true);
  if (!start.ok) assert.fail('start failed');
  return start.value;
}

test('local artifact bytes and truthful completion survive a fresh owner store without restored authority', async () => {
  const disk = memoryStorage(), h = host(disk.storage);
  assert.deepEqual(await h.store.inspect(), { ok: true, value: { version: 1, ownerId: 'alice', revision: 0, jobs: [] } });
  const attempt = await started(h.store);
  assert.equal((await attempt.progress(4)).ok, true);
  const committed = await attempt.commit(outputBytes); assert.equal(committed.ok, true);
  if (!committed.ok) return;
  assert.equal(committed.value.state, 'completed'); assert.equal(committed.value.evidence, 'artifact-stored');
  assert.equal(committed.value.output?.byteLength, 31);
  const next = host(disk.storage); next.deny();
  const history = await next.store.inspect(); assert.equal(history.ok, true);
  if (history.ok) {
    assert.equal(history.value.jobs[0]?.state, 'completed');
    assert.equal(history.value.jobs[0]?.requiresReview, false);
    assert.equal(history.value.jobs[0]?.evidence, 'artifact-stored');
    assert.ok(Object.isFrozen(history.value.jobs[0]?.request.input));
  }
  assert.deepEqual(await next.store.readOutput('job-1'), { ok: false, reason: 'denied' });
  const reader = host(disk.storage), output = await reader.store.readOutput('job-1');
  assert.equal(output.ok, true);
  if (output.ok) { assert.deepEqual(output.value.bytes, outputBytes); assert.equal(await verifyAssetContent(output.value.reference, output.value.bytes), true); }
  const raw = disk.records.get(h.store.key)!;
  for (const secret of ['expiresAt', 'isCurrent', 'grants', 'privateKey', 'credentials', 'inputBytes']) assert.equal(raw.includes(secret), false);
  await h.store.close(); await next.store.close(); await reader.store.close();
});

test('idempotency returns the existing artifact and rejects changed immutable scope', async () => {
  const disk = memoryStorage(), h = host(disk.storage), selected = await request();
  const first = await h.store.submit(selected); assert.equal(first.ok, true);
  assert.equal((await h.store.submit(selected)).ok, true);
  const changedInput = await createAssetReference('artifact:input', 'text', new TextEncoder().encode('other'));
  for (const changed of [{ ...selected, destinationId: 'other' }, { ...selected, input: changedInput },
    { ...selected, applicationId: 'other' }, { ...selected, totalUnits: 5 }]) {
    assert.deepEqual(await h.store.submit(changed), { ok: false, reason: 'idempotency-conflict' });
  }
  assert.deepEqual(await h.store.submit({ ...selected, profileRevision: 2 }), { ok: false, reason: 'invalid' });
  const attempt = await h.store.start('job-1', inputBytes); assert.equal(attempt.ok, true);
  if (attempt.ok) { await attempt.value.progress(4); assert.equal((await attempt.value.commit(outputBytes)).ok, true); }
  const before = disk.records.get(h.store.key);
  const repeated = await h.store.submit(selected); assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.value.state, 'completed');
  assert.equal(disk.records.get(h.store.key), before);
  assert.deepEqual(await h.store.start('job-1', inputBytes), { ok: false, reason: 'terminal' });
  await h.store.close();
});

test('new attempts require exact input bytes and fresh named owner approval', async () => {
  const disk = memoryStorage(), h = host(disk.storage), selected = await request();
  assert.equal((await h.store.submit(selected)).ok, true);
  assert.deepEqual(await h.store.start('job-1', new Uint8Array([1])), { ok: false, reason: 'integrity' });
  h.deny(); assert.deepEqual(await h.store.start('job-1', inputBytes), { ok: false, reason: 'denied' });
  const state = await h.store.inspect(); if (state.ok) { assert.equal(state.value.jobs[0]?.state, 'accepted'); assert.equal(state.value.jobs[0]?.attempts.length, 0); }
  assert.deepEqual(h.authorizations.at(-1)?.request, selected);
  assert.equal(h.authorizations.at(-1)?.action, 'start');
  assert.equal(h.authorizations.at(-1)?.ownerId, 'alice');
  await h.store.close();
});

test('cancellation aborts owned work and prevents late artifact publication', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  const cancelled = await h.store.cancel('job-1'); assert.equal(cancelled.ok, true); assert.equal(attempt.signal.aborted, true);
  assert.deepEqual(await attempt.progress(1), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await attempt.commit(outputBytes), { ok: false, reason: 'cancelled' });
  const next = host(disk.storage), history = await next.store.inspect();
  if (history.ok) { assert.equal(history.value.jobs[0]?.state, 'cancelled'); assert.equal(history.value.jobs[0]?.output, undefined); assert.equal(history.value.jobs[0]?.evidence, 'none'); }
  assert.deepEqual(await next.store.readOutput('job-1'), { ok: false, reason: 'no-output' });
  await h.store.close(); await next.store.close();
});

test('revocation and deadlines interrupt attempts without inventing a completed output', async () => {
  for (const cause of ['revoke', 'deadline'] as const) {
    const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
    if (cause === 'revoke') h.revoke(); else h.setNow(2000);
    const progress = await attempt.progress(1);
    assert.deepEqual(progress, { ok: false, reason: cause === 'revoke' ? 'revoked' : 'expired' });
    assert.equal(attempt.signal.aborted, true);
    const state = await h.store.inspect(); if (state.ok) { assert.equal(state.value.jobs[0]?.state, 'interrupted'); assert.equal(state.value.jobs[0]?.output, undefined); }
    assert.equal((await attempt.commit(outputBytes)).ok, false);
    await h.store.close();
  }
});

test('close immediately drops authority and records interrupted work before later callbacks', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  const closing = h.store.close(); assert.equal(attempt.signal.aborted, true);
  assert.deepEqual(await attempt.commit(outputBytes), { ok: false, reason: 'closed' });
  await closing;
  const reopened = host(disk.storage), state = await reopened.store.inspect();
  if (state.ok) { assert.equal(state.value.jobs[0]?.state, 'interrupted'); assert.equal(state.value.jobs[0]?.requiresReview, true); }
  assert.deepEqual(await reopened.store.start('job-1', inputBytes), { ok: false, reason: 'review-required' });
  await reopened.store.close();
});

test('restart requires owner review and new approval and fences a prior live generation', async () => {
  const disk = memoryStorage(), first = host(disk.storage), stale = await started(first.store);
  const restarted = host(disk.storage), view = await restarted.store.inspect();
  if (view.ok) { assert.equal(view.value.jobs[0]?.requiresReview, true); assert.equal(view.value.jobs[0]?.lastKnownState, 'running'); }
  assert.equal(restarted.authorizations.length, 0);
  assert.deepEqual(await restarted.store.start('job-1', inputBytes), { ok: false, reason: 'review-required' });
  const active = await restarted.store.restartReviewed('job-1', inputBytes); assert.equal(active.ok, true);
  assert.equal(restarted.authorizations.at(-1)?.action, 'restart-reviewed');
  assert.deepEqual(await stale.progress(1), { ok: false, reason: 'superseded' });
  assert.equal(stale.signal.aborted, true);
  assert.deepEqual(await stale.commit(outputBytes), { ok: false, reason: 'superseded' });
  if (active.ok) { await active.value.progress(4); assert.equal((await active.value.commit(outputBytes)).ok, true); }
  const history = await restarted.store.inspect();
  if (history.ok) assert.deepEqual(history.value.jobs[0]?.attempts.map(value => value.outcome), ['interrupted', 'artifact-stored']);
  await first.store.close(); await restarted.store.close();
});

test('two freshly approved competing stores claim only one generation atomically', async () => {
  const disk = memoryStorage(), first = host(disk.storage); await first.store.submit(await request());
  let approvals = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const authorize = async () => { if (++approvals === 2) release(); await barrier; return { expiresAt: 2000, isCurrent: () => true }; };
  const left = factory({ ownerId: 'alice', storage: disk.storage, now: () => 1000, authorize });
  const right = factory({ ownerId: 'alice', storage: disk.storage, now: () => 1000, authorize });
  const results = await Promise.all([left.restartReviewed('job-1', inputBytes), right.restartReviewed('job-1', inputBytes)]);
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.filter(value => !value.ok && value.reason === 'conflict').length, 1);
  for (const value of results) if (value.ok) { await value.value.progress(4); assert.equal((await value.value.commit(outputBytes)).ok, true); }
  const history = await first.store.inspect(); if (history.ok) assert.equal(history.value.jobs[0]?.attempts.length, 1);
  await first.store.close(); await left.close(); await right.close();
});

test('corruption and future versions are preserved and explicit recovery never claims old effects', async () => {
  const disk = memoryStorage(), h = host(disk.storage);
  for (const raw of ['{private malformed', JSON.stringify({ version: 2, ownerId: 'alice', revision: 1 })]) {
    disk.records.set(h.store.key, raw);
    assert.deepEqual(await h.store.inspect(), { ok: false, reason: raw.startsWith('{private') ? 'corrupt' : 'incompatible' });
    assert.equal(disk.records.get(h.store.key), raw);
    h.deny(); assert.deepEqual(await h.store.recoverStorageReviewed(), { ok: false, reason: 'denied' });
    assert.equal(disk.records.get(h.store.key), raw);
  }
  const recovering = host(disk.storage);
  assert.equal((await recovering.store.recoverStorageReviewed()).ok, true);
  const clean = await recovering.store.inspect(); if (clean.ok) assert.deepEqual(clean.value.jobs, []);
  const foreign = JSON.stringify({ version: 1, ownerId: 'bob', revision: 1, jobs: [] }); disk.records.set(h.store.key, foreign);
  assert.deepEqual(await recovering.store.recoverStorageReviewed(), { ok: false, reason: 'wrong-owner' });
  assert.equal(disk.records.get(h.store.key), foreign);
  await h.store.close(); await recovering.store.close();
});

test('owner keys isolate records and private backend errors return fixed failures', async () => {
  const disk = memoryStorage(), alice = host(disk.storage), bob = host(disk.storage, 'bob');
  assert.notEqual(alice.store.key, bob.store.key);
  await alice.store.submit(await request());
  const empty = await bob.store.inspect(); if (empty.ok) assert.deepEqual(empty.value.jobs, []);
  disk.fail();
  assert.deepEqual(await alice.store.inspect(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await bob.store.submit(await request()), { ok: false, reason: 'unavailable' });
  await alice.store.close(); await bob.store.close();
});

test('bounded input, artifact, progress, retries and job capacity reject before effect', async () => {
  const disk = memoryStorage(), h = host(disk.storage);
  assert.deepEqual(await h.store.submit({ ...await request(), totalUnits: 65 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.store.submit({ ...await request(), grants: [{ expiresAt: 9999 }] }), { ok: false, reason: 'invalid' });
  const attempt = await started(h.store);
  assert.deepEqual(await attempt.progress(5), { ok: false, reason: 'invalid' });
  await attempt.progress(2);
  assert.deepEqual(await attempt.progress(1), { ok: false, reason: 'invalid' });
  assert.deepEqual(await attempt.commit(outputBytes), { ok: false, reason: 'incomplete' });
  await attempt.progress(4);
  assert.deepEqual(await attempt.commit(new Uint8Array(4097)), { ok: false, reason: 'capacity' });
  assert.equal((await attempt.fail()).ok, true);
  for (let index = 0; index < 3; index++) {
    const retry = await h.store.restartReviewed('job-1', inputBytes); assert.equal(retry.ok, true);
    if (retry.ok) assert.equal((await retry.value.fail()).ok, true);
  }
  assert.deepEqual(await h.store.restartReviewed('job-1', inputBytes), { ok: false, reason: 'capacity' });
  for (let index = 2; index <= 8; index++) assert.equal((await h.store.submit(await request(`job-${index}`))).ok, true);
  assert.deepEqual(await h.store.submit(await request('job-9')), { ok: false, reason: 'capacity' });
  await h.store.close();
});

test('retained artifact byte corruption cannot provide successful historical output evidence', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  await attempt.progress(4); await attempt.commit(outputBytes);
  const raw = JSON.parse(disk.records.get(h.store.key)!);
  raw.jobs[0].artifact = btoa('changed output'); disk.records.set(h.store.key, JSON.stringify(raw));
  assert.deepEqual(await host(disk.storage).store.readOutput('job-1'), { ok: false, reason: 'integrity' });
  await h.store.close();
});

test('slow input verification or authorization cannot outlive close and create an attempt', async () => {
  const disk = memoryStorage(); let release!: () => void;
  const approval = new Promise<void>(resolve => { release = resolve; });
  const store = factory({ ownerId: 'alice', storage: disk.storage, now: () => 1000,
    authorize: async () => { await approval; return { expiresAt: 2000, isCurrent: () => true }; } });
  await store.submit(await request());
  const starting = store.start('job-1', inputBytes);
  await new Promise<void>(resolve => setImmediate(resolve));
  const closing = store.close(); release();
  assert.deepEqual(await starting, { ok: false, reason: 'closed' });
  await closing;
  const view = await host(disk.storage).store.inspect(); if (view.ok) { assert.equal(view.value.jobs[0]?.attempts.length, 0); assert.equal(view.value.jobs[0]?.requiresReview, true); }
});

test('cancellation wins against a pending artifact transaction and the late result reports cancellation', async () => {
  const disk = memoryStorage(); let reached!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const storage: ArtifactJobStorage = {
    read: disk.storage.read,
    async compareAndSwap(key, expected, value, guard) {
      if (JSON.parse(value).jobs[0]?.state === 'completed') { reached(); await barrier; }
      return disk.storage.compareAndSwap(key, expected, value, guard);
    },
  };
  const h = host(storage), attempt = await started(h.store); await attempt.progress(4);
  const late = attempt.commit(outputBytes); await pending;
  assert.equal((await h.store.cancel('job-1')).ok, true); release();
  assert.deepEqual(await late, { ok: false, reason: 'cancelled' });
  const output = await h.store.readOutput('job-1'); assert.deepEqual(output, { ok: false, reason: 'no-output' });
  await h.store.close();
});

test('current authority callbacks cannot reentrantly close a store and still admit work', async () => {
  const disk = memoryStorage();
  const store: DurableArtifactJobStore = factory({ ownerId: 'alice', storage: disk.storage, now: () => 1000,
    authorize: () => ({ expiresAt: 2000, isCurrent: () => { void store.close(); return true; } }) });
  await store.submit(await request());
  assert.deepEqual(await store.start('job-1', inputBytes), { ok: false, reason: 'closed' });
  const reopened = host(disk.storage), history = await reopened.store.inspect();
  if (history.ok) assert.equal(history.value.jobs[0]?.attempts.length, 0);
  await store.close(); await reopened.store.close();
});

test('stored failed attempts cannot falsely retain an artifact-stored historical outcome', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  await attempt.progress(4); await attempt.commit(outputBytes);
  const forged = JSON.parse(disk.records.get(h.store.key)!);
  forged.jobs[0].state = 'failed'; delete forged.jobs[0].artifact; delete forged.jobs[0].output;
  const raw = JSON.stringify(forged); disk.records.set(h.store.key, raw);
  assert.deepEqual(await host(disk.storage).store.inspect(), { ok: false, reason: 'corrupt' });
  assert.equal(disk.records.get(h.store.key), raw);
  await h.store.close();
});

test('storage recovery cannot erase healthy retained idempotency and artifact evidence', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  await attempt.progress(4); await attempt.commit(outputBytes);
  const before = disk.records.get(h.store.key);
  assert.deepEqual(await h.store.recoverStorageReviewed(), { ok: false, reason: 'invalid' });
  assert.equal(disk.records.get(h.store.key), before);
  assert.equal((await h.store.readOutput('job-1')).ok, true);
  await h.store.close();
});

test('a backwards host clock immediately retires an attempt and closes its authority', async () => {
  const disk = memoryStorage(), h = host(disk.storage), attempt = await started(h.store);
  h.setNow(999);
  assert.deepEqual(await attempt.progress(1), { ok: false, reason: 'invalid-clock' });
  assert.equal(attempt.signal.aborted, true);
  assert.deepEqual(await h.store.inspect(), { ok: false, reason: 'closed' });
  await h.store.close();
});

test('a throwing host clock retires authority permanently before the clock becomes readable again', async () => {
  const disk = memoryStorage(); let clockThrows = false;
  const store = factory({ ownerId: 'alice', storage: disk.storage, now: () => {
    if (clockThrows) throw new Error('private clock failure'); return 1000;
  }, authorize: () => ({ expiresAt: 61000, isCurrent: () => true }) });
  try {
    const attempt = await started(store); clockThrows = true;
    assert.deepEqual(await attempt.progress(1), { ok: false, reason: 'invalid-clock' });
    assert.equal(attempt.signal.aborted, true);
    clockThrows = false;
    assert.deepEqual(await attempt.progress(1), { ok: false, reason: 'closed' });
    assert.deepEqual(await attempt.commit(outputBytes), { ok: false, reason: 'closed' });
    const reopened = host(disk.storage), history = await reopened.store.inspect();
    if (history.ok) { assert.equal(history.value.jobs[0]?.requiresReview, true); assert.equal(history.value.jobs[0]?.evidence, 'none'); }
    await reopened.store.close();
  } finally { await store.close(); }
});

test('an accessor grant cannot extend the deadline beyond the value validated by the host', async () => {
  const disk = memoryStorage(); let now = 1000, reads = 0;
  const store = factory({ ownerId: 'alice', storage: disk.storage, now: () => now,
    authorize: () => ({ get expiresAt() { return ++reads <= 4 ? 2000 : 1000000; }, isCurrent: () => true }) });
  try {
    await store.submit(await request());
    const start = await store.start('job-1', inputBytes);
    if (!start.ok) assert.equal(start.reason, 'denied');
    else {
      now = 120000;
      assert.deepEqual(await start.value.progress(1), { ok: false, reason: 'expired' });
      assert.equal(start.value.signal.aborted, true);
    }
    const history = await store.inspect();
    if (history.ok) { assert.equal(history.value.jobs[0]?.output, undefined); assert.equal(history.value.jobs[0]?.evidence, 'none'); }
  } finally { await store.close(); }
});
