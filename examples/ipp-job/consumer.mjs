import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createIppJobGateway } from '../../packages/hub-server/src/ipp-job-gateway.ts';

const document = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const digest = createHash('sha256').update(document).digest('hex');
async function softwarePrinter() {
  const child = spawn(process.execPath, [new URL('./software-printer.mjs', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const operations = [];
  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (message.uri) resolve(message.uri);
        if (message.operation) operations.push(message.operation);
      }
    });
    child.once('exit', () => reject(new Error('software printer exited before readiness')));
  });
  return { child, uri: await ready, operations };
}

export async function runIppJobConsumer() {
  const fixture = await softwarePrinter();
  const owner = new AbortController(), printerGrant = new AbortController(), jobGrant = new AbortController();
  const scope = { principalId: 'owned-operator', applicationId: 'ipp-job-example', sessionId: 'loopback-job-session' };
  let printerAllowed = false, jobAllowed = false, reads = 0;
  const gateway = createIppJobGateway({ ownerSignal: owner.signal, scope,
    selectedPrinter: { id: 'fixture-printer', uri: fixture.uri, format: 'application/pdf' },
    authorizePrinter(request) { return printerAllowed ? { request, signal: printerGrant.signal, expiresAt: performance.now() + 10_000 } : undefined; },
    authorizeJob(request) { return jobAllowed ? { request, signal: jobGrant.signal, expiresAt: performance.now() + 10_000 } : undefined; },
    async readDocument(reference) { assert.equal(reference, 'fixture-document'); reads++; return document; } });
  const grantedRoutes = new Set(), commandResults = [], deadlines = new Map();
  const routeKey = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
    request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
  const runtime = createDeviceRuntime({ authorize: request => grantedRoutes.has(routeKey(request))
    ? { expiresAt: performance.now() + 10_000, maxAgeMs: 1000 } : undefined });
  const capability = (id, kind, permissions) => ({ id, semantic: 'example:fixed-pdf-job', schemaVersion: 1,
    kind, value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions,
    ...(kind === 'job' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-ipp-job', label: 'Software IPP job', revision: 1,
    adapter: { id: 'example:ipp-loopback', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: [capability('control', 'event', ['subscribe']), capability('submit', 'job', ['invoke'])] });
  const source = runtime.registerSource({ device, capability: 'control' });
  let epoch;
  const sink = runtime.registerSink({ device, capability: 'submit', async apply(_observation, context) {
    const deadline = deadlines.get(context.operationId); deadlines.delete(context.operationId);
    if (!epoch || !context.isCurrent() || context.signal.aborted || typeof deadline !== 'number') return;
    const result = await gateway.submit(epoch, { localJobId: context.operationId, documentReference: 'fixture-document',
      sha256: digest, byteLength: document.length, purpose: 'selected-pdf-submit', signal: context.signal, deadline });
    commandResults.push(result);
    if (result.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence(result.value.evidence);
  }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = allow => {
    if (allow) grantedRoutes.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
      source.id, sink.id, 'subscribe', 'invoke']));
    return runtime.route({ from: source, to: sink, ...scope, queueCapacity: 1 });
  };
  const operation = () => ({ purpose: 'selected-job-inspection', signal: owner.signal, deadline: performance.now() + 1000 });
  const settle = async connection => {
    for (let turn = 0; turn < 200 && connection.status().pending; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.status().pending, 0);
  };
  try {
    assert.equal((await gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 })).ok, false);
    assert.deepEqual(fixture.operations, []);
    printerAllowed = true;
    const started = await gateway.start({ purpose: 'selected-printer', deadline: performance.now() + 1000 });
    assert.ok(started.ok, JSON.stringify(started)); epoch = started.value;
    assert.deepEqual(fixture.operations, [0x000b]);
    assert.equal(route(false).start().ok, false);
    assert.equal((await gateway.submit(epoch, { localJobId: 'denied', documentReference: 'fixture-document', sha256: digest,
      byteLength: document.length, purpose: 'selected-pdf-submit', signal: owner.signal, deadline: performance.now() + 1000 })).ok, false);
    assert.equal(reads, 0);
    jobAllowed = true;
    const connection = route(true); assert.ok(connection.start().ok);
    const deadline = performance.now() + 1000; deadlines.set('1', deadline);
    assert.ok(runtime.publish(source, true, { operationId: '1', deadline }).ok);
    runtime.flush(); await settle(connection);
    assert.equal(commandResults.length, 1); assert.ok(commandResults[0].ok, JSON.stringify(commandResults[0]));
    assert.equal(commandResults[0].value.serverState, 5);
    assert.equal(connection.operations()[0].effectEvidence, 'target-acknowledged');
    assert.notEqual(connection.operations()[0].effectEvidence, 'observed');
    const status = await gateway.status(epoch, '1', operation()); assert.ok(status.ok, JSON.stringify(status));
    assert.equal(status.value.serverState, 5);
    const cancellation = await gateway.cancel(epoch, '1', operation()); assert.ok(cancellation.ok);
    assert.equal(cancellation.value.cancelRequestAccepted, true);
    const cancelled = await gateway.status(epoch, '1', operation()); assert.ok(cancelled.ok);
    assert.equal(cancelled.value.serverState, 7);
    assert.equal((await gateway.status(epoch, 'forged-job', operation())).ok, false);
    assert.equal((await gateway.submit(epoch, { localJobId: 'expired', documentReference: 'fixture-document', sha256: digest,
      byteLength: document.length, purpose: 'selected-pdf-submit', signal: owner.signal, deadline: performance.now() - 1 })).ok, false);
    runtime.revoke(connection);
    assert.equal(runtime.publish(source, true, { operationId: '2', deadline: performance.now() + 1000 }).ok, false);
    await gateway.stop();
    assert.equal(gateway.statusLocal().rawPending, 0);
    assert.equal((await gateway.status(epoch, '1', operation())).ok, false);
    assert.deepEqual(fixture.operations, [0x000b, 0x0002, 0x0009, 0x0008, 0x0009]);
    return { status: 'pass', kind: 'separate-process-loopback-ipp', limits: {
      replayFence: 'current-gateway-lifetime-only', unknownRemoteJob: 'operator-reconciliation-required',
      printerIdentity: 'selected-loopback-endpoint-without-process-authentication', physicalOutput: 'unverified',
    }, checks: { deniedPrinterNoWire: true,
      deniedJobNoRead: true, deniedRouteNoSubmit: true, acceptedJobNotPrinted: true, freshStatus: true,
      cancelAcceptedThenObserved: true, forgedJobDenied: true, expiredNoWire: true, staleEpoch: true,
      actualSocketClosed: true, noPhysicalPrinterClaim: true }, operations: fixture.operations, documentReads: reads };
  } finally {
    runtime.close(); await gateway.close();
    fixture.child.kill('SIGTERM');
    await new Promise(resolve => fixture.child.once('exit', resolve));
  }
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runIppJobConsumer()));
