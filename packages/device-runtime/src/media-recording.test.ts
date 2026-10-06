import test from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerDataStorage } from './owner-data.ts';
import type { MediaRecordingOptions, MediaRecordingRequest, MediaRecordingResult } from './media-recording.ts';

// Cooperative transaction fixtures prove controller fences, not native persistence.
const api = await import('./media-recording.ts').catch(() => undefined);
function memory() {
  const rows = new Map<string, unknown>();
  let entered: (() => void) | undefined, release: (() => void) | undefined, announce: (() => void) | undefined;
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    entered?.(); announce?.(); announce = undefined;
    if (release) await new Promise<void>(resolve => { release = resolve; });
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    const next = mutation(structuredClone(rows.get(owner)));
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    rows.set(owner, structuredClone(next.state)); return next.result;
  } };
  return { storage, rows, hold(callback?: () => void) { entered = callback; release = () => {};
      return new Promise<void>(resolve => { announce = resolve; }); },
    settle() { const done = release; release = undefined; entered = undefined; done?.(); } };
}
const source = Object.freeze({ deviceId: 'source-a', capabilityId: 'camera-frame', registrationId: 'registration-a',
  applicationId: 'recorder-app', sessionId: 'session-a', clockId: 'producer-js:a' });
const capture = { source, purpose: 'selected-software-recording', expiresAt: 2000, retentionMs: 60000 };
function value<T>(result: MediaRecordingResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
function setup(overrides: Partial<MediaRecordingOptions> = {}, port = memory()) {
  assert.ok(api, 'opt-in application-rgba-recording/1 needs a recording/playback controller');
  const owner = new AbortController(), consent = new AbortController(), delivery = new AbortController();
  let now = 1000, allowed = true;
  const requests: MediaRecordingRequest[] = [];
  const recording = api.createMediaRecording({ ownerId: 'owner-a', ownerSignal: owner.signal,
    storage: port.storage, trustedNow: () => now, authorize(request) {
      requests.push(request); return allowed ? { request, signal: consent.signal, expiresAt: request.expiresAt } : undefined;
    }, ...overrides });
  return { recording, port, owner, consent, delivery, requests,
    time(at: number) { now = at; }, allow(yes: boolean) { allowed = yes; },
    context: () => ({ source, signal: delivery.signal, isCurrent: () => !delivery.signal.aborted }),
    frame(sequence = 1, byte = 23) { return { bytes: new Uint8Array(256).fill(byte), sequence,
      sourceTime: { clockId: source.clockId, at: sequence * 7.25 }, quality: 'observed' as const,
      decodedMediaTime: sequence / 10 }; },
    async seed() { const selected = value(await recording.requestCapture(capture));
      assert.ok(recording.enqueue(selected.handle, this.frame(), this.context()).ok);
      assert.equal(value(await recording.flush()).committed, 1); return selected; },
  };
}
const read = (clipId: string) => ({ clipId, destinationId: 'owned-player', purpose: 'owner-playback', expiresAt: 2000 });

test('construction/live delivery is inert and every recording operation needs explicit exact consent', async () => {
  const f = setup(); assert.equal(f.port.rows.size, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.recording.enqueue({}, f.frame(), f.context()).ok, false);
  f.allow(false); assert.deepEqual(await f.recording.requestCapture(capture), { ok: false, reason: 'denied' });
  assert.equal(f.port.rows.size, 0); assert.equal(f.recording.status().captures, 0); await f.recording.close();
});

test('source clock, fractional source time, sequence, quality and decoded media position roundtrip unchanged', async () => {
  const f = setup(), selected = await f.seed();
  const player = value(await f.recording.requestPlayback(read(selected.clipId)));
  f.time(1020); const pulled = value(await f.recording.pull(player));
  assert.deepEqual(pulled.frame.sourceTime, { clockId: 'producer-js:a', at: 7.25 });
  assert.equal(pulled.frame.sequence, 1); assert.equal(pulled.frame.quality, 'observed');
  assert.equal(pulled.frame.decodedMediaTime, .1); assert.deepEqual(pulled.frame.bytes, new Uint8Array(256).fill(23));
  assert.equal(pulled.playback.at, 1020); assert.equal(pulled.playback.clockId, 'recording-host-emission');
  assert.equal(pulled.playback.index, 0); await f.recording.close();
});

test('restart restores only data; foreign/forged handles and absent or denied fresh reviews fail closed', async () => {
  const f = setup(), selected = await f.seed(); await f.recording.close();
  const reopened = setup({}, f.port); assert.equal(reopened.recording.status().captures, 0);
  assert.equal(reopened.recording.status().players, 0);
  assert.equal(reopened.recording.enqueue(selected.handle, f.frame(2), f.context()).ok, false);
  assert.deepEqual(await reopened.recording.pull({}), { ok: false, reason: 'invalid-handle' });
  reopened.allow(false); assert.equal((await reopened.recording.requestPlayback(read(selected.clipId))).ok, false);
  reopened.allow(true); assert.equal(value(await reopened.recording.listReviewed({ purpose: 'review', expiresAt: 2000 })).length, 1);
  await reopened.recording.close();
});

test('closed selected frames reject getters, extra fields, foreign source, oversized bytes and repeated sequence', async () => {
  const f = setup(), selected = value(await f.recording.requestCapture(capture)); let getters = 0;
  const hostile = { ...f.frame(), get quality() { getters++; return 'observed' as const; } };
  assert.equal(f.recording.enqueue(selected.handle, hostile, f.context()).ok, false); assert.equal(getters, 0);
  const extra = { ...f.frame(), secret: 'never-store' };
  assert.equal(f.recording.enqueue(selected.handle, extra, f.context()).ok, false);
  assert.equal(f.recording.enqueue(selected.handle, { ...f.frame(), bytes: new Uint8Array(257) }, f.context()).ok, false);
  assert.equal(f.recording.enqueue(selected.handle, f.frame(), { ...f.context(), source: { ...source, deviceId: 'other' } }).ok, false);
  assert.ok(f.recording.enqueue(selected.handle, f.frame(), f.context()).ok);
  assert.equal(f.recording.enqueue(selected.handle, f.frame(), f.context()).ok, false); await f.recording.close();
});

test('actual delivery abort and expiry retire capture and queued frames without interpreting source clock as TTL', async () => {
  const f = setup(), selected = value(await f.recording.requestCapture(capture));
  assert.ok(f.recording.enqueue(selected.handle, { ...f.frame(), sourceTime: { clockId: source.clockId, at: 999999999 } }, f.context()).ok);
  f.delivery.abort(); assert.equal(value(await f.recording.flush()).committed, 0);
  f.time(2000); f.recording.sweep(); assert.equal(f.recording.status().captures, 0); assert.equal(f.recording.status().pendingFrames, 0);
  await f.recording.close();
});

test('pending admission and storage quotas are finite and live admission never waits for the backend', async () => {
  const f = setup(), selected = value(await f.recording.requestCapture(capture));
  for (let sequence = 1; sequence <= 4; sequence++) assert.ok(f.recording.enqueue(selected.handle, f.frame(sequence), f.context()).ok);
  assert.deepEqual(f.recording.enqueue(selected.handle, f.frame(5), f.context()), { ok: false, reason: 'backpressure' });
  const entered = f.port.hold(); const flushing = f.recording.flush(); await entered;
  assert.equal(f.recording.status().rawPending, 1);
  assert.equal((await f.recording.requestCapture(capture)).ok, false);
  f.port.settle(); assert.equal(value(await flushing).committed, 4); await f.recording.close();
});

test('authorizer reservation survives reentry and exact returned request/intrinsic signal are mandatory', async () => {
  let nested: Promise<unknown> | undefined;
  const f = setup({ authorize(request) { nested = f.recording.requestCapture(capture);
    return { request, signal: new AbortController().signal, expiresAt: request.expiresAt }; } });
  assert.ok((await f.recording.requestCapture(capture)).ok); assert.deepEqual(await nested, { ok: false, reason: 'busy' });
  await f.recording.close();
  const forged = setup({ authorize(request) { return { request: { ...request }, signal: {} as AbortSignal, expiresAt: request.expiresAt }; } });
  assert.equal((await forged.recording.requestCapture(capture)).ok, false); assert.equal(forged.port.rows.size, 0); await forged.recording.close();
});

test('clock/approval callout owner cancellation cannot install handles, listeners or durable data', async () => {
  const owner = new AbortController();
  const f = setup({ ownerSignal: owner.signal, trustedNow() { owner.abort(); return 1000; } });
  assert.equal((await f.recording.requestCapture(capture)).ok, false); assert.equal(f.recording.status().captures, 0);
  assert.equal(f.port.rows.size, 0); await f.recording.close();
  const g = setup({ authorize(request) { g.owner.abort(); return { request, signal: g.consent.signal, expiresAt: request.expiresAt }; } });
  assert.equal((await g.recording.requestCapture(capture)).ok, false); assert.equal(g.port.rows.size, 0); await g.recording.close();
});

test('close during storage setup stays pending until the late actual storage call settles', async () => {
  const port = memory(); let closed: Promise<void> | undefined, finished = false;
  const f = setup({}, port);
  const entered = port.hold(() => { closed = f.recording.close().then(() => { finished = true; }); });
  const pending = f.recording.requestCapture(capture);
  await entered; assert.equal(f.recording.status().rawPending, 1);
  await Promise.resolve(); assert.equal(finished, false); port.settle();
  assert.equal((await pending).ok, false); await closed; assert.equal(finished, true);
  assert.equal(f.recording.status().rawPending, 0); assert.equal(port.rows.size, 0);
});

test('seek fences a held old pull and explicit reviewed delete fences other-tab producers before append', async () => {
  const f = setup(), selected = await f.seed(), player = value(await f.recording.requestPlayback(read(selected.clipId)));
  const entered = f.port.hold(); const old = f.recording.pull(player); await entered;
  assert.ok(f.recording.seek(player, 0).ok); f.port.settle(); assert.equal((await old).ok, false);
  const other = setup({}, f.port), external = value(await other.recording.requestCapture(capture));
  assert.ok(other.recording.enqueue(external.handle, other.frame(), other.context()).ok);
  assert.ok((await f.recording.deleteReviewed({ purpose: 'remove-owned', expiresAt: 2000 })).ok);
  assert.deepEqual(await other.recording.flush(), { ok: false, reason: 'epoch-changed' });
  assert.equal(value(await f.recording.listReviewed({ purpose: 'review', expiresAt: 2000 })).length, 0);
  await f.recording.close(); await other.recording.close();
});

test('retention uses trusted ingest TTL, other owners survive and export is bounded redacted verified bytes', async () => {
  const f = setup(), a = await f.seed(), other = setup({ ownerId: 'owner-b' }, f.port); await other.seed();
  const page = value(await f.recording.exportPage({ ...read(a.clipId), afterIndex: 0, limit: 4 }));
  assert.equal(page.frames.length, 1); assert.equal(page.frames[0]?.bytes.byteLength, 256);
  const exported = JSON.stringify(page); assert.equal(exported.includes('owner-a'), false); assert.equal(exported.includes('AbortSignal'), false);
  assert.equal((await f.recording.exportPage({ ...read(a.clipId), afterIndex: 0, limit: 5 })).ok, false);
  assert.ok((await f.recording.deleteReviewed({ clipId: a.clipId, purpose: 'remove', expiresAt: 2000 })).ok);
  assert.equal(value(await other.recording.listReviewed({ purpose: 'review', expiresAt: 2000 })).length, 1);
  await f.recording.close(); await other.recording.close();
});

test('future/corrupt/foreign envelope and backward trusted clocks do not regain authority', async () => {
  for (const state of [{ version: 99 }, { ownerId: 'other' }, { secret: 'must-not-export' }]) {
    const port = memory(); port.rows.set('owner-a', state); const f = setup({}, port);
    assert.deepEqual(await f.recording.requestCapture(capture), { ok: false, reason: 'storage-invalid' }); await f.recording.close();
  }
  const f = setup(); await f.seed(); f.time(999);
  assert.equal((await f.recording.listReviewed({ purpose: 'review', expiresAt: 2000 })).ok, false);
  assert.equal(f.recording.status().clockFault, true); await f.recording.close();
});

test('expiry purges on next execution and a four-clip/32-frame ledger never silently overwrites retained frames', async () => {
  const f = setup(), selected = value(await f.recording.requestCapture({ ...capture, retentionMs: 100 }));
  assert.ok(f.recording.enqueue(selected.handle, f.frame(), f.context()).ok); assert.equal(value(await f.recording.flush()).committed, 1);
  f.time(1100); assert.equal(value(await f.recording.sweep()).removed, 1);
  assert.equal(value(await f.recording.listReviewed({ purpose: 'review', expiresAt: 2000 })).length, 0); await f.recording.close();
  const bounded = setup(), large = value(await bounded.recording.requestCapture(capture));
  for (let batch = 0; batch < 8; batch++) {
    for (let frame = 1; frame <= 4; frame++) assert.ok(bounded.recording.enqueue(large.handle, bounded.frame(batch * 4 + frame), bounded.context()).ok);
    assert.equal(value(await bounded.recording.flush()).committed, 4);
  }
  assert.ok(bounded.recording.enqueue(large.handle, bounded.frame(33), bounded.context()).ok);
  assert.deepEqual(await bounded.recording.flush(), { ok: false, reason: 'quota' });
  for (let i = 0; i < 3; i++) assert.ok((await bounded.recording.requestCapture(capture)).ok);
  assert.deepEqual(await bounded.recording.requestCapture(capture), { ok: false, reason: 'quota' });
  assert.equal(value(await bounded.recording.listReviewed({ purpose: 'review', expiresAt: 2000 }))[0]?.frameCount, 32);
  await bounded.recording.close();
});

test('quiet consent expiry aborts the owned transaction guard but retains raw work until actual settlement', async () => {
  const f = setup(); await f.seed(); const entered = f.port.hold();
  const held = f.recording.exportPage({ ...read('clip:1'), afterIndex: 0, limit: 4 }); await entered;
  f.time(2000); const sweep = f.recording.sweep(); assert.deepEqual(await sweep, { ok: false, reason: 'busy' });
  assert.equal(f.recording.status().rawPending, 1); f.port.settle(); assert.equal((await held).ok, false);
  await f.recording.close(); assert.equal(f.recording.status().rawPending, 0); assert.equal(f.recording.status().listeners, 0);
});

test('the lifetime attempt bound is reserved even for denied reviews', async () => {
  const f = setup(); f.allow(false);
  for (let i = 0; i < 64; i++) assert.deepEqual(await f.recording.listReviewed({ purpose: 'review', expiresAt: 2000 }), { ok: false, reason: 'denied' });
  assert.deepEqual(await f.recording.listReviewed({ purpose: 'review', expiresAt: 2000 }), { ok: false, reason: 'exhausted' });
  assert.equal(f.recording.status().attempts, 64); assert.equal(f.port.rows.size, 0); await f.recording.close();
});

test('a source-current callback revoking capture on its final call cannot enqueue one late frame', async () => {
  const f = setup(), selected = value(await f.recording.requestCapture(capture)); let calls = 0;
  const context = { ...f.context(), isCurrent() { if (++calls === 2) f.recording.revoke(selected.handle); return true; } };
  assert.equal(f.recording.enqueue(selected.handle, f.frame(), context).ok, false);
  assert.equal(f.recording.status().captures, 0); assert.equal(f.recording.status().pendingFrames, 0); await f.recording.close();
});

test('changed retained bytes cannot be played or exported under an unchanged old digest', async () => {
  const f = setup(), selected = await f.seed();
  const state = f.port.rows.get('owner-a') as { clips: { frames: { hex: string }[] }[] };
  state.clips[0]!.frames[0]!.hex = '00'.repeat(256);
  const player = value(await f.recording.requestPlayback(read(selected.clipId)));
  assert.deepEqual(await f.recording.pull(player), { ok: false, reason: 'storage-invalid' });
  assert.deepEqual(await f.recording.exportPage({ ...read(selected.clipId), afterIndex: 0, limit: 4 }), { ok: false, reason: 'storage-invalid' });
  await f.recording.close();
});

test('a playback lease cannot outlive its selected retained clip even when the owner grant lasts longer', async () => {
  const f = setup();
  try { const captureShort = value(await f.recording.requestCapture({ ...capture, retentionMs: 100 }));
    assert.ok(f.recording.enqueue(captureShort.handle, f.frame(), f.context()).ok); assert.equal(value(await f.recording.flush()).committed, 1);
    value(await f.recording.requestPlayback(read(captureShort.clipId))); assert.equal(f.recording.status().players, 1);
    f.time(1100); await f.recording.sweep(); assert.equal(f.recording.status().players, 0);
  } finally { await f.recording.close(); }
});

test('approved playback lifetime exposes one genuine immutable epoch signal and never renews on lookup', async () => {
  const f = setup();
  try {
    const selected = await f.seed(), player = value(await f.recording.requestPlayback(read(selected.clipId)));
    const method = (f.recording as unknown as { playbackLifetime?: (handle: unknown) => MediaRecordingResult<Readonly<{signal: AbortSignal; expiresAt: number}>> }).playbackLifetime;
    assert.equal(typeof method, 'function', 'Caller-owned output needs the selected approved playback retirement signal');
    const first = value(method!(player)); assert.ok(first.signal instanceof AbortSignal); assert.equal(first.expiresAt, 2000);
    f.time(1050); const second = value(method!(player)); assert.equal(second.signal, first.signal); assert.equal(second.expiresAt, first.expiresAt);
    let release = 0; first.signal.addEventListener('abort', () => { release++; }, { once: true });
    f.recording.revoke(player); assert.equal(first.signal.aborted, true); assert.equal(release, 1);
    assert.equal(method!(player).ok, false); assert.equal(method!({}).ok, false);
  } finally { await f.recording.close(); }
});

test('capture consent expiring at the final durable guard cannot commit a frame before its timer runs', async () => {
  const rows = new Map<string, unknown>(); let at = 1000, finalGuardCalls = 0;
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    const next = mutation(structuredClone(rows.get(owner)));
    const state = next.state as { clips: { frames: unknown[] }[] };
    // Faithful synchronous engine commit phase: no timer task can run between this
    // clock advancement and the final guard/put. This is a cooperative engine seam.
    if (state.clips.some(clip => clip.frames.length > 0)) { at = 2000; finalGuardCalls++; }
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    rows.set(owner, structuredClone(next.state)); return next.result;
  } };
  const f = setup({ storage, trustedNow: () => at });
  try {
    const selected = value(await f.recording.requestCapture(capture));
    assert.ok(f.recording.enqueue(selected.handle, f.frame(), f.context()).ok);
    const flushed = await f.recording.flush(); assert.equal(finalGuardCalls, 1);
    const committed = rows.get('owner-a') as { clips: { frames: unknown[] }[] };
    assert.equal(committed.clips[0]!.frames.length, 0, 'Expired consent must fence the final transaction guard before put');
    assert.equal(flushed.ok, false);
  } finally { await f.recording.close(); }
});

test('a final durable guard source observer advancing the clock cannot commit after capture consent expiry', async () => {
  const rows = new Map<string, unknown>(); let at = 1000, finalGuard = false, observerAdvances = 0;
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    const next = mutation(structuredClone(rows.get(owner)));
    const state = next.state as { clips: { frames: unknown[] }[] };
    finalGuard = state.clips.some(clip => clip.frames.length > 0);
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw new Error('unit-cancelled');
    rows.set(owner, structuredClone(next.state)); return next.result;
  } };
  const f = setup({ storage, trustedNow: () => at });
  try {
    const selected = value(await f.recording.requestCapture(capture));
    const context = { ...f.context(), isCurrent() {
      if (finalGuard) { at = 2000; observerAdvances++; }
      return true;
    } };
    assert.ok(f.recording.enqueue(selected.handle, f.frame(), context).ok); at = 1999;
    const flushed = await f.recording.flush(); assert.equal(observerAdvances, 1);
    const committed = rows.get('owner-a') as { clips: { frames: unknown[] }[] };
    assert.equal(committed.clips[0]!.frames.length, 0, 'Observer clock advancement must be checked after the final callback before put');
    assert.equal(flushed.ok, false);
  } finally { await f.recording.close(); }
});
