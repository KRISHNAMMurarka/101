import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExtensionFilesystemStorage } from './filesystem-storage.mjs';
import { verifyProcessorExtensionRelease, validateProcessorGraph, createProcessorInstallation,
  createDeviceRuntime, createProcessorFailureController } from '@101/connect';

/** The harness supplies only a disposable local provisioned profile. Release data cannot select imports. */
export async function runExtensionInstallationExample(directory, phase) {
  const fixture = JSON.parse(readFileSync(join(directory, 'provision.json'), 'utf8'));
  const publicKey = await crypto.subtle.importKey('jwk', fixture.publisherKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const v1 = fixture.releases[0], v2 = fixture.releases[1];
  // These two paths are fixed by this reviewed host. Nothing in a manifest is used as a module specifier.
  const source1 = new Uint8Array(readFileSync(new URL('../external-processor/processor.mjs', import.meta.url)));
  const source2 = new Uint8Array(readFileSync(new URL('./temperature-band-v2.mjs', import.meta.url)));
  assert.equal(await verifyProcessorExtensionRelease(v1, source1, publicKey), true);
  assert.equal(await verifyProcessorExtensionRelease(v2, source2, publicKey), true);
  const storage = createExtensionFilesystemStorage(join(directory, 'store'));
  let granted = true, now = 1000;
  const approvals = [], effects = [];
  const store = createProcessorInstallation({ ownerId: 'local-owner', storage, now: () => now,
    publisherTrust: id => id === 'example:local-publisher' ? { key: publicKey, minimumSequence: 1 } : undefined,
    authorize(scope) {
      approvals.push(scope.action);
      return granted && scope.ownerId === 'local-owner' ? { expiresAt: now + 60_000, isCurrent: () => granted } : undefined;
    },
  });
  const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  const configuration = { onAt: 30, offAt: 28 };
  const vectors = strict => ({ configuration, invalidConfiguration: { onAt: 'bad', offAt: 28 }, invalidInputs: { temperature: 'bad' },
    cases: [{ inputs: { temperature: 30 }, ...(strict ? {} : { outputs: { switch: true } }) },
      { inputs: { temperature: 31 }, ...(strict ? { outputs: { switch: true } } : {}) },
      { inputs: { temperature: 28 }, outputs: { switch: false } }] });
  let runtime;
  try {
    if (phase === 'install') {
      take(await store.install(v1, source1)); take(await store.install(v1, source1));
      const stored = take(await store.readRelease(v1.packageId, v1.version));
      assert.deepEqual(stored.source, source1); assert.equal(await verifyProcessorExtensionRelease(stored.release, stored.source, publicKey), true);
      const inspection = take(await store.inspect()); assert.equal(inspection.packages[0].active, false);
      assert.equal(inspection.packages[0].releases.length, 1);
      return { phase, profile: 'reviewed-processor-extension/1', installedRealBytes: true, inactive: true, idempotent: true };
    }
    if (phase === 'reload') {
      const inspection = take(await store.inspect()); assert.equal(inspection.packages[0].active, false);
      assert.equal(inspection.packages[0].selectedVersion, '1.0.0', 'historical selection survives without current authority');
      assert.equal(approvals.length, 0, 'restart inspection cannot request or restore any grant');
      const stored = take(await store.readRelease(v1.packageId, v1.version)); assert.deepEqual(stored.source, source1);
      assert.equal(await verifyProcessorExtensionRelease(stored.release, stored.source, publicKey), true);
      granted = false;
      // Import is still fixed reviewed code; the new denied activation cannot execute its factory.
      const { createTemperatureBand } = await import('../external-processor/processor.mjs');
      const denied = await store.activateReviewed({ packageId: v1.packageId, version: v1.version, codeSha256: v1.source.sha256,
        trusted: { manifest: v1.manifest, source: source1, factory: createTemperatureBand }, fixture: vectors(false), configuration, retireOwned() {} });
      assert.equal(denied.ok, false);
      return { phase, inactiveAfterCleanProcessRestart: true, realBytesAndSignatureReverified: true, deniedFreshApproval: true };
    }
    if (phase === 'activate-and-close') {
      const { createTemperatureBand } = await import('../external-processor/processor.mjs');
      const activation = take(await store.activateReviewed({ packageId: v1.packageId, version: v1.version, codeSha256: v1.source.sha256,
        trusted: { manifest: v1.manifest, source: source1, factory: createTemperatureBand }, fixture: vectors(false), configuration, retireOwned() {} }));
      assert.deepEqual(activation.processor.process({ temperature: 30 }), { switch: true });
      assert.equal(take(await store.inspect()).packages[0].active, true);
      store.close(); assert.equal(activation.isCurrent(), false);
      return { phase, realActivation: true, selectedHistoryPersisted: true, ownedAuthorityRetiredBeforeExit: true };
    }
    assert.equal(phase, 'lifecycle');
    // Both releases have already passed signature, complete manifest pin and actual bytes verification above.
    const firstFactory = (await import('../external-processor/processor.mjs')).createTemperatureBand;
    const secondFactory = (await import('./temperature-band-v2.mjs')).createTemperatureBand;
    const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 }, boolean = { type: 'boolean' };
    const device = (id, capabilities) => ({ schemaVersion: 1, id, label: id, revision: 1,
      adapter: { id: 'example:extension-host', version: '1.0.0' }, runtime: { platform: 'node' }, capabilities });
    const sensor = device('sensor', [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
      kind: 'sample', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }]);
    const derived = device('processor', [
      { id: 'input', semantic: 'example:temperature', schemaVersion: 1, kind: 'property', value: scalar,
        delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['write'], ownership: { mode: 'observe' } },
      { id: 'output', semantic: 'example:switch', schemaVersion: 1, kind: 'event', value: boolean,
        delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
    ]);
    const sink = device('sink', [{ id: 'switch', semantic: 'example:switch', schemaVersion: 1, kind: 'command', value: boolean,
      delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } }]);
    let controller, live, sequence = 0;
    const routeApprovals = [];
    runtime = createDeviceRuntime({ now: () => now, authorize(permission) {
      routeApprovals.push(permission);
      const identity = permission.principalId === 'local-owner' && permission.applicationId === 'extension-example' && permission.sessionId === 'local';
      const input = permission.source.deviceId === sensor.id && permission.source.capabilityId === 'temperature' && permission.sourceOperation === 'subscribe' &&
        permission.sink.deviceId === derived.id && permission.sink.capabilityId === 'input' && permission.sinkOperation === 'write';
      const output = permission.source.deviceId === derived.id && permission.source.capabilityId === 'output' && permission.sourceOperation === 'subscribe' &&
        permission.sink.deviceId === sink.id && permission.sink.capabilityId === 'switch' && permission.sinkOperation === 'invoke';
      return granted && identity && (input || output) ? { expiresAt: 60_000, maxAgeMs: 1000, maxHz: 10 } : undefined;
    } });
    const input = runtime.registerSource({ device: sensor, capability: 'temperature' });
    const output = runtime.registerSource({ device: derived, capability: 'output' });
    const processInput = runtime.registerSink({ device: derived, capability: 'input', apply(observation, context) {
      if (context.isCurrent() && live?.isCurrent()) controller.run('processor', { temperature: observation.value },
        { switch: { operationId: String(++sequence), deadline: now + 500 } });
    }, release() {} });
    const effectSink = runtime.registerSink({ device: sink, capability: 'switch', apply(observation, context) {
      if (context.isCurrent() && live?.isCurrent()) effects.push(observation.value);
    }, release() {} });
    const identity = { principalId: 'local-owner', applicationId: 'extension-example', sessionId: 'local' };
    let inputRoute, outputRoute;
    const request = (release, source, factory, strict) => ({ packageId: release.packageId, version: release.version,
      codeSha256: release.source.sha256, trusted: { manifest: release.manifest, source, factory }, fixture: vectors(strict), configuration,
      retireOwned() { controller?.stop(); inputRoute?.stop(); outputRoute?.stop(); runtime.setReadiness(output, 'unavailable'); } });
    const bind = release => {
      for (const handle of [input, output, processInput, effectSink]) assert.equal(runtime.setReadiness(handle, 'available').ok, true);
      inputRoute = runtime.route({ from: input, to: processInput, ...identity }); outputRoute = runtime.route({ from: output, to: effectSink, ...identity });
      assert.equal(inputRoute.start().ok, true); assert.equal(outputRoute.start().ok, true);
      const plan = validateProcessorGraph({ schemaVersion: 1, nodes: [
        { id: 'sensor', kind: 'resource', direction: 'source', device: sensor, capability: 'temperature' },
        { id: 'processor', kind: 'processor', manifest: release.manifest },
        { id: 'sink', kind: 'resource', direction: 'sink', device: sink, capability: 'switch' },
      ], edges: [{ from: { node: 'sensor', port: 'temperature' }, to: { node: 'processor', port: 'temperature' } },
        { from: { node: 'processor', port: 'switch' }, to: { node: 'sink', port: 'switch' } }] });
      controller = createProcessorFailureController({ plan, runtime, now: () => now,
        bindings: [{ node: 'processor', processor: live.processor, outputs: { switch: output }, inputRoutes: [inputRoute] }] });
    };
    const send = (temperature, flushOutput = true) => {
      now += 100; assert.equal(runtime.publish(input, temperature).ok, true); runtime.flush(); if (flushOutput) runtime.flush();
    };
    live = take(await store.activateReviewed(request(v1, source1, firstFactory, false))); bind(v1);
    const first = live; send(30); assert.deepEqual(effects, [true]); send(28, false);
    const queued = outputRoute; assert.equal(queued.status().pending, 1);
    take(await store.install(v2, source2)); assert.equal(first.isCurrent(), true); assert.equal(queued.status().pending, 1);
    live = take(await store.activateReviewed(request(v2, source2, secondFactory, true)));
    assert.equal(first.isCurrent(), false); assert.equal(queued.operations().at(-1).state, 'cancelled');
    runtime.flush(); assert.deepEqual(effects, [true]); bind(v2); send(30); assert.deepEqual(effects, [true]); send(31); assert.deepEqual(effects, [true, true]);
    const second = live; live = take(await store.rollbackReviewed(request(v1, source1, firstFactory, false)));
    assert.equal(second.isCurrent(), false); bind(v1); send(30); assert.deepEqual(effects, [true, true, true]);
    const denied = runtime.route({ from: input, to: processInput, ...identity, principalId: 'denied-owner' });
    assert.equal(denied.start().reason, 'denied');
    send(28, false); const revokedQueue = outputRoute; assert.equal(revokedQueue.status().pending, 1);
    take(await store.revokeRelease(v1.packageId, v1.version)); assert.equal(live.isCurrent(), false);
    assert.equal(revokedQueue.operations().at(-1).state, 'cancelled'); runtime.flush(); assert.deepEqual(effects, [true, true, true]);
    assert.equal((await store.rollbackReviewed(request(v1, source1, firstFactory, false))).ok, false);
    live = take(await store.activateReviewed(request(v2, source2, secondFactory, true))); bind(v2); send(31, false);
    const removedQueue = outputRoute; take(await store.remove(v2.packageId)); assert.equal(live.isCurrent(), false);
    assert.equal(removedQueue.operations().at(-1).state, 'cancelled'); runtime.flush(); assert.deepEqual(effects, [true, true, true]);
    assert.equal(take(await store.inspect()).packages[0].releases.length, 0);
    return { phase, profile: 'reviewed-processor-extension/1', verifiedBeforeFixedReviewedImports: true,
      observedEffects: effects, updateStrictBoundary: true, explicitRollback: true, oldQueuedEffectsCancelled: true,
      deniedRoute: true, revokeAndRemoveFenced: true, freshRouteApprovals: routeApprovals.length,
      excluded: ['untrusted-code-activation', 'sandbox', 'connectors-native-dependencies', 'publisher-account-lifecycle', 'physical-device-effects'] };
  } finally { store.close(); runtime?.close(); storage.close(); }
}
