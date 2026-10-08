import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chunkResource, createDeviceRuntime, parseDeviceDescriptor, readVerifiedResource } from '@101/connect';
import { createOnvifSnapshotGateway } from '../../packages/hub-server/src/onvif-snapshot-gateway.ts';

async function cameraChild() {
  const child = spawn(process.execPath, [new URL('./software-camera.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
  const operations = []; let buffer = '', outputBytes = 0, exited = false, settled = false;
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  const close = async () => {
    if (exited) return; child.kill('SIGTERM');
    const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 250);
    let deadline; const bounded = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('software camera cleanup deadline')), 1000); });
    try { await Promise.race([closed, bounded]); }
    finally { clearTimeout(force); clearTimeout(deadline); }
  };
  try {
    const selected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('software camera readiness deadline')), 1500);
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
      child.once('error', error => finish(reject, error)); child.once('exit', () => finish(reject, new Error('software camera exited before ready')));
      child.stderr.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 16384) {
        if (settled) child.kill('SIGKILL'); else finish(reject, new Error('software camera stderr bound')); } });
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length; if (outputBytes > 16384 || buffer.length + chunk.length > 4096) {
          if (settled) child.kill('SIGKILL'); else finish(reject, new Error('software camera output bound')); return; }
        buffer += chunk.toString('utf8'); while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'); if (end > 1024) { finish(reject, new Error('software camera line bound')); return; }
          let message; try { message = JSON.parse(buffer.slice(0, end)); } catch (error) { finish(reject, error); return; } buffer = buffer.slice(end + 1);
          if (message.port) finish(resolve, message); else if (operations.length < 16) operations.push(message);
          else if (settled) child.kill('SIGKILL'); else finish(reject, new Error('software camera operation bound'));
        }
      });
    });
    return { child, operations, selected, close };
  } catch (error) { await close(); throw error; }
}
export async function runOnvifSnapshotConsumer() {
  const fixture = await cameraChild(), owner = new AbortController(), controlGrant = new AbortController(), mediaGrant = new AbortController();
  const scope = { principalId: 'camera-owner', applicationId: 'onvif-snapshot-example', sessionId: 'selected-loopback' };
  let controlAllowed = false, mediaAllowed = false, routeAllowed = false, epoch; const captures = [];
  const gateway = createOnvifSnapshotGateway({ ownerSignal: owner.signal, scope,
    selectedCamera: { id: 'software-camera', port: fixture.selected.port, profileToken: fixture.selected.profileToken, snapshotPath: fixture.selected.snapshotPath },
    authorizeCamera(request) { return controlAllowed ? { request, signal: controlGrant.signal, expiresAt: performance.now() + 5000 } : undefined; },
    authorizeMedia(request) { return mediaAllowed ? { request, signal: mediaGrant.signal, expiresAt: performance.now() + 5000 } : undefined; } });
  let source, sink;
  const runtime = createDeviceRuntime({ authorize(request) {
    if (routeAllowed && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId &&
      request.source.registrationId === source.id && request.sink.registrationId === sink.id) return { expiresAt: performance.now() + 1000, maxAgeMs: 1000 };
  } });
  const cap = (id, kind, permissions) => ({ id, semantic: 'example:selected-onvif-snapshot', schemaVersion: 1, kind,
    value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions,
    ...(kind === 'job' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'selected-onvif-camera', label: 'Selected ONVIF snapshot', revision: 1,
    adapter: { id: 'example:onvif-snapshot', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: [cap('capture-request', 'event', ['subscribe']), cap('capture', 'job', ['invoke'])] });
  source = runtime.registerSource({ device, capability: 'capture-request' });
  sink = runtime.registerSink({ device, capability: 'capture', async apply(_observation, context) {
    if (!epoch || !context.isCurrent() || context.signal.aborted) return;
    const result = await gateway.capture(epoch, { purpose: 'public-route-capture', signal: context.signal, deadline: performance.now() + 1000 });
    captures.push(result); if (result.ok && context.isCurrent()) context.reportEvidence('target-acknowledged');
  }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = () => runtime.route({ from: source, to: sink, ...scope, queueCapacity: 1 });
  try {
    assert.equal((await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 })).ok, false); assert.deepEqual(fixture.operations, []);
    controlAllowed = true; const started = await gateway.start({ purpose: 'selected-camera', deadline: performance.now() + 1000 }); assert.ok(started.ok); epoch = started.value;
    const deniedRoute = route(); assert.equal(deniedRoute.start().ok, false);
    assert.equal((await gateway.capture(epoch, { purpose: 'denied-media', signal: owner.signal, deadline: performance.now() + 1000 })).ok, false);
    mediaAllowed = true; routeAllowed = true; const connection = route(); assert.ok(connection.start().ok);
    const published = runtime.publish(source, true, { operationId: '1', deadline: performance.now() + 900 });
    assert.ok(published.ok, JSON.stringify(published)); runtime.flush();
    for (let i = 0; i < 200 && connection.status().pending; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.status().pending, 0); assert.equal(captures.length, 1); assert.ok(captures[0].ok);
    const firstDigest = createHash('sha256').update(captures[0].value.bytes).digest('hex');
    const direct = await gateway.capture(epoch, { purpose: 'fresh-media-grant', signal: owner.signal, deadline: performance.now() + 1000 }); assert.ok(direct.ok);
    const secondDigest = createHash('sha256').update(direct.value.bytes).digest('hex'); assert.notEqual(firstDigest, secondDigest);
    assert.equal(captures[0].value.evidence, 'target-bytes-observed');
    assert.equal(connection.operations()[0].effectEvidence, 'target-acknowledged');
    const snapshot = captures[0].value, resourceScope = { principalId: 'camera-viewer', applicationId: 'onvif-snapshot-example', sessionId: 'selected-resource' };
    let resourceAllowed = false, chunkReads = 0;
    const authorizeResource = request => resourceAllowed && request.principalId === resourceScope.principalId &&
      request.applicationId === resourceScope.applicationId && request.sessionId === resourceScope.sessionId &&
      request.reference.id === snapshot.reference.id && request.reference.sha256 === snapshot.reference.sha256 &&
      request.reference.byteLength === snapshot.reference.byteLength && request.reference.kind === 'blob'
      ? { expiresAt: performance.now() + 1000, maxBytes: snapshot.reference.byteLength } : undefined;
    const countedChunks = bytes => ({ async *[Symbol.asyncIterator]() { for await (const chunk of chunkResource(bytes, 64)) { chunkReads++; yield chunk; } } });
    await assert.rejects(readVerifiedResource({ reference: snapshot.reference, chunks: countedChunks(snapshot.bytes),
      signal: new AbortController().signal, now: () => performance.now(), ...resourceScope, authorize: authorizeResource }));
    assert.equal(chunkReads, 0);
    resourceAllowed = true;
    const verified = await readVerifiedResource({ reference: snapshot.reference, chunks: countedChunks(snapshot.bytes),
      signal: new AbortController().signal, now: () => performance.now(), ...resourceScope, authorize: authorizeResource });
    assert.equal(createHash('sha256').update(verified).digest('hex'), firstDigest);
    const changed = Uint8Array.from(snapshot.bytes); changed[20] ^= 1;
    await assert.rejects(readVerifiedResource({ reference: snapshot.reference, chunks: chunkResource(changed, 64),
      signal: new AbortController().signal, now: () => performance.now(), ...resourceScope, authorize: authorizeResource }));
    const resourceRevoke = new AbortController(); let reading;
    const enteredRead = new Promise(resolve => { reading = resolve; });
    const stalled = { [Symbol.asyncIterator]() { return { next() { reading(); return new Promise(() => {}); }, return() { return Promise.resolve({ done: true }); } }; } };
    const revokedRead = readVerifiedResource({ reference: snapshot.reference, chunks: stalled, signal: resourceRevoke.signal,
      now: () => performance.now(), ...resourceScope, authorize: authorizeResource });
    await enteredRead; resourceRevoke.abort(); await assert.rejects(revokedRead);
    connection.stop(); await gateway.stop(); assert.equal(gateway.status().rawPending, 0);
    return { status: 'pass', kind: 'separate-process-loopback-onvif-snapshot', digests: [firstDigest, secondDigest], operations: fixture.operations,
      checks: { deniedControlNoWire: true, deniedMediaNoGet: true, deniedPublicRouteNoCapture: true, actualSdkRoute: true,
        stableUriChangingJpeg: true, separateMediaGrantPerGet: true, deniedResourceReadNoChunks: true,
        approvedVerifiedBlobRead: true, corruptResourceRejected: true, revokedResourceReadRejected: true,
        blobReferenceWithJpegMetadata: snapshot.reference.mediaType === 'application/octet-stream' && snapshot.mediaType === 'image/jpeg',
        StopJoinedSocket: true, physicalSource: 'unverified' },
      openScope: ['remote-authentication', 'playback', 'PTZ', 'firmware', 'physical-camera-qualification'] };
  } finally { runtime.close(); await gateway.close(); await fixture.close(); }
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runOnvifSnapshotConsumer()));
