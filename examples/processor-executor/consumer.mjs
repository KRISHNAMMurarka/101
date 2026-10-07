import assert from 'node:assert/strict';
import { createAssetReference, processorExtensionManifestSha256, processorExtensionSigningBytes, validateProcessorGraph } from '@101/device-model';
import { createDeviceRuntime, createProcessorInstallation } from '@101/device-runtime';
import { createNodeProcessorExecutor } from '@101/device-runtime/node';

/** Host-supplied reviewed bytes/factory are fixed by the caller, never selected by a release. */
export async function runProcessorExecutorExample({ source, manifest, factory }) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const reference = await createAssetReference('example:processor-source', 'blob', source);
  assert.equal(reference.sha256, manifest.codeSha256);
  const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
    packageId: manifest.id, version: manifest.version, sequence: 1, abi: '101:processor/1', runtimeVersion: '0.1.0', manifest,
    manifestSha256: await processorExtensionManifestSha256(manifest), source: reference, privileges: ['compute-local'], dependencies: [] };
  const release = { ...unsigned, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey, processorExtensionSigningBytes(unsigned))).toString('hex') };
  const configuration = { onAt: 30, offAt: 28 };
  const fixture = { configuration, invalidConfiguration: { onAt: 'bad', offAt: 28 }, invalidInputs: { temperature: 'bad' },
    cases: [{ inputs: { temperature: 30 }, outputs: { switch: true } }, { inputs: { temperature: 29 } },
      { inputs: { temperature: 28 }, outputs: { switch: false } }] };
  const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 }, boolean = { type: 'boolean' };
  const device = (id, capabilities) => ({ schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:processor-executor', version: '1.0.0' }, runtime: { platform: 'node' }, capabilities });
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
  const plan = validateProcessorGraph({ schemaVersion: 1, nodes: [
    { id: 'sensor', kind: 'resource', direction: 'source', device: sensor, capability: 'temperature' },
    { id: 'processor', kind: 'processor', manifest },
    { id: 'sink', kind: 'resource', direction: 'sink', device: sink, capability: 'switch' },
  ], edges: [{ from: { node: 'sensor', port: 'temperature' }, to: { node: 'processor', port: 'temperature' } },
    { from: { node: 'processor', port: 'switch' }, to: { node: 'sink', port: 'switch' } }] });
  assert.deepEqual(plan.requiredOperations.map(value => value.operation), ['subscribe', 'invoke']);
  const phases = [];
  for (const phase of ['stop-pending', 'revoke-queued']) {
    const documents = new Map(), effects = [], approvals = [];
    let now = Date.now(), current = true, fenced = false, inputRoute, outputRoute, executor, live, runtime, output, operation = 0, apply;
    const retire = () => {
      if (fenced) return;
      fenced = true; current = false;
      inputRoute?.stop('processor-retired'); outputRoute?.stop('processor-retired');
      if (output) runtime.setReadiness(output, 'unavailable');
      live?.close(); void executor?.close();
    };
    const storage = {
      async read(key) { return documents.get(key); },
      async compareAndSwap(key, expected, value, guard) {
        if (documents.get(key) !== expected || guard.signal.aborted || !guard.isCurrent()) return false;
        documents.set(key, value); return true;
      },
      isCurrent(key, expected) { return documents.get(key) === expected; },
    };
    const installation = createProcessorInstallation({ ownerId: 'owner', storage,
      publisherTrust: id => id === release.publisherId ? { key: keys.publicKey, minimumSequence: 1 } : undefined,
      authorize: scope => ({ expiresAt: Date.now() + 60_000,
        isCurrent: () => scope.action === 'activate-reviewed' ? current : true }),
    });
    const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
    try {
      take(await installation.install(release, source));
      live = take(await installation.activateReviewed({ packageId: release.packageId, version: release.version,
        codeSha256: manifest.codeSha256, trusted: { manifest, source, factory }, fixture, configuration, retireOwned: retire }));
      executor = await createNodeProcessorExecutor({ release, source, publisherKey: keys.publicKey, minimumSequence: 1,
        entrypoint: 'createTemperatureBand', configuration, approval: { expiresAt: Date.now() + 60_000, isCurrent: () => live.isCurrent() } });
      runtime = createDeviceRuntime({ now: () => now, authorize(permission) {
        approvals.push(permission);
        const identity = permission.principalId === 'owner' && permission.applicationId === 'executor-example' && permission.sessionId === phase;
        const input = permission.source.deviceId === sensor.id && permission.source.capabilityId === 'temperature' && permission.sourceOperation === 'subscribe' &&
          permission.sink.deviceId === derived.id && permission.sink.capabilityId === 'input' && permission.sinkOperation === 'write';
        const output = permission.source.deviceId === derived.id && permission.source.capabilityId === 'output' && permission.sourceOperation === 'subscribe' &&
          permission.sink.deviceId === sink.id && permission.sink.capabilityId === 'switch' && permission.sinkOperation === 'invoke';
        return current && identity && (input || output) ? { expiresAt: now + 60_000, maxAgeMs: 1000, maxHz: 10 } : undefined;
      } });
      const input = runtime.registerSource({ device: sensor, capability: 'temperature' });
      output = runtime.registerSource({ device: derived, capability: 'output' });
      const processInput = runtime.registerSink({ device: derived, capability: 'input',
        apply(observation, context) {
          apply = (async () => {
            if (fenced || !context.isCurrent() || !live.isCurrent()) return;
            const result = await executor.process({ temperature: observation.value });
            if (fenced || context.signal.aborted || !context.isCurrent() || !live.isCurrent()) return;
            if (!result.ok) { retire(); return; }
            if (result.frame) assert.equal(runtime.publish(output, result.frame.switch,
              { operationId: String(++operation), deadline: now + 500 }).ok, true);
          })();
          return apply;
        }, release() {},
      });
      const target = runtime.registerSink({ device: sink, capability: 'switch',
        apply(observation, context) { if (!fenced && context.isCurrent() && live.isCurrent()) effects.push(observation.value); }, release() {} });
      for (const handle of [input, output, processInput, target]) take(runtime.setReadiness(handle, 'available'));
      const identity = { principalId: 'owner', applicationId: 'executor-example', sessionId: phase };
      inputRoute = runtime.route({ from: input, to: processInput, ...identity });
      outputRoute = runtime.route({ from: output, to: target, ...identity });
      assert.equal(inputRoute.start().ok, true); assert.equal(outputRoute.start().ok, true);
      inputRoute.onClose(retire);
      assert.equal(runtime.route({ from: input, to: processInput, ...identity, principalId: 'denied' }).start().reason, 'denied');
      const dispatch = temperature => { now += 100; assert.equal(runtime.publish(input, temperature).ok, true); runtime.flush(); assert.ok(apply); return apply; };
      await dispatch(31); runtime.flush(); assert.deepEqual(effects, [true]);
      const pending = dispatch(27);
      if (phase === 'stop-pending') {
        inputRoute.stop('stop');
        assert.equal(executor.status().active, false);
        assert.equal(executor.status().rawExecutors, 1, 'Stop cannot release the still-owned worker');
        await pending;
      } else {
        await pending; assert.equal(outputRoute.status().pending, 1);
        take(await installation.revokeRelease(release.packageId, release.version));
        assert.equal(outputRoute.operations().at(-1).state, 'cancelled');
      }
      runtime.flush(); assert.deepEqual(effects, [true]);
      await executor.close(); assert.equal(executor.status().rawExecutors, 0);
      assert.equal(live.isCurrent(), false);
      phases.push({ phase, effects, freshApprovedRoutes: approvals.filter(value => value.principalId === 'owner').length,
        staleEffectFenced: true, actualWorkerExited: true });
    } finally { retire(); await executor?.close(); installation.close(); runtime?.close(); }
  }
  return { status: 'pass', profile: release.profile, sourceSha256: reference.sha256, declaredGuestMemoryBytes: manifest.budgets.maxMemoryBytes,
    phases, excludedMemory: ['source-parser-AST', 'host-dictionaries', 'Worker-V8-heap', 'RSS'],
    scope: 'selected signed pure threshold guest language; no generic JavaScript sandbox or physical effect' };
}
