import assert from 'node:assert/strict';
import { parseDeviceDescriptor } from '@101/device-model';
import { createDeviceRuntime } from '@101/device-runtime';
import { createNativeRssBridge, NATIVE_RSS_PROFILE } from './process-port.mjs';

/** Actual C child -> validated host bridge -> independently granted SDK read
 * route. This selected software caller never treats native bytes as authority. */
export async function runNativeResourceRuntimeExample({ executable, sha256 }) {
  const scope = Object.freeze({ ownerId: 'owned-c-rss', applicationId: 'native-resource-example', sessionId: 'first' });
  let allowRegistration = false, allowRead = false, allowRoutes = false, registrationSignal = new AbortController();
  let readSignal = new AbortController(), rawChild, source, viewed = [], nativeOpened = 0, retired = [];
  const routes = new Map(), routeSignal = new AbortController();
  const bridge = createNativeRssBridge({ executable, sha256, scope,
    authorizeRegistration(request) { return allowRegistration ? { request, expiresAt: performance.now() + 9000,
      signal: registrationSignal.signal } : undefined; },
    authorizeRead(request) { return allowRead ? { request, expiresAt: performance.now() + 900,
      signal: readSignal.signal } : undefined; },
    onRetire(observation) {
      retired.push(observation.epoch);
      if (source) { runtime.setReadiness(source, 'unavailable'); runtime.unregister(source); source = undefined; }
    },
    onProcess(child) { rawChild = child; nativeOpened++; },
  });
  const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'native-c-rss-host',
    maxPendingDeliveries: 1, authorize(request) {
      const key = JSON.stringify([request.principalId, request.applicationId, request.sessionId,
        request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
      if (!allowRoutes || !routes.has(key) || routeSignal.signal.aborted) return;
      return { expiresAt: performance.now() + 900, maxAgeMs: 1000, maxHz: 100 };
    } });
  function descriptor(epoch) {
    return parseDeviceDescriptor({ schemaVersion: 1, id: `owned-c-rss:${epoch}`, label: 'Owned C process RSS', revision: 1,
      adapter: { id: 'example:fixed-own-rss-c', version: '1.0.0' }, runtime: { platform: 'macos-arm64-private-stdio' }, capabilities: [
        { id: 'rss', semantic: 'example:own-c-process-rss', schemaVersion: 1, kind: 'property',
          value: { type: 'scalar', unit: 'By', min: 1, max: Number.MAX_SAFE_INTEGER }, permissions: ['read'],
          delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 1000 } },
        { id: 'viewer', semantic: 'example:own-c-process-rss', schemaVersion: 1, kind: 'property',
          value: { type: 'scalar', unit: 'By', min: 1, max: Number.MAX_SAFE_INTEGER }, permissions: ['write'],
          ownership: { mode: 'observe' }, delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 1000 } },
      ] });
  }
  let sink, oldSource, oldHandle, firstSample, copiedHandleAccepted = false, oldHandleAccepted = false;
  function route() {
    const request = { from: source, to: sink, principalId: scope.ownerId, applicationId: scope.applicationId,
      sessionId: scope.sessionId, sourceOperation: 'read', leaseMs: 900, queueCapacity: 1 };
    const key = JSON.stringify([scope.ownerId, scope.applicationId, scope.sessionId, source.id, sink.id, 'read', 'write']);
    routes.set(key, true); return runtime.route(request);
  }
  async function bindAndRead(handle, sample) {
    const device = descriptor(sample.epoch);
    source = runtime.registerSource({ device, capability: 'rss' });
    sink = runtime.registerSink({ device, capability: 'viewer', apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      viewed.push(observation);
    }, release() {} });
    assert.ok(runtime.setReadiness(sink, 'available').ok);
    assert.ok(runtime.setReadiness(source, 'available', performance.now() + 1000).ok);
    assert.ok(runtime.publish(source, sample.rssBytes, { timestamp: performance.now(), clockDomain: 'native-c-rss-host',
      quality: 'valid', provenance: { sourceTime: sample.sourceTime, nativeReceivedAt: sample.receivedAt,
        nativeReceiptClockId: sample.receiptClockId } }).ok);
    const connection = route();
    allowRoutes = false; assert.equal(connection.start().ok, false);
    const permitted = route(); allowRoutes = true; assert.ok(permitted.start().ok); runtime.flush();
    assert.equal(viewed.at(-1).value, sample.rssBytes);
    permitted.stop(); await permitted.whenSettled?.();
    void handle;
  }
  try {
    assert.equal(bridge.status().starts, 0);
    assert.equal((await bridge.start()).ok, false); assert.equal(nativeOpened, 0);
    allowRegistration = true;
    const started = await bridge.start(); assert.ok(started.ok, JSON.stringify({ started, status: bridge.status(), nativeOpened })); oldHandle = started.value;
    assert.equal(nativeOpened, 1);
    assert.equal((await bridge.read(oldHandle)).ok, false);
    allowRead = true;
    const read = await bridge.read(oldHandle); assert.ok(read.ok); firstSample = read.value;
    assert.ok(firstSample.rssBytes > 0 && firstSample.sequence === 1);
    assert.notEqual(firstSample.sourceTime.clockId, firstSample.receiptClockId);
    copiedHandleAccepted = (await bridge.read({ ...oldHandle })).ok;
    assert.equal(copiedHandleAccepted, false);
    await bindAndRead(oldHandle, firstSample);
    oldSource = source;
    registrationSignal.abort(); await bridge.stop();
    oldHandleAccepted = (await bridge.read(oldHandle)).ok;
    assert.equal(oldHandleAccepted, false); assert.equal(source, undefined);
    assert.equal(runtime.route({ from: oldSource, to: sink, principalId: scope.ownerId,
      applicationId: scope.applicationId, sessionId: scope.sessionId, sourceOperation: 'read' }).start().ok, false);
    runtime.unregister(sink);
    registrationSignal = new AbortController(); readSignal = new AbortController();
    allowRegistration = false; allowRead = false; allowRoutes = false; routes.clear();
    assert.equal((await bridge.start()).ok, false); assert.equal(nativeOpened, 1);
    allowRegistration = true;
    const replacement = await bridge.start(); assert.ok(replacement.ok); assert.notEqual(replacement.value, oldHandle);
    assert.equal((await bridge.read(oldHandle)).ok, false);
    assert.equal((await bridge.read(replacement.value)).ok, false);
    allowRead = true;
    const next = await bridge.read(replacement.value); assert.ok(next.ok);
    assert.notEqual(next.value.epoch, firstSample.epoch); assert.equal(next.value.sequence, 1);
    await bindAndRead(replacement.value, next.value);
    assert.ok(retired.includes(firstSample.epoch));
    process.kill(rawChild.pid, 'SIGSTOP');
    const pending = bridge.read(replacement.value);
    assert.equal(bridge.status().nativePending, 1);
    const viewedBeforeStop = viewed.length;
    const stopping = bridge.stop();
    assert.equal(bridge.status().rawReservations, 1);
    assert.equal(bridge.status().nativePending, 1);
    assert.equal(source, undefined);
    const stoppedRead = await pending; assert.equal(stoppedRead.ok, false); assert.equal(stoppedRead.issued, true);
    await stopping;
    assert.equal(viewed.length, viewedBeforeStop);
    assert.equal(bridge.status().nativePending, 0);
    assert.equal(bridge.status().rawReservations, 0);
    assert.equal((await bridge.start()).ok, false);
    return Object.freeze({ profile: NATIVE_RSS_PROFILE, rssBytes: firstSample.rssBytes,
      sourceTime: firstSample.sourceTime, receivedAt: firstSample.receivedAt,
      nativeOpened, generations: bridge.status().starts, rawPending: bridge.status().nativePending,
      childAlive: bridge.status().childAlive, cleanupVerified: bridge.status().cleanupVerified,
      oldHandleAccepted, copiedHandleAccepted,
      checks: ['denied-open-no-child', 'separate-read-grant', 'actual-C-own-RSS', 'separate-public-route-grant',
        'source-clock-vs-host-receipt', 'copied-and-stale-handle-denial', 'revoke-before-retire-callback',
        'fresh-epoch-registration-read-and-route-grants', 'Stop-fences-held-native-return', 'real-child-close-settles-raw-slot'],
      scope: 'Selected cooperative same-user macOS C child only; no hostile same-process isolation, other OS, physical device or public distribution claim.' });
  } finally { await bridge.close(); runtime.close(); }
}
