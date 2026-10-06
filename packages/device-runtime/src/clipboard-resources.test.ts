import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const api = await import('../../../examples/clipboard-resources/process-port.mjs').catch((error: unknown) => {
  if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error; return undefined;
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let compilation: Promise<{ directory: string; sha256: string }> | undefined;
async function compiled() {
  if (!compilation) compilation = (async () => {
    const directory = await mkdtemp(join(tmpdir(), '101-private-clipboard-unit-'));
    for (const name of ['macos-pasteboard.swift', 'process-port.mjs']) await copyFile(new URL('../../../examples/clipboard-resources/' + name, import.meta.url), join(directory, name));
    const result = spawnSync('/usr/bin/swiftc', [join(directory, 'macos-pasteboard.swift'), '-o', join(directory, 'macos-pasteboard')], { timeout: 30000, encoding: 'utf8', maxBuffer: 131072 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return { directory, sha256: hash(await readFile(join(directory, 'macos-pasteboard'))) };
  })(); return compilation;
}
async function fixture(input: { deadlineMs?: number; onNative?: (event: { action?: string; stage: string }) => void } = {}) {
  assert.equal(typeof api?.createMacosPrivatePasteboardAdapter, 'function', 'a genuine private native pasteboard adapter exists');
  const provisioned = await compiled();
  const native = await import(pathToFileURL(join(provisioned.directory, 'process-port.mjs')).href);
  let owner = new AbortController();
  let allowed = true, current = true, at = 1000, hook: (() => void) | undefined, child: import('node:child_process').ChildProcess | undefined;
  const abort = new AbortController();
  const port = await native.createMacosPrivatePasteboardAdapter({ executableSha256: provisioned.sha256,
    scope: { principalId: 'owner', applicationId: 'private-clipboard-test', sessionId: 'fresh-test' }, now: () => at,
    deadlineMs: input.deadlineMs ?? 500,
    authorize(request: { expiresAt: number }) { hook?.(); return allowed ? { request, expiresAt: request.expiresAt, signal: owner.signal } : undefined; },
    onProcess(value: import('node:child_process').ChildProcess) { child = value; }, onNative: input.onNative });
  assert.ok(child?.pid);
  const context = { routeId: 'clipboard-route', generation: 1, operationId: '1', signal: abort.signal, isCurrent: () => current };
  const execute = (action: string, args: object = {}, selected = context) => port.execute(action, args, selected);
  return { port, child, abort, context, execute, allow(value: boolean) { allowed = value; if (!value) owner.abort(); else owner = new AbortController(); }, current(value: boolean) { current = value; if (!value) abort.abort(); },
    clock(value: number) { at = value; }, hook(callback?: () => void) { hook = callback; } };
}
const bytes = new TextEncoder().encode('actual private named pasteboard fixture');

test('private native adapter is explicit; import has no child and denied commands issue no native write/read', async () => {
  assert.equal(typeof api?.createMacosPrivatePasteboardAdapter, 'function');
  if (process.platform !== 'darwin') { assert.equal(await api!.createMacosPrivatePasteboardAdapter({}), undefined); return; }
  const h = await fixture(); try { assert.equal(h.port.status().nativeCommands, 0); h.allow(false);
    assert.equal((await h.execute('read')).reason, 'denied'); assert.equal(h.port.status().nativeCommands, 0);
  } finally { assert.deepEqual(await h.port.close(), { closed: true, cleared: true, released: true }); }
});
if (process.platform === 'darwin') {
test('actual AppKit write, independent native instance read and CAS clear preserve exact bounded bytes/revisions', async () => {
  const h = await fixture(); try {
    const written = await h.execute('write', { bytes, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' }); assert.ok(written.ok);
    assert.ok(written.value.revision > h.port.initialRevision); assert.equal(written.value.sha256, hash(bytes));
    const read = await h.execute('read'); assert.ok(read.ok); assert.deepEqual(read.value.bytes, bytes); assert.equal(read.value.sha256, hash(bytes));
    assert.equal(read.value.revision, written.value.revision);
    const cleared = await h.execute('clear', { expectedRevision: read.value.revision, expectedSha256: read.value.sha256 }); assert.ok(cleared.ok);
    assert.ok(cleared.value.revision > read.value.revision);
    const empty = await h.execute('read'); assert.ok(empty.ok); assert.equal(empty.value.hasValue, false); assert.deepEqual(empty.value.bytes, new Uint8Array());
  } finally { assert.equal((await h.port.close()).cleared, true); }
});
test('stale revision/hash cannot clear or replace the current private data', async () => {
  const h = await fixture(); try {
    const written = await h.execute('write', { bytes, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' }); assert.ok(written.ok);
    assert.equal((await h.execute('write', { bytes: new Uint8Array([0]), expectedRevision: h.port.initialRevision, expectedSha256: 'absent' })).reason, 'conflict');
    assert.equal((await h.execute('clear', { expectedRevision: written.value.revision, expectedSha256: '0'.repeat(64) })).reason, 'conflict');
    const read = await h.execute('read'); assert.ok(read.ok); assert.deepEqual(read.value.bytes, bytes);
  } finally { await h.port.close(); }
});
test('private native boundary rejects name/action substitution, extra fields/getters, and shadowed byte limits', async () => {
  const h = await fixture(); try { let gets = 0;
    assert.equal((await h.execute('general')).reason, 'invalid'); assert.equal((await h.execute('read', { name: 'NSGeneralPboard' })).reason, 'invalid');
    const args = Object.defineProperty({}, 'bytes', { enumerable: true, get() { gets++; return bytes; } });
    const getterArgs = Object.defineProperties({ expectedRevision: 0, expectedSha256: 'absent' }, Object.getOwnPropertyDescriptors(args));
    assert.equal((await h.execute('write', getterArgs)).reason, 'invalid'); assert.equal(gets, 0);
    const shadow = new Uint8Array(129); Object.defineProperty(shadow, 'byteLength', { value: 1 });
    assert.equal((await h.execute('write', { bytes: shadow, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' })).reason, 'quota');
    assert.equal(h.port.status().nativeCommands, 0);
  } finally { await h.port.close(); }
});
test('authorization reentrancy reserves raw work and cancellation before dispatch issues zero commands', async () => {
  const h = await fixture(); let nested: Promise<unknown> | undefined;
  try { h.hook(() => { nested = h.execute('read'); h.current(false); });
    assert.equal((await h.execute('read')).ok, false); assert.deepEqual(await nested, { ok: false, reason: 'busy', issuedEffect: false });
    assert.equal(h.port.status().nativeCommands, 0); assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().timerArmed, false);
  } finally { await h.port.close(); }
});
test('final clock and delivery callbacks cannot dispatch after native owner signal revocation', async () => {
  const provisioned = await compiled();
  const native = await import(pathToFileURL(join(provisioned.directory, 'process-port.mjs')).href);
  for (const boundary of ['clock', 'delivery']) {
    const owner = new AbortController(); let reads = 0;
    const port = await native.createMacosPrivatePasteboardAdapter({ executableSha256: provisioned.sha256,
      scope: { principalId: 'owner', applicationId: 'signal-revocation-test', sessionId: boundary },
      now() { if (boundary === 'clock' && ++reads === 7) owner.abort(); return 1000; },
      authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, signal: owner.signal }; } });
    try {
      const result = await port.execute('read', {}, { routeId: 'private-result-route', generation: 1,
        operationId: 'signal-revoked', signal: new AbortController().signal,
        isCurrent() { if (boundary === 'delivery' && ++reads === 11) owner.abort(); return true; } });
      assert.equal(owner.signal.aborted, true); assert.equal(result.ok, false); assert.equal('value' in result, false);
      assert.equal(port.status().nativeCommands, 0, 'Native signal revocation fences actual dispatch');
      await port.drain(); assert.equal(port.status().rawPending, 0); assert.equal(port.status().timerArmed, false);
    } finally { assert.deepEqual(await port.close(), { closed: true, cleared: true, released: true }); }
  }
});
test('a final delivery observer cannot revoke callback-only owner consent then dispatch native work', async () => {
  const provisioned = await compiled();
  const native = await import(pathToFileURL(join(provisioned.directory, 'process-port.mjs')).href);
  let allowed = true, reads = 0;
  const port = await native.createMacosPrivatePasteboardAdapter({ executableSha256: provisioned.sha256,
    scope: { principalId: 'owner', applicationId: 'cross-revocation-test', sessionId: 'fresh-test' }, now: () => 1000,
    authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, isCurrent: () => allowed }; } });
  try {
    const result = await port.execute('read', {}, { routeId: 'private-result-route', generation: 1,
      operationId: 'cross-revoked', signal: new AbortController().signal,
      isCurrent() { if (++reads === 17) allowed = false; return true; } });
    assert.equal(result.ok, false); assert.equal('value' in result, false);
    assert.equal(port.status().nativeCommands, 0, 'Callback-only owner authority must never permit native dispatch');
    assert.equal(port.status().rawPending, 0); assert.equal(port.status().timerArmed, false);
  } finally { assert.deepEqual(await port.close(), { closed: true, cleared: true, released: true }); }
});
test('forged and shadowed aborted owner signals cannot approve private native work', async () => {
  const provisioned = await compiled(), native = await import(pathToFileURL(join(provisioned.directory, 'process-port.mjs')).href);
  const owner = new AbortController(); owner.abort(); let getters = 0;
  Object.defineProperty(owner.signal, 'aborted', { get() { getters++; return false; } });
  let signal = Object.create(AbortSignal.prototype);
  const port = await native.createMacosPrivatePasteboardAdapter({ executableSha256: provisioned.sha256,
    scope: { principalId: 'owner', applicationId: 'signal-brand-test', sessionId: 'fresh-test' }, now: () => 1000,
    authorize(request: { expiresAt: number }) { return { request, expiresAt: request.expiresAt, signal }; } });
  try {
    const context = { routeId: 'private-result-route', generation: 1, operationId: 'brand-test', signal: new AbortController().signal, isCurrent: () => true };
    assert.equal((await port.execute('read', {}, context)).reason, 'denied');
    signal = owner.signal; assert.equal((await port.execute('read', {}, context)).reason, 'denied');
    assert.equal(getters, 0); assert.equal(port.status().nativeCommands, 0);
    signal = new AbortController().signal; assert.equal((await port.execute('read', {}, context)).ok, true);
  } finally { assert.deepEqual(await port.close(), { closed: true, cleared: true, released: true }); }
});
test('actual stopped native child retains issued raw operation through logical cancellation and late native return', async () => {
  const h = await fixture(); try { assert.ok(h.child.kill('SIGSTOP'));
    const pending = h.execute('write', { bytes, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' });
    await new Promise(resolve => setTimeout(resolve, 20)); h.abort.abort(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.issuedEffect, true); assert.equal('value' in result, false);
    assert.equal(h.port.status().rawPending, 1); assert.equal((await h.execute('read')).reason, 'busy');
    h.child.kill('SIGCONT'); await h.port.drain(); assert.equal(h.port.status().rawPending, 0);
    const fresh = { ...h.context, signal: new AbortController().signal };
    const observed = await h.execute('read', {}, fresh); assert.ok(observed.ok); assert.deepEqual(observed.value.bytes, bytes);
  } finally { h.child.kill('SIGCONT'); await h.port.close(); }
});
test('quiet logical expiry does not release genuine native raw reservation or expose late bytes', async () => {
  const h = await fixture({ deadlineMs: 100 }); try { h.child.kill('SIGSTOP'); const pending = h.execute('read');
    const result = await pending; assert.equal(result.reason, 'expired'); assert.equal(h.port.status().rawPending, 1); assert.equal(h.port.status().timerArmed, false);
    h.child.kill('SIGCONT'); await h.port.drain(); const fresh = await h.execute('read'); assert.ok(fresh.ok);
  } finally { h.child.kill('SIGCONT'); await h.port.close(); }
});
test('native result callback revocation prevents read bytes release after actual observed producer work', async () => {
  let revoke = false; const h = await fixture({ onNative(event) { if (revoke && event.action === 'read') h.abort.abort(); } });
  try { assert.ok((await h.execute('write', { bytes, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' })).ok); revoke = true;
    const result = await h.execute('read'); assert.equal(result.ok, false); assert.equal('value' in result, false); await h.port.drain();
  } finally { await h.port.close(); }
});
test('full 128-byte native value roundtrips; factory pin mismatch never launches substitute helper', async () => {
  const h = await fixture(); try { const content = new Uint8Array(128).map((_, index) => index);
    assert.ok((await h.execute('write', { bytes: content, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' })).ok);
    const read = await h.execute('read'); assert.ok(read.ok); assert.deepEqual(read.value.bytes, content);
  } finally { await h.port.close(); }
  const provisioned = await compiled(), native = await import(pathToFileURL(join(provisioned.directory, 'process-port.mjs')).href); let launches = 0;
  await assert.rejects(native.createMacosPrivatePasteboardAdapter({ executableSha256: '0'.repeat(64), scope: { principalId: 'owner', applicationId: 'test', sessionId: 'pins' },
    now: () => 1000, authorize: () => undefined, onProcess() { launches++; } })); assert.equal(launches, 0);
});
test('close inside native-result callback fences read data, raw work, deadline and owned process cleanup', async () => {
  let closing = false; const h = await fixture({ onNative() { if (closing) void h.port.close(); } });
  try { assert.ok((await h.execute('write', { bytes, expectedRevision: h.port.initialRevision, expectedSha256: 'absent' })).ok); closing = true;
    const result = await h.execute('read'); assert.equal(result.ok, false); assert.equal('value' in result, false);
    assert.deepEqual(await h.port.close(), { closed: true, cleared: true, released: true });
    assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().timerArmed, false); assert.equal(h.port.status().nativeAlive, false);
  } finally { await h.port.close(); }
});
test('authorization close and backward trusted clock never dispatch after authority loss or restore a closed board', async () => {
  const first = await fixture(); try { first.hook(() => { void first.port.close(); }); assert.equal((await first.execute('read')).ok, false);
    assert.equal(first.port.status().nativeCommands, 0); assert.equal(first.port.status().timerArmed, false);
  } finally { assert.equal((await first.port.close()).cleared, true); }
  const second = await fixture(); try { assert.ok((await second.execute('read')).ok); second.clock(999);
    assert.equal((await second.execute('read')).ok, false); second.clock(1001); assert.equal((await second.execute('read')).reason, 'closed');
  } finally { assert.equal((await second.port.close()).cleared, true); }
});
test('real stdin callback ownership remains reserved after native response and logical close until that callback returns', async () => {
  const h = await fixture(), stream = h.child.stdin; assert.ok(stream);
  const original = stream.write.bind(stream); let entered!: () => void, release: (() => void) | undefined;
  const captured = new Promise<void>(resolve => { entered = resolve; });
  stream.write = ((chunk: Uint8Array | string, callback?: (error?: Error | null) => void) => original(chunk, error => {
    release = () => callback?.(error); entered();
  })) as typeof stream.write;
  try { const pending = h.execute('read'); await captured; h.abort.abort(); assert.equal((await pending).ok, false);
    assert.equal(h.port.status().rawPending, 1); assert.equal(h.port.status().stdinCallbackPending, true);
    const closing = h.port.close(); assert.equal(h.port.status().rawPending, 1);
    assert.ok(release); release(); assert.equal((await closing).cleared, true);
    assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().nativeAlive, false);
  } finally { release?.(); stream.write = original; await h.port.close(); }
});
test('lifetime action attempts are bounded even when the owner declines every native command', async () => {
  const h = await fixture(); try { h.allow(false);
    for (let index = 0; index < 64; index++) assert.equal((await h.execute('read')).reason, 'denied');
    h.allow(true); assert.equal((await h.execute('read')).reason, 'quota'); assert.equal(h.port.status().nativeCommands, 0);
    assert.equal(h.port.status().rawPending, 0); assert.equal(h.port.status().timerArmed, false);
  } finally { await h.port.close(); }
});
test('thrown owner callback errors stay fail closed without executing error accessors or native commands', async () => {
  const h = await fixture(); let gets = 0;
  try { h.hook(() => { throw Object.defineProperty({}, 'code', { get() { gets++; throw Error('private callback detail'); } }); });
    const result = await h.execute('read'); assert.equal(result.ok, false); assert.equal(result.reason, 'unavailable');
    assert.equal(gets, 0); assert.equal(h.port.status().nativeCommands, 0); assert.equal(h.port.status().rawPending, 0);
  } finally { await h.port.close(); }
});
}
test.after(async () => { if (compilation) { const { directory } = await compilation;
  for (const name of await readdir(directory)) { assert.ok(['macos-pasteboard.swift', 'process-port.mjs', 'macos-pasteboard'].includes(name)); assert.ok((await lstat(join(directory, name))).isFile()); await unlink(join(directory, name)); }
  await rmdir(directory);
} });
