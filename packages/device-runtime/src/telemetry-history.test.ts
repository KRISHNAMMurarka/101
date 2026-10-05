import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import type { ValueSchema } from '@101/device-model';
import type { TelemetryStorage } from './telemetry-storage.ts';
import type { TelemetryAuthorization, TelemetryCaptureHandle } from './telemetry-history.ts';
import { createTelemetryHistory } from './telemetry-history.ts';

const create = createTelemetryHistory;
class LocalStorage implements TelemetryStorage {
  raw = new Map<string, unknown>();
  tail: Promise<unknown> = Promise.resolve();
  stall?: Promise<void>;
  transact<T>(owner: string, update: (state: unknown) => { state: unknown; result: T }): Promise<T> {
    const task = this.tail.then(async () => {
      await this.stall;
      const next = update(structuredClone(this.raw.get(owner)));
      this.raw.set(owner, structuredClone(next.state));
      return next.result;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}
const schema: ValueSchema = { type: 'record', fields: {
  residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
  ready: { type: 'boolean' },
} };
const request = { resourceId: 'process:memory', schemaVersion: 2, schema,
  fields: ['residentBytes', 'ready'], provenanceFields: ['calibrationRevision'] as const,
  destinationId: 'local-history' as const, purpose: 'memory-diagnostics', expiresAt: 100000 };
const uploadRequest = { resourceId: request.resourceId, schemaVersion: request.schemaVersion,
  fields: request.fields, provenanceFields: request.provenanceFields,
  destinationId: 'recipient', purpose: request.purpose, expiresAt: request.expiresAt };
const entry = { sourceTime: { clockId: 'process:monotonic', at: 987.25 }, quality: 'observed' as const,
  values: { residentBytes: 65536, ready: true }, provenance: { calibrationRevision: 3 } };
function harness(options: { storage?: LocalStorage; ownerId?: string; authorize?: TelemetryAuthorization;
  limits?: Parameters<typeof create>[0]['limits'] } = {}) {
  const storage = options.storage ?? new LocalStorage();
  let time = 1000;
  const history = create({ ownerId: options.ownerId ?? 'owner-a', storage, trustedNow: () => time,
    authorize: options.authorize ?? (scope => ({ scope, expiresAt: scope.expiresAt })), limits: options.limits });
  return { history, storage, time(value: number) { time = value; } };
}
async function capture(history: ReturnType<typeof create>): Promise<TelemetryCaptureHandle> {
  const result = await history.requestCapture(request);
  if (!result.ok) throw new Error(result.reason);
  return result.handle;
}

test('default history records nothing and restores no authority', async () => {
  const { history, storage } = harness();
  assert.equal(history.enqueue(Object.freeze({}), entry).ok, false);
  assert.deepEqual(await history.flush(), { ok: true, committed: 0 });
  assert.deepEqual((await history.exportPage()).ok, true);
  const result = await history.exportPage();
  assert.ok(result.ok); assert.equal(result.records.length, 0);
  const handle = await capture(history);
  assert.equal(history.enqueue(handle, entry).ok, true);
  assert.deepEqual(await history.flush(), { ok: true, committed: 1 });
  history.close();
  const reopened = harness({ storage }).history;
  assert.equal(reopened.enqueue(handle, entry).ok, false);
  assert.deepEqual(reopened.status().captureHandles, 0);
  assert.deepEqual(reopened.status().uploadHandles, 0);
  const page = await reopened.exportPage(); assert.ok(page.ok); assert.equal(page.records.length, 1);
});

test('authorization sees exact scope and denial or widened grants grant no recording', async () => {
  const denied = harness({ authorize(scope) {
    assert.deepEqual(scope, { action: 'capture', ownerId: 'owner-a', resourceId: 'process:memory', schemaVersion: 2,
      fields: ['residentBytes', 'ready'], provenanceFields: ['calibrationRevision'], destinationId: 'local-history',
      purpose: 'memory-diagnostics', expiresAt: 100000 });
    return undefined;
  } });
  assert.equal((await denied.history.requestCapture(request)).ok, false);
  const mismatch = harness({ authorize: scope => ({ scope: { ...scope, destinationId: 'other' }, expiresAt: scope.expiresAt }) });
  assert.equal((await mismatch.history.requestCapture(request)).ok, false);
  assert.equal(denied.storage.raw.size, 0);
});

test('capture rejects extra fields, getters, foreign handles, expired grants and free text schemas', async () => {
  const left = harness(), right = harness();
  const handle = await capture(left.history);
  assert.equal(right.history.enqueue(handle, entry).ok, false);
  assert.equal(left.history.enqueue({ ...handle }, entry).ok, false);
  assert.equal(left.history.enqueue(handle, { ...entry, values: { ...entry.values, credential: 'secret' } }).ok, false);
  const unwanted = { ...entry, provenance: { calibrationRevision: 3, secret: 'never' } };
  assert.equal(left.history.enqueue(handle, unwanted).ok, false);
  let getter = false;
  assert.equal(left.history.enqueue(handle, { ...entry, values: { get residentBytes() { getter = true; return 1; }, ready: true } }).ok, false);
  assert.equal(getter, false);
  assert.equal((await left.history.requestCapture({ ...request, schema: { type: 'record', fields: {
    residentBytes: { type: 'text', maxLength: 20 }, ready: { type: 'boolean' },
  } } })).ok, false);
  left.time(100000); assert.equal(left.history.enqueue(handle, entry).ok, false);
});

test('rows round trip each original source clock, timestamp, quality and selected provenance', async () => {
  const { history, storage } = harness(); const handle = await capture(history);
  assert.equal(history.enqueue(handle, entry).ok, true);
  assert.equal(history.enqueue(handle, { ...entry, sourceTime: { clockId: 'sensor:clock', at: 999999999 }, quality: 'unverified' }).ok, true);
  await history.flush();
  const page = await history.exportPage(); assert.ok(page.ok);
  assert.deepEqual(page.records.map(row => ({ sourceTime: row.sourceTime, quality: row.quality, values: row.values, provenance: row.provenance })),
    [entry, { ...entry, sourceTime: { clockId: 'sensor:clock', at: 999999999 }, quality: 'unverified' }]);
  assert.equal(page.records[0]?.ingestedAt, 1000);
  assert.equal(JSON.stringify([...storage.raw.values()]).includes('memory-diagnostics'), false);
});

test('pending bounds, owner quotas and trusted ingest expiry keep bounded oldest-first history', async () => {
  const { history, time } = harness({ limits: { maxRows: 2, retentionMs: 20 } });
  const handle = await capture(history);
  for (let i = 0; i < 16; i++) assert.equal(history.enqueue(handle, { ...entry, sourceTime: { clockId: 'process:monotonic', at: i } }).ok, true);
  assert.equal(history.enqueue(handle, entry).ok, false);
  assert.deepEqual(await history.flush(), { ok: true, committed: 16 });
  const page = await history.exportPage(); assert.ok(page.ok);
  assert.deepEqual(page.records.map(row => row.sourceTime.at), [14, 15]);
  time(1020); const expired = await history.exportPage(); assert.ok(expired.ok); assert.equal(expired.records.length, 0);
});

test('concurrent commits share atomic quota and deletion epoch fences delayed append', async () => {
  const storage = new LocalStorage(); const first = harness({ storage, limits: { maxRows: 2 } });
  const second = harness({ storage, limits: { maxRows: 2 } });
  const a = await capture(first.history), b = await capture(second.history);
  first.history.enqueue(a, entry); second.history.enqueue(b, entry);
  await Promise.all([first.history.flush(), second.history.flush()]);
  const page = await first.history.exportPage(); assert.ok(page.ok); assert.equal(page.records.length, 2);
  first.history.enqueue(a, entry);
  await second.history.delete();
  assert.equal((await first.history.flush()).ok, false);
  const empty = await second.history.exportPage(); assert.ok(empty.ok); assert.equal(empty.records.length, 0);
});

test('stalled persistence does not block a real embedded command route', async () => {
  const { history, storage } = harness(); const handle = await capture(history);
  let resume!: () => void; storage.stall = new Promise<void>(resolve => { resume = resolve; });
  history.enqueue(handle, entry); const persistence = history.flush();
  let delivered = false;
  const runtime = createDeviceRuntime({ now: () => 1000, authorize: () => ({ expiresAt: 2000, maxAgeMs: 1000 }) });
  const device = (id: string, sink: boolean) => ({ schemaVersion: 1, id, label: 'Command', revision: 1,
    adapter: { id: 'example:command', version: '1' }, runtime: { platform: 'embedded-application' }, capabilities: [{
      id: 'command', semantic: 'example:command', schemaVersion: 1, kind: sink ? 'command' : 'event', value: { type: 'boolean' },
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: sink ? ['invoke'] : ['subscribe'], ...(sink ? { ownership: { mode: 'observe' } } : {}),
    }] });
  const source = runtime.registerSource({ device: device('command-source', false), capability: 'command' });
  const sink = runtime.registerSink({ device: device('command-sink', true), capability: 'command', apply() { delivered = true; }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  assert.deepEqual(runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'commands', sessionId: 'session' }).start(), { ok: true, value: undefined });
  assert.equal(runtime.publish(source, true, { operationId: '1', deadline: 1500 }).ok, true); runtime.flush(); assert.equal(delivered, true);
  history.revoke(handle); resume(); assert.deepEqual(await persistence, { ok: true, committed: 0 }); runtime.close();
});

test('offline retry reuses its idempotency key and uploads only separately granted fields', async () => {
  const { history, time, storage } = harness(); const handle = await capture(history);
  history.enqueue(handle, entry); await history.flush();
  const received: unknown[] = []; let attempt = 0;
  const upload = await history.requestUpload({ ...uploadRequest, fields: ['residentBytes'], provenanceFields: [], destinationId: 'local-recipient' }, async batch => {
    received.push(batch); attempt++;
    if (attempt === 1) throw new Error('credential-sentinel must never escape');
    return { batchId: batch.batchId, recordIds: batch.records.map(row => row.id) };
  });
  assert.ok(upload.ok);
  assert.equal((await history.pumpUpload(upload.handle)).ok, false);
  assert.deepEqual(await history.pumpUpload(upload.handle), { ok: true, status: 'backoff', sent: 0 });
  time(2000); const sent = await history.pumpUpload(upload.handle); assert.ok(sent.ok); assert.equal(sent.sent, 1);
  const batches = received as { batchId: string; records: { values: object; provenance?: object }[] }[];
  assert.equal(batches[0]?.batchId, batches[1]?.batchId);
  assert.deepEqual(batches[1]?.records[0]?.values, { residentBytes: 65536 });
  assert.equal(batches[1]?.records[0]?.provenance, undefined);
  assert.equal(JSON.stringify([...storage.raw.values()]).includes('credential-sentinel'), false);
  assert.deepEqual(await history.pumpUpload(upload.handle), { ok: true, status: 'idle', sent: 0 });
});

test('delete aborts an in-flight upload and a late ACK cannot resurrect or acknowledge new rows', async () => {
  const { history, storage } = harness(); const handle = await capture(history);
  history.enqueue(handle, entry); await history.flush();
  let acknowledge!: (value: { batchId: string; recordIds: readonly number[] }) => void;
  let batchId = ''; let ids: readonly number[] = []; let signal!: AbortSignal;
  const upload = await history.requestUpload(uploadRequest, (batch, context) => {
    batchId = batch.batchId; ids = batch.records.map(row => row.id); signal = context.signal;
    return new Promise(resolve => { acknowledge = resolve; });
  }); assert.ok(upload.ok);
  const flight = history.pumpUpload(upload.handle);
  while (!acknowledge) await new Promise(resolve => setImmediate(resolve));
  await history.delete(); assert.equal(signal.aborted, true);
  const next = await capture(history); history.enqueue(next, entry); await history.flush();
  acknowledge({ batchId, recordIds: ids }); assert.equal((await flight).ok, false);
  const page = await history.exportPage(); assert.ok(page.ok); assert.equal(page.records.length, 1);
  assert.equal(JSON.stringify([...storage.raw.values()]).includes('recipient'), false);
});

test('corrupt and future envelopes, clock rollback and owner boundaries fail closed', async () => {
  const storage = new LocalStorage(); const left = harness({ storage }); const right = harness({ storage, ownerId: 'owner-b' });
  const a = await capture(left.history), b = await capture(right.history);
  left.history.enqueue(a, entry); right.history.enqueue(b, entry); await left.history.flush(); await right.history.flush();
  assert.equal((await left.history.delete()).ok, true);
  const other = await right.history.exportPage(); assert.ok(other.ok); assert.equal(other.records.length, 1);
  storage.raw.set('owner-a', { version: 999, credential: 'secret' });
  assert.equal((await left.history.exportPage()).ok, false);
  assert.equal((await left.history.delete()).ok, true);
  const recovered = await left.history.exportPage(); assert.ok(recovered.ok); assert.equal(recovered.records.length, 0);
  right.time(999); assert.equal(right.history.enqueue(b, entry).ok, false);
  assert.equal((await right.history.exportPage()).ok, false);
});

test('unavailable persistence and finite upload timeout leave live input bounded', async () => {
  const { history } = harness({ limits: { uploadTimeoutMs: 10, maxRetries: 1 } }); const handle = await capture(history);
  history.enqueue(handle, entry); await history.flush();
  const upload = await history.requestUpload(uploadRequest, () => new Promise(() => {})); assert.ok(upload.ok);
  const result = await history.pumpUpload(upload.handle); assert.equal(result.ok, false);
  assert.equal(history.status().uploadInFlight, false);
  history.close(); assert.equal(history.status().captureHandles, 0); assert.equal(history.enqueue(handle, entry).ok, false);
});

test('concurrent consent requests cannot exceed the in-memory authority ceiling', async () => {
  const { history } = harness();
  const grants = await Promise.all(Array.from({ length: 24 }, () => history.requestCapture(request)));
  assert.equal(grants.filter(value => value.ok).length, 16);
  assert.equal(history.status().captureHandles, 16);
});

for (const action of ['capture', 'upload'] as const) {
  test(`reentrant ${action} authorization reserves capacity before issuing nested requests`, async () => {
    let entered = false;
    const nested: Promise<{ ok: boolean }>[] = [];
    const { history } = harness({ authorize(scope) {
      if (!entered) {
        entered = true;
        for (let index = 0; index < 16; index++) nested.push(issue());
      }
      return { scope, expiresAt: scope.expiresAt };
    } });
    function issue(): Promise<{ ok: boolean }> {
      return action === 'capture' ? history.requestCapture(request) :
        history.requestUpload(uploadRequest, async batch => ({ batchId: batch.batchId, recordIds: batch.records.map(row => row.id) }));
    }
    const outer = issue(), results = await Promise.all([...nested, outer]);
    assert.equal(results.filter(result => result.ok).length, 16);
    assert.equal(history.status()[action === 'capture' ? 'captureHandles' : 'uploadHandles'], 16);
  });
}

test('quota eviction accounts bytes and export pagination remains bounded', async () => {
  const { history } = harness({ limits: { maxBytes: 4096 } }); const handle = await capture(history);
  for (let i = 0; i < 16; i++) history.enqueue(handle, entry);
  await history.flush();
  const first = await history.exportPage({ limit: 2 }); assert.ok(first.ok);
  assert.equal(first.records.length, 2); assert.ok(first.nextAfterId);
  const second = await history.exportPage({ limit: 2, afterId: first.nextAfterId }); assert.ok(second.ok);
  assert.equal(second.records[0]?.id, first.records[1]!.id + 1);
  assert.ok(history.status().evicted > 0);
  assert.equal((await history.exportPage({ limit: 65 })).ok, false);
});

test('storage failure preserves a bounded retry queue and never leaks its error', async () => {
  const { history, storage } = harness(); const handle = await capture(history);
  storage.transact = async () => { throw new Error('secret from backing engine'); };
  for (let i = 0; i < 16; i++) history.enqueue(handle, entry);
  assert.deepEqual(await history.flush(), { ok: false, reason: 'storage-unavailable' });
  assert.equal(history.enqueue(handle, entry).ok, false);
  assert.equal(history.status().pending, 16);
  history.close(); assert.equal(history.status().pending, 0);
});

test('wrong ACKs retry only a bounded number of times and expiry prevents reforwarding', async () => {
  const { history, time } = harness({ limits: { maxRetries: 1 } }); const handle = await capture(history);
  history.enqueue(handle, entry); await history.flush();
  let calls = 0;
  const upload = await history.requestUpload(uploadRequest, async () => { calls++; return { batchId: 'forged', recordIds: [] }; }); assert.ok(upload.ok);
  assert.deepEqual(await history.pumpUpload(upload.handle), { ok: false, reason: 'invalid-ack' });
  time(2000); assert.deepEqual(await history.pumpUpload(upload.handle), { ok: false, reason: 'invalid-ack' });
  time(4000); assert.deepEqual(await history.pumpUpload(upload.handle), { ok: false, reason: 'upload-exhausted' }); assert.equal(calls, 2);
  const expired = await history.requestUpload({ ...uploadRequest, expiresAt: 4010 }, async () => { assert.fail('Expired upload called'); }); assert.ok(expired.ok);
  time(4010); assert.equal((await history.pumpUpload(expired.handle)).ok, false);
});

test('closed schema corruption revokes all local authority while another owner remains readable', async () => {
  const { history, storage } = harness(); const handle = await capture(history);
  history.enqueue(handle, entry); await history.flush();
  const raw = storage.raw.get('owner-a') as { rows: { values: object }[] };
  raw.rows[0]!.values = { residentBytes: 65536, ready: true, secret: 'never-export' };
  assert.deepEqual(await history.exportPage(), { ok: false, reason: 'storage-invalid' });
  assert.equal(history.status().captureHandles, 0);
  assert.equal(history.enqueue(handle, entry).ok, false);
});

test('delete cancels a consent request already waiting for its durable epoch', async () => {
  const { history, storage } = harness();
  let resume!: () => void; storage.stall = new Promise(resolve => { resume = resolve; });
  const consent = history.requestCapture(request);
  const deletion = history.delete();
  resume();
  assert.deepEqual(await consent, { ok: false, reason: 'cancelled' });
  assert.equal((await deletion).ok, true); assert.equal(history.status().captureHandles, 0);
});

test('another recorder deletion fences a late ACK without acknowledging newly captured rows', async () => {
  const storage = new LocalStorage(), first = harness({ storage }), second = harness({ storage });
  const handle = await capture(first.history); first.history.enqueue(handle, entry); await first.history.flush();
  let resume!: (ack: { batchId: string; recordIds: number[] }) => void;
  let batch!: { batchId: string; records: readonly { id: number }[] };
  const upload = await first.history.requestUpload(uploadRequest, value => { batch = value; return new Promise(resolve => { resume = resolve; }); });
  assert.ok(upload.ok); const flight = first.history.pumpUpload(upload.handle);
  while (!resume) await new Promise(resolve => setImmediate(resolve));
  await second.history.delete(); const fresh = await capture(second.history);
  second.history.enqueue(fresh, entry); await second.history.flush();
  resume({ batchId: batch.batchId, recordIds: batch.records.map(row => row.id) });
  assert.deepEqual(await flight, { ok: false, reason: 'epoch-changed' });
  const rows = await second.history.exportPage(); assert.ok(rows.ok); assert.equal(rows.records.length, 1);
  assert.equal(first.history.status().uploaded, 0);
});
