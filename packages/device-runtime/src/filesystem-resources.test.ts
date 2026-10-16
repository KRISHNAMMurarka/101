import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, link, lstat, mkdir, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
const api = await import('../../../examples/filesystem-resources/adapter.mjs').catch((error: unknown) => {
  if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return undefined;
});
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(input: { deadlineMs?: number; onNative?: (event: { stage: string; root: string }) => void } = {}) {
  assert.equal(typeof api?.createOwnedFilesystemAdapter, 'function', 'a selected real filesystem adapter exists');
  let root = '', allowed = true, current = true, now = 1000, hook: (() => void) | undefined;
  const signal = new AbortController();
  const port = await api!.createOwnedFilesystemAdapter({ destinations: [{ id: 'note', leaf: 'note.txt' }, { id: 'settings', leaf: 'settings.json' }],
    scope: { principalId: 'owner', applicationId: 'filesystem-test', sessionId: 'fresh-one' }, now: () => now,
    deadlineMs: input.deadlineMs ?? 500,
    authorize(request: { expiresAt: number }) { hook?.(); return allowed ? { request, expiresAt: Math.min(now + 500, request.expiresAt), isCurrent: () => allowed } : undefined; },
    onRoot(path: string) { root = path; }, onNative: input.onNative });
  const context = { signal: signal.signal, routeId: 'actual-test-route', generation: 1, operationId: '1', isCurrent: () => current };
  const resource = (action: string, destinationId = 'note') => {
    const selected = port.resources.find((item: { action: string; destinationId: string }) => item.action === action &&
      (action === 'list' || item.destinationId === destinationId));
    assert.ok(selected); return selected.resourceId;
  };
  const execute = (action: string, args: object = {}, destinationId = 'note') => port.execute(resource(action, destinationId), args, context);
  return { port, root, context, signal, resource, execute, allow(value: boolean) { allowed = value; }, current(value: boolean) { current = value; },
    clock(value: number) { now = value; }, hook(callback?: () => void) { hook = callback; } };
}
const bytes = new TextEncoder().encode('selected sensitive fixture bytes');

test('private owned root is explicit and empty; import and construction mint no operation grant', async () => {
  const h = await fixture(); try { assert.equal((await lstat(h.root)).mode & 0o777, 0o700); assert.deepEqual(await readdir(h.root), []);
    assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().timerArmed, false); assert.equal(h.port.resources.length, 7);
    h.allow(false); assert.equal((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok, false); assert.deepEqual(await readdir(h.root), []);
  } finally { assert.equal((await h.port.close()).removed, true); }
});
test('genuine create/read/list/CAS replace/delete preserve exact bytes and authorize each selected action', async () => {
  const h = await fixture(); try {
    assert.equal((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok, true);
    assert.deepEqual(await readFile(join(h.root, 'note.txt')), Buffer.from(bytes)); assert.equal((await lstat(join(h.root, 'note.txt'))).mode & 0o777, 0o600);
    const read = await h.execute('read'); assert.ok(read.ok); assert.deepEqual(read.value.bytes, bytes); assert.equal(read.value.sha256, hash(bytes));
    const listing = await h.execute('list'); assert.ok(listing.ok); assert.deepEqual(listing.value.entries.map((entry: { destinationId: string }) => entry.destinationId), ['note']);
    const next = new TextEncoder().encode('reviewed replacement'); assert.equal((await h.execute('write', { bytes: next, expectedSha256: hash(bytes) })).ok, true);
    assert.deepEqual(await readFile(join(h.root, 'note.txt')), Buffer.from(next));
    assert.equal((await h.execute('delete', { expectedSha256: hash(next) })).ok, true); assert.deepEqual(await readdir(h.root), []);
  } finally { await h.port.close(); }
});
test('stale overwrite/delete hashes preserve original data and missing reads are fixed failures', async () => {
  const h = await fixture(); try { await h.execute('write', { bytes, expectedSha256: 'absent' });
    for (const action of ['write', 'delete']) assert.equal((await h.execute(action, { ...(action === 'write' ? { bytes: new Uint8Array([0]) } : {}), expectedSha256: '0'.repeat(64) })).reason, 'conflict');
    assert.deepEqual(await readFile(join(h.root, 'note.txt')), Buffer.from(bytes)); assert.equal((await h.execute('read', {}, 'settings')).reason, 'missing');
  } finally { await h.port.close(); }
});
test('selected symlinks and hardlinks never disclose or overwrite an unselected owned fixture', async () => {
  const h = await fixture(), privateDirectory = join(h.root, 'private'), sentinel = join(privateDirectory, 'sentinel');
  try { await mkdir(privateDirectory, { mode: 0o700 }); await writeFile(sentinel, bytes, { mode: 0o600 });
    await symlink(sentinel, join(h.root, 'note.txt'));
    for (const action of ['read', 'write', 'delete']) assert.equal((await h.execute(action, action === 'read' ? {} : { ...(action === 'write' ? { bytes } : {}), expectedSha256: hash(bytes) })).ok, false);
    assert.deepEqual(await readFile(sentinel), Buffer.from(bytes)); await unlink(join(h.root, 'note.txt'));
    await link(sentinel, join(h.root, 'note.txt')); assert.equal((await h.execute('read')).ok, false); assert.equal((await h.execute('write', { bytes, expectedSha256: hash(bytes) })).ok, false);
    assert.deepEqual(await readFile(sentinel), Buffer.from(bytes));
  } finally { await unlink(join(h.root, 'note.txt')).catch(() => {}); await unlink(sentinel); await rmdir(privateDirectory); await h.port.close(); }
});
test('unknown resource/traversal/extra fields and byte caps are rejected before native issue', async () => {
  const h = await fixture(); try {
    assert.equal((await h.port.execute('../private/sentinel', {}, h.context)).reason, 'invalid');
    assert.equal((await h.execute('read', { path: '/etc/passwd' })).reason, 'invalid');
    assert.equal((await h.execute('write', { bytes: new Uint8Array(513), expectedSha256: 'absent' })).ok, false);
    const shadow = new Uint8Array(513); Object.defineProperty(shadow, 'byteLength', { value: 1 });
    assert.equal((await h.execute('write', { bytes: shadow, expectedSha256: 'absent' })).ok, false); assert.deepEqual(await readdir(h.root), []);
  } finally { await h.port.close(); }
});
test('native reads stay buffer-bounded if an owned file grows after stat', async () => {
  let grow = false;
  const h = await fixture({ onNative(event) { if (grow && event.stage === 'read-stat') { grow = false; return appendFile(join(event.root, 'note.txt'), new Uint8Array(4096)); } } });
  try { assert.ok((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok); grow = true; const beforeRead = h.port.status().nativeReadBytes;
    const result = await h.execute('read'); assert.equal(result.ok, false); assert.equal(result.reason, 'quota'); assert.ok(h.port.status().nativeReadBytes - beforeRead <= 513);
  } finally { await h.port.close(); }
});
test('authorization and currentness reentrancy prevent issue; callback getters are never evaluated', async () => {
  const h = await fixture(); try {
    h.hook(() => h.current(false)); assert.equal((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok, false); assert.deepEqual(await readdir(h.root), []);
    h.hook(); h.current(true); let gets = 0;
    const bad = Object.defineProperty({ ...h.context }, 'isCurrent', { enumerable: true, get() { gets++; return () => true; } });
    assert.equal((await h.port.execute(h.resource('read'), {}, bad)).ok, false); assert.equal(gets, 0); assert.equal(h.port.status().rawPending, 0);
  } finally { await h.port.close(); }
});
test('cancelled issued staging stays reserved until genuine native work and cleanup settle', async () => {
  let entered!: () => void, release!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture({ onNative(event) { if (event.stage === 'write-staged') { entered(); return gate; } } });
  try { const work = h.execute('write', { bytes, expectedSha256: 'absent' }); await enteredPromise; h.signal.abort(); const result = await work;
    assert.equal(result.ok, false); assert.equal(result.reason, 'cancelled'); assert.equal(h.port.status().rawPending, 1);
    assert.equal((await h.execute('read')).reason, 'busy'); release(); await h.port.drain(); assert.equal(h.port.status().rawPending, 0);
    assert.deepEqual(await readdir(h.root), []);
  } finally { release(); await h.port.close(); }
});
test('quiet expiry denies stale output, retains raw work, and permits fresh approved retry', async () => {
  let entered!: () => void, release!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const h = await fixture({ deadlineMs: 200, onNative(event) { if (event.stage === 'write-staged') { entered(); return gate; } } });
  try { const work = h.execute('write', { bytes, expectedSha256: 'absent' }); await enteredPromise; assert.equal((await work).reason, 'expired');
    assert.equal(h.port.status().rawPending, 1); assert.equal(h.port.status().timerArmed, false); release(); await h.port.drain(); assert.deepEqual(await readdir(h.root), []);
    assert.equal((await h.execute('read', {}, 'settings')).reason, 'missing');
  } finally { release(); await h.port.close(); }
});

test('revocation as genuine native open returns closes the actual returned descriptor', async () => {
  const h = await fixture(); let opened: import('node:fs/promises').FileHandle | undefined; const original = fsPromises.open;
  try {
    assert.ok((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok);
    fsPromises.open = async (...args: Parameters<typeof original>) => { const file = await original(...args); opened = file; h.signal.abort(); return file; }; syncBuiltinESMExports();
    assert.equal((await h.execute('read')).ok, false); await h.port.drain(); assert.ok(opened);
    await assert.rejects(opened.read(new Uint8Array(1), 0, 1, 0), { code: 'EBADF' });
  } finally { fsPromises.open = original; syncBuiltinESMExports(); await opened?.close(); await h.port.close(); }
});

test('late cancellation after actual rename/unlink reports issued uncertainty and releases no stale result', async () => {
  let cancelAt = '', cancel = () => {};
  const h = await fixture({ onNative(event) { if (event.stage === cancelAt) cancel(); } });
  try {
    cancel = () => h.signal.abort(); cancelAt = 'write-issued'; const result = await h.execute('write', { bytes, expectedSha256: 'absent' });
    assert.equal(result.ok, false); assert.equal(result.issuedMutation, true); assert.equal('value' in result, false);
    await h.port.drain(); assert.deepEqual(await readFile(join(h.root, 'note.txt')), Buffer.from(bytes));
    const fresh = new AbortController(); cancel = () => fresh.abort(); cancelAt = 'delete-issued';
    const deleted = await h.port.execute(h.resource('delete'), { expectedSha256: hash(bytes) }, { ...h.context, signal: fresh.signal });
    assert.equal(deleted.ok, false); assert.equal(deleted.issuedMutation, true); assert.equal('value' in deleted, false);
    await h.port.drain(); assert.deepEqual(await readdir(h.root), []);
  } finally { await h.port.close(); }
});

test('reservation precedes approval callbacks and close reentrancy leaves no owned timer or write', async () => {
  const h = await fixture(); let nested: Promise<unknown> | undefined;
  try { h.hook(() => { nested = h.execute('read'); void h.port.close(); });
    assert.equal((await h.execute('write', { bytes, expectedSha256: 'absent' })).ok, false);
    assert.deepEqual(await nested, { ok: false, reason: 'busy', issuedMutation: false }); await h.port.drain();
    assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().timerArmed, false); assert.equal(h.port.status().issuedMutations, 0);
  } finally { assert.equal((await h.port.close()).removed, true); }
});

test('finite lifetime attempts and backward clocks fail closed without restoring authority', async () => {
  const h = await fixture(); try { h.allow(false);
    for (let index = 0; index < 64; index++) assert.equal((await h.execute('read')).reason, 'denied');
    assert.equal((await h.execute('read')).reason, 'quota'); assert.deepEqual(await readdir(h.root), []);
  } finally { await h.port.close(); }
  const second = await fixture(); try { assert.equal((await second.execute('read')).reason, 'missing'); second.clock(999);
    assert.equal((await second.execute('read')).ok, false); assert.equal(second.port.status().closed, true);
    second.clock(1001); assert.equal((await second.execute('read')).reason, 'closed');
  } finally { await second.port.close(); }
});

test('declared destinations are closed snapshots; executable array/getter fields are rejected', async () => {
  assert.equal(typeof api?.createOwnedFilesystemAdapter, 'function'); let calls = 0;
  const base = { scope: { principalId: 'owner', applicationId: 'test', sessionId: 'one' }, now: () => 1000, authorize: () => undefined };
  const destinations = [{ id: 'note', leaf: 'note.txt' }];
  Object.defineProperty(destinations, Symbol.iterator, { value() { calls++; return [][Symbol.iterator](); } });
  await assert.rejects(api!.createOwnedFilesystemAdapter({ ...base, destinations }));
  const getter = Object.defineProperty({}, 'id', { enumerable: true, get() { calls++; return 'note'; } });
  await assert.rejects(api!.createOwnedFilesystemAdapter({ ...base, destinations: [Object.assign(getter, { leaf: 'note.txt' })] }));
  await assert.rejects(api!.createOwnedFilesystemAdapter({ ...base, destinations: [{ id: 'note', leaf: '../note.txt' }] })); assert.equal(calls, 0);
});

test('four genuine selected 512-byte files fill the declared quota without exceeding native work bounds', async () => {
  assert.equal(typeof api?.createOwnedFilesystemAdapter, 'function'); let root = '';
  const port = await api!.createOwnedFilesystemAdapter({ destinations: ['one', 'two', 'three', 'four'].map(id => ({ id, leaf: id + '.txt' })),
    scope: { principalId: 'owner', applicationId: 'quota-test', sessionId: 'four-files' }, now: () => 1000,
    authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, isCurrent: () => true }; }, onRoot(path: string) { root = path; } });
  const context = { signal: new AbortController().signal, routeId: 'four-file-route', generation: 1, operationId: '1', isCurrent: () => true };
  try { const content = new Uint8Array(512).map((_, index) => index % 256);
    for (const id of ['one', 'two', 'three', 'four']) assert.ok((await port.execute(id + '-write', { bytes: content, expectedSha256: 'absent' }, context)).ok);
    const listed = await port.execute('list', {}, context); assert.ok(listed.ok);
    assert.equal(listed.value.entries.reduce((sum: number, entry: { byteLength: number }) => sum + entry.byteLength, 0), 2048);
    const selected = await port.execute('four-read', {}, context); assert.ok(selected.ok); assert.deepEqual(selected.value.bytes, content);
    assert.equal((await readdir(root)).length, 4);
  } finally { assert.equal((await port.close()).removed, true); }
});

test('atomic replacement counts staging bytes against the genuine native root quota', async () => {
  assert.equal(typeof api?.createOwnedFilesystemAdapter, 'function'); let root = '', peak = 0;
  const port = await api!.createOwnedFilesystemAdapter({ destinations: ['one', 'two', 'three', 'four'].map(id => ({ id, leaf: id + '.txt' })),
    scope: { principalId: 'owner', applicationId: 'staging-quota-test', sessionId: 'four-files' }, now: () => 1000,
    authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, isCurrent: () => true }; }, onRoot(path: string) { root = path; },
    async onNative(event: { stage: string; root: string }) {
      if (event.stage === 'write-staged') {
        const names = await readdir(event.root), sizes = await Promise.all(names.map(async name => (await lstat(join(event.root, name))).size));
        peak = Math.max(peak, sizes.reduce((total, size) => total + size, 0));
      }
    } });
  const context = { signal: new AbortController().signal, routeId: 'staging-quota-route', generation: 1, operationId: '1', isCurrent: () => true };
  try {
    const original = new Uint8Array(512).fill(42), replacement = new Uint8Array(512).fill(43);
    for (const id of ['one', 'two', 'three', 'four']) assert.ok((await port.execute(id + '-write', { bytes: original, expectedSha256: 'absent' }, context)).ok);
    const blocked = await port.execute('four-write', { bytes: replacement, expectedSha256: hash(original) }, context);
    assert.equal(blocked.reason, 'quota'); assert.equal(blocked.issuedMutation, false);
    assert.deepEqual(await readFile(join(root, 'four.txt')), Buffer.from(original)); assert.equal((await readdir(root)).length, 4);
    assert.ok(peak <= api!.OWNED_FILESYSTEM_LIMITS.rootBytes);
    assert.ok((await port.execute('one-delete', { expectedSha256: hash(original) }, context)).ok);
    assert.ok((await port.execute('four-write', { bytes: replacement, expectedSha256: hash(original) }, context)).ok);
    assert.deepEqual(await readFile(join(root, 'four.txt')), Buffer.from(replacement)); assert.ok(peak <= api!.OWNED_FILESYSTEM_LIMITS.rootBytes);
  } finally { assert.equal((await port.close()).removed, true); }
});


test('cached filesystem approval cannot cross a fresh owned root with the same caller and operation tuple', async () => {
  assert.equal(typeof api?.createOwnedFilesystemAdapter, 'function');
  type Approval = { request: Record<string, unknown>; expiresAt: number; isCurrent: () => boolean; signal: AbortSignal };
  const approvals: Approval[] = [], requestsB: Record<string, unknown>[] = [], roots: string[] = [], nativeB: string[] = [];
  const ports: { close(): Promise<{ removed: boolean }>; status(): { rawPending: number; timerArmed: boolean } }[] = [];
  const owner = new AbortController(), delivery = new AbortController();
  const options = { scope: { principalId: 'owner', applicationId: 'filesystem-test', sessionId: 'same-session' },
    destinations: [{ id: 'note', leaf: 'note.txt' }], now: () => 1000, deadlineMs: 500,
    onRoot(path: string) { roots.push(path); } };
  const context = { signal: delivery.signal, routeId: 'same-route', generation: 1, operationId: 'same-operation', isCurrent: () => true };
  const originalBytes = new Uint8Array([65, 66, 67]), freshBytes = new Uint8Array([88, 89, 90]);
  let allowFreshB = false;
  const originalStat = fsPromises.lstat;
  try {
    const a = await api!.createOwnedFilesystemAdapter({ ...options, authorize(request: Record<string, unknown>) {
      const grant = { request, expiresAt: 1500, isCurrent: () => true, signal: owner.signal }; approvals.push(grant); return grant;
    } }); ports.push(a);
    const b = await api!.createOwnedFilesystemAdapter({ ...options, authorize(request: Record<string, unknown>) {
      requestsB.push(request);
      return allowFreshB ? { request, expiresAt: 1500, isCurrent: () => true, signal: owner.signal } : approvals[0];
    }, onNative(event: { stage: string }) { nativeB.push(event.stage); } }); ports.push(b);
    assert.equal(roots.length, 2); assert.notEqual(roots[0], roots[1]); assert.notEqual(a.rootId, b.rootId);
    assert.deepEqual(await readdir(roots[0]!), []); assert.deepEqual(await readdir(roots[1]!), []);
    const admitted = await a.execute('note-write', { bytes: originalBytes, expectedSha256: 'absent' }, context);
    assert.equal(admitted.ok, true); assert.equal(admitted.issuedMutation, true);
    assert.deepEqual(await readFile(join(roots[0]!, 'note.txt')), Buffer.from([65, 66, 67]));
    assert.equal(approvals.length, 1); const cached = approvals[0]!;
    assert.equal(Object.isFrozen(cached.request), true); assert.equal(cached.request.rootId, a.rootId);
    assert.equal(cached.signal.aborted, false); assert.equal(cached.expiresAt, 1500);
    const aStatus = a.status(), bStatus = b.status();
    let deniedRootStats = 0;
    // Observe the adapter's first native filesystem entry without replacing its behavior.
    fsPromises.lstat = ((...args: Parameters<typeof originalStat>) => {
      if (args[0] === roots[1]) deniedRootStats++;
      return originalStat(...args);
    }) as typeof originalStat; syncBuiltinESMExports();
    let replay;
    try { replay = await b.execute('note-write', { bytes: originalBytes, expectedSha256: 'absent' }, context); }
    finally { fsPromises.lstat = originalStat; syncBuiltinESMExports(); }
    assert.deepEqual(replay, { ok: false, reason: 'denied', issuedMutation: false });
    assert.equal(requestsB.length, 1); const requestB = requestsB[0]!;
    assert.notEqual(requestB, cached.request); assert.equal(requestB.rootId, b.rootId);
    const { rootId: rootA, ...tupleA } = cached.request, { rootId: rootB, ...tupleB } = requestB;
    assert.notEqual(rootA, rootB); assert.deepEqual(tupleB, tupleA, 'Only the freshly issued owned-root identity differs');
    assert.equal(deniedRootStats, 0); assert.deepEqual(nativeB, []);
    assert.equal(b.status().issuedMutations, bStatus.issuedMutations); assert.equal(b.status().nativeReadBytes, bStatus.nativeReadBytes);
    assert.deepEqual(await readdir(roots[1]!), []); assert.deepEqual(a.status(), aStatus);
    assert.deepEqual(await readFile(join(roots[0]!, 'note.txt')), Buffer.from([65, 66, 67]));
    allowFreshB = true;
    const fresh = await b.execute('note-write', { bytes: freshBytes, expectedSha256: 'absent' }, context);
    assert.equal(fresh.ok, true); assert.equal(fresh.issuedMutation, true); assert.equal(requestsB.length, 2);
    assert.notEqual(requestsB[1], cached.request); assert.notEqual(requestsB[1], requestB);
    assert.deepEqual(await readFile(join(roots[1]!, 'note.txt')), Buffer.from([88, 89, 90]));
    assert.deepEqual(await readFile(join(roots[0]!, 'note.txt')), Buffer.from([65, 66, 67]));
    assert.deepEqual(a.status(), aStatus); assert.equal(b.status().issuedMutations, 1);
  } finally {
    fsPromises.lstat = originalStat; syncBuiltinESMExports(); owner.abort(); delivery.abort();
    const closed = await Promise.allSettled(ports.map(port => port.close()));
    for (const result of closed) { assert.equal(result.status, 'fulfilled'); if (result.status === 'fulfilled') assert.equal(result.value.removed, true); }
    for (const port of ports) { assert.equal(port.status().rawPending, 0); assert.equal(port.status().timerArmed, false); }
    for (const path of roots) await assert.rejects(lstat(path), { code: 'ENOENT' });
  }
});
