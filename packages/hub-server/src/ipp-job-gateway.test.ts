import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClientRequest, createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { createIppJobGateway } from './ipp-job-gateway.ts';

test('selected IPP gateway exposes an explicit loopback job authority', () => {
  assert.equal(typeof createIppJobGateway, 'function');
});

test('remote, TLS, and unapproved printer identities never become a transport', async () => {
  const owner = new AbortController(), grant = new AbortController();
  const base = { ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'ipp-test', sessionId: 'selected-fixture' },
    authorizeJob: () => undefined, async readDocument() { return pdf; } };
  for (const uri of ['ipp://192.0.2.1:631/ipp/print', 'ipps://127.0.0.1:631/ipp/print',
    'ipp://127.0.0.1:631/ipp/print?other=1']) {
    assert.throws(() => createIppJobGateway({ ...base, selectedPrinter: { id: 'fixture', uri,
      format: 'application/pdf' }, authorizePrinter: () => undefined }));
  }
  const holder: { gateway?: ReturnType<typeof createIppJobGateway> } = {};
  holder.gateway = createIppJobGateway({ ...base,
    selectedPrinter: { id: 'fixture', uri: 'ipp://127.0.0.1:631/ipp/print', format: 'application/pdf' },
    authorizePrinter(request) { void holder.gateway!.stop(); return { request, signal: grant.signal, expiresAt: performance.now() + 1000 }; } });
  assert.deepEqual(await holder.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 }),
    { ok: false, reason: 'cancelled' });
  assert.equal(holder.gateway.statusLocal().rawPending, 0);
  await holder.gateway.close();
});

const u16 = (value: number) => Buffer.from([value >>> 8, value & 255]);
const u32 = (value: number) => Buffer.from([value >>> 24, value >>> 16, value >>> 8, value]);
function attribute(tag: number, name: string, value: string | number | boolean): Buffer {
  const key = Buffer.from(name), bytes = typeof value === 'string' ? Buffer.from(value) :
    typeof value === 'boolean' ? Buffer.from([value ? 1 : 0]) : u32(value);
  return Buffer.concat([Buffer.from([tag]), u16(key.length), key, u16(bytes.length), bytes]);
}
function ippResponse(id: number, extras: readonly Buffer[] = [], group = 4): Buffer {
  return Buffer.concat([Buffer.from([1, 1, 0, 0]), u32(id), Buffer.from([1]),
    attribute(0x47, 'attributes-charset', 'utf-8'), attribute(0x48, 'attributes-natural-language', 'en'),
    Buffer.from([group]), ...extras, Buffer.from([3])]);
}
const printerAttributes = [attribute(0x22, 'printer-is-accepting-jobs', true),
  attribute(0x49, 'document-format-supported', 'application/pdf')];
const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
async function serverFixture(reply: (operation: number, id: number, response: ServerResponse) => void,
  readDocument: (reference: string, signal: AbortSignal) => Promise<Uint8Array> = async reference => {
    assert.equal(reference, 'fixed-document'); return pdf;
  }, onJobAuthorize?: () => void) {
  const requests: number[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks), operation = body.readUInt16BE(2), id = body.readUInt32BE(4);
    requests.push(operation); reply(operation, id, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const uri = `ipp://127.0.0.1:${address.port}/ipp/print`;
  const owner = new AbortController(), grant = new AbortController(), jobGrant = new AbortController();
  const gateway = createIppJobGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'operator', applicationId: 'ipp-test', sessionId: 'selected-fixture' },
    selectedPrinter: { id: 'fixture', uri, format: 'application/pdf' },
    authorizePrinter(request) { return { request, signal: grant.signal, expiresAt: performance.now() + 10_000 }; },
    authorizeJob(request) { onJobAuthorize?.(); return { request, signal: jobGrant.signal, expiresAt: performance.now() + 10_000 }; },
    readDocument });
  return { gateway, server, requests, jobGrant, async close() { await gateway.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function send(response: ServerResponse, bytes: Buffer, status = 200) {
  response.writeHead(status, { 'content-type': 'application/ipp', 'content-length': bytes.length, connection: 'close' });
  response.end(bytes);
}

test('wrong request ID, malformed length, redirect and oversized IPP bodies fail closed', async () => {
  for (const mode of ['wrong-id', 'malformed', 'redirect', 'oversized']) {
    const f = await serverFixture((_operation, id, response) => {
      if (mode === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1/other' }); response.end(); return; }
      if (mode === 'oversized') { send(response, Buffer.alloc(70_000)); return; }
      const bytes = ippResponse(mode === 'wrong-id' ? id + 1 : id, printerAttributes);
      if (mode === 'malformed') bytes.writeUInt16BE(0xffff, 10);
      send(response, bytes);
    });
    try {
      const result = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
      assert.equal(result.ok, false, mode);
      assert.equal(f.gateway.statusLocal().rawPending, 0);
      assert.deepEqual(f.requests, [11]);
    } finally { await f.close(); }
  }
});

test('Stop aborts a held issued Print-Job and joins its socket closure without replay', async () => {
  let posted!: () => void;
  const printPosted = new Promise<void>(resolve => { posted = resolve; });
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else if (operation === 2) posted();
  });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const request = { localJobId: 'job-1', documentReference: 'fixed-document', sha256: createHash('sha256').update(pdf).digest('hex'),
      byteLength: pdf.length, purpose: 'approved-print-job', signal: new AbortController().signal,
      deadline: performance.now() + 1000 };
    const submitting = f.gateway.submit(started.value, request);
    await printPosted;
    await f.gateway.stop();
    const result = await submitting;
    assert.deepEqual(result, { ok: false, reason: 'cancelled', issued: true, uncertain: true });
    assert.equal(f.gateway.statusLocal().rawPending, 0);
    assert.deepEqual(f.requests, [11, 2]);
    assert.equal((await f.gateway.submit(started.value, { ...request, deadline: performance.now() + 1000 })).ok, false);
  } finally { await f.close(); }
});

test('an uncertain Print-Job keeps its local identity reserved against replay', async () => {
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else response.destroy();
  });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const request = { localJobId: 'job-replay', documentReference: 'fixed-document', sha256: createHash('sha256').update(pdf).digest('hex'),
      byteLength: pdf.length, purpose: 'approved-print-job', signal: new AbortController().signal,
      deadline: performance.now() + 1000 };
    const first = await f.gateway.submit(started.value, request);
    assert.deepEqual(first, { ok: false, reason: 'transport', issued: true, uncertain: true });
    assert.equal((await f.gateway.submit(started.value, { ...request, deadline: performance.now() + 1000 })).ok, false);
    assert.deepEqual(f.requests, [11, 2]);
  } finally { await f.close(); }
});

test('Stop waits a held document provider and sends no request after retirement', async () => {
  let began!: () => void, release!: (bytes: Uint8Array) => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<Uint8Array>(resolve => { release = resolve; });
  const f = await serverFixture((_operation, id, response) => send(response, ippResponse(id, printerAttributes)),
    async () => { began(); return held; });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const submitting = f.gateway.submit(started.value, { localJobId: 'held-read', documentReference: 'fixed-document',
      sha256: createHash('sha256').update(pdf).digest('hex'), byteLength: pdf.length, purpose: 'approved-print-job',
      signal: new AbortController().signal, deadline: performance.now() + 1000 });
    await reading;
    let stopped = false;
    const stopping = f.gateway.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release(pdf);
    await stopping;
    assert.deepEqual(await submitting, { ok: false, reason: 'cancelled' });
    assert.deepEqual(f.requests, [11]);
  } finally { release(pdf); await f.close(); }
});

test('revoking an independent job grant before the final wire gate sends no Print-Job', async () => {
  let revoke = () => {};
  class RevokingDocument extends Uint8Array {
    override [Symbol.iterator]() {
      queueMicrotask(revoke);
      return super[Symbol.iterator]();
    }
  }
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else send(response, ippResponse(id, [attribute(0x21, 'job-id', 1), attribute(0x23, 'job-state', 5)], 2));
  }, async () => new RevokingDocument(pdf));
  revoke = () => f.jobGrant.abort();
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const result = await f.gateway.submit(started.value, { localJobId: 'revoked-job', documentReference: 'fixed-document',
      sha256: createHash('sha256').update(pdf).digest('hex'), byteLength: pdf.length, purpose: 'approved-print-job',
      signal: new AbortController().signal, deadline: performance.now() + 1000 });
    assert.deepEqual(result, { ok: false, reason: 'cancelled' });
    assert.deepEqual(f.requests, [11]);
    assert.equal(f.gateway.statusLocal().uncertainJobs, 0);
  } finally { await f.close(); }
});

test('an uncertain local job ID remains reserved across Stop and a fresh epoch', async () => {
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else response.destroy();
  });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const request = { localJobId: 'job-replay-across-epoch', documentReference: 'fixed-document',
      sha256: createHash('sha256').update(pdf).digest('hex'), byteLength: pdf.length, purpose: 'approved-print-job',
      signal: new AbortController().signal, deadline: performance.now() + 1000 };
    const first = await f.gateway.submit(started.value, request);
    assert.ok(!first.ok); assert.equal(first.issued, true);
    assert.equal(f.gateway.statusLocal().uncertainJobs, 1);
    await f.gateway.stop();
    const fresh = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(fresh.ok);
    assert.equal((await f.gateway.submit(fresh.value, { ...request, deadline: performance.now() + 1000 })).ok, false);
    assert.equal((await f.gateway.status(fresh.value, request.localJobId, { purpose: 'unknown-job',
      signal: request.signal, deadline: performance.now() + 1000 })).ok, false);
    assert.deepEqual(f.requests, [11, 2, 11]);
  } finally { await f.close(); }
});

test('revoking the job grant closes a held issued request without waiting for its deadline', async () => {
  let posted!: () => void;
  const printPosted = new Promise<void>(resolve => { posted = resolve; });
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else posted();
  });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const submitting = f.gateway.submit(started.value, { localJobId: 'grant-revoked-inflight',
      documentReference: 'fixed-document', sha256: createHash('sha256').update(pdf).digest('hex'),
      byteLength: pdf.length, purpose: 'approved-print-job', signal: new AbortController().signal,
      deadline: performance.now() + 4000 });
    await printPosted;
    f.jobGrant.abort();
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('revoked job socket remained open')), 1000); });
    const result = await Promise.race([submitting, timeout]);
    clearTimeout(timer);
    assert.deepEqual(result, { ok: false, reason: 'cancelled', issued: true, uncertain: true });
    assert.equal(f.gateway.statusLocal().rawPending, 0);
  } finally { await f.close(); }
});

test('Stop aborts a cooperative document provider through its supplied signal', async () => {
  let began!: () => void, release!: (bytes: Uint8Array) => void, supplied!: AbortSignal;
  const reading = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<Uint8Array>(resolve => { release = resolve; });
  const f = await serverFixture((_operation, id, response) => send(response, ippResponse(id, printerAttributes)),
    async (_reference, signal) => { supplied = signal; signal.addEventListener('abort', () => release(pdf), { once: true });
      began(); return held; });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const submitting = f.gateway.submit(started.value, { localJobId: 'cooperative-read', documentReference: 'fixed-document',
      sha256: createHash('sha256').update(pdf).digest('hex'), byteLength: pdf.length, purpose: 'approved-print-job',
      signal: new AbortController().signal, deadline: performance.now() + 1000 });
    await reading;
    const stopping = f.gateway.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(supplied.aborted, true);
    await stopping;
    assert.equal((await submitting).ok, false);
    assert.deepEqual(f.requests, [11]);
  } finally { release(pdf); await f.close(); }
});

test('IPP attribute groups bind critical values and allow Unsupported before Printer', async () => {
  const wrongGroup = await serverFixture((_operation, id, response) =>
    send(response, ippResponse(id, printerAttributes, 1)));
  try {
    assert.equal((await wrongGroup.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 })).ok, false);
  } finally { await wrongGroup.close(); }
  const valid = await serverFixture((_operation, id, response) => {
    const prefix = ippResponse(id);
    const body = Buffer.concat([prefix.subarray(0, prefix.length - 2), Buffer.from([5]),
      attribute(0x44, 'unrequested-attribute', 'unsupported'), Buffer.from([4]), ...printerAttributes, Buffer.from([3])]);
    send(response, body);
  });
  try {
    const started = await valid.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.equal(started.ok, true);
  } finally { await valid.close(); }
});

test('a synchronous native end failure retains raw ownership until the assigned socket closes', async () => {
  const f = await serverFixture((_operation, id, response) => send(response, ippResponse(id, printerAttributes)));
  const originalEnd = Object.getOwnPropertyDescriptor(ClientRequest.prototype, 'end');
  const restoreEnd = () => originalEnd
    ? Object.defineProperty(ClientRequest.prototype, 'end', originalEnd)
    : Reflect.deleteProperty(ClientRequest.prototype, 'end');
  let entered!: () => void;
  const atEnd = new Promise<void>(resolve => { entered = resolve; });
  const socket = new EventEmitter() as EventEmitter & { destroy(): void };
  socket.destroy = () => {};
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    Object.defineProperty(ClientRequest.prototype, 'end', { configurable: true, writable: true,
      value: function (this: ClientRequest) {
        Object.defineProperty(this, 'socket', { configurable: true, writable: true, value: socket });
        this.emit('socket', socket);
        entered();
        throw new Error('injected native end failure');
      } });
    const submitting = f.gateway.submit(started.value, { localJobId: 'throwing-native-end',
      documentReference: 'fixed-document', sha256: createHash('sha256').update(pdf).digest('hex'),
      byteLength: pdf.length, purpose: 'approved-print-job', signal: new AbortController().signal,
      deadline: performance.now() + 1000 });
    await atEnd;
    restoreEnd();
    let settled = false;
    void submitting.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    socket.emit('close');
    const result = await submitting;
    assert.ok(!result.ok); assert.equal(result.issued, true);
    assert.equal(f.gateway.statusLocal().rawPending, 0);
  } finally {
    restoreEnd();
    socket.emit('close'); await f.close();
  }
});

test('RFC-valid operation-only Cancel-Job response accepts the request without invented Job attributes', async () => {
  const f = await serverFixture((operation, id, response) => {
    if (operation === 11) send(response, ippResponse(id, printerAttributes));
    else if (operation === 2) send(response, ippResponse(id, [
      attribute(0x45, 'job-uri', 'ipp://127.0.0.1/jobs/1'),
      attribute(0x21, 'job-id', 1), attribute(0x23, 'job-state', 5),
      attribute(0x44, 'job-state-reasons', 'job-printing'),
    ], 2));
    else if (operation === 8) {
      const prefix = ippResponse(id);
      send(response, Buffer.concat([prefix.subarray(0, prefix.length - 2), Buffer.from([3])]));
    }
  });
  try {
    const started = await f.gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok);
    const submitted = await f.gateway.submit(started.value, { localJobId: 'cancel-valid-job',
      documentReference: 'fixed-document', sha256: createHash('sha256').update(pdf).digest('hex'),
      byteLength: pdf.length, purpose: 'approved-print-job', signal: new AbortController().signal,
      deadline: performance.now() + 1000 });
    assert.ok(submitted.ok);
    const result = await f.gateway.cancel(started.value, 'cancel-valid-job', { purpose: 'approved-cancel',
      signal: new AbortController().signal, deadline: performance.now() + 1000 });
    assert.deepEqual(result, { ok: true, value: { cancelRequestAccepted: true } });
    assert.deepEqual(f.requests, [11, 2, 8]);
  } finally { await f.close(); }
});
