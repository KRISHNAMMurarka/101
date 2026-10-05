import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createNodeMemoryProfile } from '../../../examples/device-profiles/node-memory-profile.ts';
import { createProfileConnector, createTrustedConnectorProfileRegistry } from './profile-connector.ts';
import type { ConnectorDecodedOutput, ConnectorProfileSample } from './profile-connector.ts';
import type { DeliveryContext, Observation } from './types.ts';

const artifact = new TextEncoder().encode('explicit-reviewed-fixture-json-decoder');
const digest = createHash('sha256').update(artifact).digest('hex');
const line = (outputs: unknown) => new TextEncoder().encode(`${JSON.stringify(outputs)}\n`);
function sample(resourceId = 'resident', value: unknown = 64, sequence = 1, at = 7.5) { return {
  kind: 'sample', resourceId, value, sequence, sourceTime: { clockId: 'node-rss:fixture', at }, quality: 'valid',
  calibration: resourceId === 'resident' ? { revision: 1, unit: 'By', absoluteErrorBound: 0 } : null,
}; }
async function fixture(options: { write?: (bytes: Uint8Array, context: unknown) => void | Promise<void>; decode?: (bytes: Uint8Array) => unknown; timeoutMs?: number; secondSink?: boolean; maxAgeMs?: number } = {}) {
  let now = 100, factories = 0, resets = 0, decodes = 0;
  const registry = createTrustedConnectorProfileRegistry(), profile = createNodeMemoryProfile(digest);
  const selected = structuredClone(profile);
  if (options.timeoutMs) { Reflect.set(selected.budgets, 'callbackTimeoutMs', options.timeoutMs); Reflect.set(selected.resources[2]!.command!, 'deadlineMs', options.timeoutMs); }
  if (options.maxAgeMs) for (const resource of selected.resources) Reflect.set(resource.capability.delivery, 'maxAgeMs', options.maxAgeMs);
  if (options.secondSink) Reflect.apply(Array.prototype.push, selected.resources, [{ ...selected.resources[2], capability: { ...selected.resources[2]!.capability, id: 'second' } }]);
  await registry.registerTrusted({ manifest: selected, source: artifact, factory() {
    factories++; return { decode(bytes: Uint8Array) { decodes++; return options.decode ? options.decode(bytes) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); },
      encodeCommand(command: unknown) { return line(command); }, reset() { resets++; } };
  } });
  const binding = registry.resolve({ id: profile.id, version: profile.version, codeSha256: digest });
  const samples: ConnectorProfileSample[] = [], invalidations: string[] = [], writes: Uint8Array[] = [];
  const connector = createProfileConnector({ binding, observedIdentity: { backendId: 'node-memory', wireVersion: 1, clockId: 'node-rss:fixture' },
    now: () => now, onSample(frame: ConnectorProfileSample) { samples.push(frame); }, onUnavailable(id: string) { invalidations.push(id); },
    write: options.write ?? ((bytes: Uint8Array) => { writes.push(bytes); }) });
  return { connector, registry, binding, profile, samples, invalidations, writes, now(value: number) { now = value; }, counters() { return { factories, resets, decodes }; } };
}
function command(current: () => boolean = () => true) {
  const controller = new AbortController(), evidence: string[] = [];
  const context: DeliveryContext = { signal: controller.signal, routeId: 'route-1', generation: 1, operationId: '1', isCurrent: current,
    reportEvidence(level) { evidence.push(level); } };
  const observation: Observation = { value: true, sequence: 1, timestamp: 100, receivedAt: 100, clockDomain: 'host-clock', quality: 'valid',
    source: { registrationId: 'control', deviceId: 'owner', capabilityId: 'enabled' } };
  return { controller, context, observation, evidence };
}

test('registry admits only a verified exact pin and never activates from metadata', async () => {
  const f = await fixture(); assert.equal(f.counters().factories, 0);
  assert.throws(() => f.registry.resolve({ id: f.profile.id, version: '2.0.0', codeSha256: digest }));
  await assert.rejects(() => f.registry.registerTrusted({ manifest: f.profile, source: new Uint8Array([1]), factory() { throw Error('must not run'); } }));
  assert.throws(() => createProfileConnector({ binding: {} as never, observedIdentity: {}, onSample() {}, onUnavailable() {} }));
  f.connector.close();
});

test('default capture is inactive; foreign/forged handles and mismatched observed facts grant nothing', async () => {
  const f = await fixture(); assert.equal(f.connector.push({} as never, line([sample()])).ok, false); assert.equal(f.counters().decodes, 0);
  assert.throws(() => createProfileConnector({ binding: f.binding, observedIdentity: { backendId: 'other', wireVersion: 1, clockId: 'node-rss:fixture' }, onSample() {}, onUnavailable() {} }));
  let reads = 0;
  assert.throws(() => createProfileConnector({ binding: f.binding, observedIdentity: { get backendId() { reads++; return 'node-memory'; }, wireVersion: 1 }, onSample() {}, onUnavailable() {} }));
  assert.equal(reads, 0);
  const started = f.connector.start(); assert.ok(started.ok); const other = await fixture(); const foreign = other.connector.start(); assert.ok(foreign.ok);
  assert.equal(f.connector.push(foreign.value, line([sample()])).ok, false); assert.equal(f.samples.length, 0);
  f.connector.close(); other.connector.close();
});

test('fragmented and coalesced JSONL preserve original time, clock, quality, calibration and truthful receipt', async () => {
  const f = await fixture(); const started = f.connector.start(); assert.ok(started.ok);
  const bytes = line([sample()]); assert.ok(f.connector.push(started.value, bytes.slice(0, 9)).ok); assert.equal(f.samples.length, 0);
  assert.ok(f.connector.push(started.value, bytes.slice(9)).ok);
  assert.deepEqual(f.samples[0]!.sourceTime, { clockId: 'node-rss:fixture', at: 7.5 }); assert.equal(f.samples[0]!.receivedAt, 100);
  assert.deepEqual(f.samples[0]!.calibration, { revision: 1, unit: 'By', absoluteErrorBound: 0 }); assert.equal(f.samples[0]!.quality, 'valid');
  assert.ok(f.connector.push(started.value, new Uint8Array([...line([sample('resident', 65, 2, 8)]), ...line([sample('enabled', false, 1, 8)])])).ok);
  assert.equal(f.samples.length, 3); f.connector.close();
});

test('closed decode batches fail before any output for extra fields, foreign clock, stale calibration and nonfinite values', async () => {
  for (const output of [{ ...sample(), token: 'credential-sentinel' }, { ...sample(), sourceTime: { clockId: 'foreign', at: 7 } },
    { ...sample(), calibration: { revision: 2, unit: 'By', absoluteErrorBound: 0 } }, sample('resident', 'not-numeric'), { ...sample(), value: null },
    { ...sample(), sourceTime: { clockId: 'node-rss:fixture', at: Infinity } }]) {
    const f = await fixture({ decode: () => [sample(), output] }); const started = f.connector.start(); assert.ok(started.ok);
    assert.equal(f.connector.push(started.value, line([])).ok, false); assert.equal(f.samples.length, 0); assert.equal(f.connector.status().active, false);
    assert.equal(JSON.stringify(f.connector.status()).includes('credential-sentinel'), false); f.connector.close();
  }
});

test('framing byte/work/output limits fail closed and do not invoke a decoder beyond budget', async () => {
  for (const bytes of [new Uint8Array(8193), new Uint8Array(4097).fill(65), new TextEncoder().encode('[]\n'.repeat(17))]) {
    const f = await fixture(); const started = f.connector.start(); assert.ok(started.ok);
    assert.equal(f.connector.push(started.value, bytes).ok, false); assert.equal(f.counters().decodes, 0); assert.equal(f.connector.status().bufferedBytes, 0); f.connector.close();
  }
  const f = await fixture({ decode: () => Array.from({ length: 9 }, () => sample()) }); const started = f.connector.start(); assert.ok(started.ok);
  assert.equal(f.connector.push(started.value, line([])).ok, false); assert.equal(f.samples.length, 0); f.connector.close();
});

test('restart and reentrant stop reject old capture/output and release pending authority', async () => {
  const f = await fixture(); const first = f.connector.start(); assert.ok(first.ok); f.connector.stop('unplug');
  const second = f.connector.start(); assert.ok(second.ok); assert.equal(f.connector.push(first.value, line([sample()])).ok, false);
  assert.ok(f.connector.push(second.value, line([sample()])).ok); f.connector.close(); assert.equal(f.connector.start().ok, false);
  const reentrant = await fixture({ decode: () => { reentrant.connector.stop('cancel'); return [sample()]; } }); const started = reentrant.connector.start(); assert.ok(started.ok);
  assert.equal(reentrant.connector.push(started.value, line([])).ok, false); assert.equal(reentrant.samples.length, 0); reentrant.connector.close();
});

test('command dispatch needs external current route scope; ACK cannot claim observed without a matching declared reading', async () => {
  const f = await fixture(); const started = f.connector.start(); assert.ok(started.ok);
  const denied = command(() => false); await f.connector.apply('sampling', denied.observation, denied.context); assert.equal(f.writes.length, 0);
  const operation = command(); await f.connector.apply('sampling', operation.observation, operation.context); assert.deepEqual(operation.evidence, ['dispatched']);
  const sent = JSON.parse(new TextDecoder().decode(f.writes[0]!)); const commandId = sent.commandId;
  const ack: ConnectorDecodedOutput = { kind: 'ack', resourceId: 'sampling', commandId, sequence: 1, sourceTime: { clockId: 'node-rss:fixture', at: 10 } };
  assert.ok(f.connector.push(started.value, line([ack])).ok); assert.deepEqual(operation.evidence, ['dispatched', 'target-acknowledged']);
  assert.ok(f.connector.push(started.value, line([sample('enabled', false, 1, 10)])).ok); assert.equal(operation.evidence.includes('observed'), false);
  assert.ok(f.connector.push(started.value, line([sample('enabled', true, 2, 10)])).ok); assert.equal(operation.evidence.includes('observed'), false);
  assert.ok(f.connector.push(started.value, line([sample('enabled', true, 3, 11)])).ok); assert.equal(operation.evidence.at(-1), 'observed');
  f.connector.release('sampling', 'revoked', { routeId: 'route-1' }); const before = operation.evidence.length;
  assert.equal(f.connector.push(started.value, line([ack])).ok, false); assert.equal(operation.evidence.length, before); f.connector.close();
});

test('hanging writes and callback deadlines remain bounded; revoke aborts and late ACK cannot restore effects', async () => {
  const signals: AbortSignal[] = [];
  const f = await fixture({ write(_bytes, context) { signals.push((context as { signal: AbortSignal }).signal); return new Promise(() => {}); } });
  const started = f.connector.start(); assert.ok(started.ok); const promises: Promise<unknown>[] = [], contexts: ReturnType<typeof command>[] = [];
  for (let index = 0; index < 5; index++) { const request = command(); Reflect.set(request.context, 'operationId', String(index + 1)); contexts.push(request); promises.push(f.connector.apply('sampling', request.observation, request.context).catch(() => undefined)); }
  await new Promise(resolve => setImmediate(resolve)); assert.ok(f.connector.status().pendingCommands <= 4); assert.ok(f.connector.status().inFlightWrites <= 4);
  for (const request of contexts) request.controller.abort(); await Promise.all(promises);
  assert.equal(f.connector.status().pendingCommands, 0); assert.ok(signals.every(signal => signal.aborted)); f.connector.close();
});

test('trusted clock rollback and source replay/silence invalidate readiness without comparing unlike clocks', async () => {
  const f = await fixture(); const started = f.connector.start(); assert.ok(started.ok); assert.ok(f.connector.push(started.value, line([sample()])).ok);
  assert.equal(f.connector.push(started.value, line([sample()])).ok, false); assert.ok(f.invalidations.includes('resident'));
  const clock = await fixture(); const capture = clock.connector.start(); assert.ok(capture.ok); clock.now(99);
  assert.equal(clock.connector.push(capture.value, line([sample()])).ok, false); assert.equal(clock.connector.status().active, false);
  const silent = await fixture(); const live = silent.connector.start(); assert.ok(live.ok); silent.connector.push(live.value, line([sample()])); silent.now(1101); silent.connector.sweep();
  assert.ok(silent.invalidations.includes('resident')); f.connector.close(); clock.connector.close(); silent.connector.close();
});

test('cancellation from the admission clock prevents encoding/writing and permits a clean subsequent session', async () => {
  const f = await fixture(); let cancel = false, writes = 0; const unavailable: string[] = [];
  const connector = createProfileConnector({ binding: f.binding, observedIdentity: { backendId: 'node-memory', wireVersion: 1, clockId: 'node-rss:fixture' },
    now() { if (cancel) { cancel = false; connector.stop(); } return 100; }, onSample() {}, onUnavailable(id) { unavailable.push(id); }, write() { writes++; } });
  const capture = connector.start(); assert.ok(capture.ok); connector.push(capture.value, line([sample()]));
  cancel = true; const request = command(); await connector.apply('sampling', request.observation, request.context);
  assert.equal(writes, 0); assert.equal(connector.status().pendingCommands, 0);
  assert.ok(unavailable.includes('resident'));
  assert.ok(connector.start().ok); connector.close(); f.connector.close();
});

test('a completed observed command retains bounded cleanup ownership until its external route is released', async () => {
  const f = await fixture(); const started = f.connector.start(); assert.ok(started.ok); const operation = command();
  await f.connector.apply('sampling', operation.observation, operation.context);
  const sent = JSON.parse(new TextDecoder().decode(f.writes[0]!));
  assert.ok(f.connector.push(started.value, line([{ kind: 'ack', resourceId: 'sampling', commandId: sent.commandId, sequence: 1,
    sourceTime: { clockId: 'node-rss:fixture', at: 10 } }, sample('enabled', true, 1, 11)])).ok);
  assert.equal(f.connector.status().pendingCommands, 0);
  f.connector.release('sampling', 'revoked', { routeId: 'foreign-route' }); assert.equal(f.writes.length, 1);
  f.connector.release('sampling', 'revoked', { routeId: 'route-1' }); assert.equal(f.writes.length, 2);
  const safe = JSON.parse(new TextDecoder().decode(f.writes[1]!)); assert.equal(safe.value, false);
  f.connector.release('sampling', 'revoked', { routeId: 'route-1' }); assert.equal(f.writes.length, 2); f.connector.close();
});

test('the fixed reviewed Node decoder accepts actual producer frames and rejects extra command operations', async () => {
  const { createNodeMemoryDecoder } = await import('../../../examples/device-profiles/node-memory-producer.mjs');
  const decoder = createNodeMemoryDecoder(), context = { clockId: 'node-rss:fixture', generation: 1 };
  const rssBytes = process.memoryUsage().rss;
  const decoded = decoder.decode(line({ wireVersion: 1, kind: 'reading', clockId: context.clockId, at: 7.25, sequence: 1,
    rssBytes, enabled: false, quality: 'valid', calibrationRevision: 1, absoluteErrorBound: 0 }), context);
  assert.ok(decoded[0] && 'value' in decoded[0]); assert.ok(decoded[1] && 'value' in decoded[1]);
  assert.equal(decoded[0].value, rssBytes); assert.equal(decoded[0].sourceTime.at, 7.25);
  assert.equal(decoded[1].value, false);
  assert.throws(() => decoder.decode(line({ wireVersion: 1, kind: 'reading', clockId: context.clockId, at: 8, sequence: 2,
    rssBytes: 64, enabled: false, quality: 'valid', calibrationRevision: 1, absoluteErrorBound: 0, token: 'sentinel' }), context));
  assert.throws(() => decoder.encodeCommand({ resourceId: 'arbitrary-shell', commandId: '1', value: true }));
});

test('callback deadlines retire authority while ignored-abort writes remain reserved across restarts', async () => {
  const signals: AbortSignal[] = [];
  const f = await fixture({ timeoutMs: 20, write(_bytes, context) { signals.push((context as { signal: AbortSignal }).signal); return new Promise(() => {}); } });
  assert.ok(f.connector.start().ok);
  for (let index = 0; index < 4; index++) {
    const operation = command(); await f.connector.apply('sampling', operation.observation, operation.context);
    assert.equal(f.connector.status().pendingCommands, 0); assert.ok(signals[index]!.aborted);
  }
  assert.equal(f.connector.status().inFlightWrites, 4); f.connector.stop(); assert.equal(f.connector.start().ok, false);
  const denied = command(); await f.connector.apply('sampling', denied.observation, denied.context); assert.equal(signals.length, 4); f.connector.close();
});

test('declared cleanup for multiple sinks waits in a bounded queue instead of silently dropping the second safe state', async () => {
  const writes: { resourceId: string; value: boolean }[] = []; let completeFirst: (() => void) | undefined;
  const f = await fixture({ secondSink: true, write(bytes, context) {
    const input = JSON.parse(new TextDecoder().decode(bytes)); writes.push(input);
    if ((context as { cleanup: boolean }).cleanup && input.resourceId === 'sampling') return new Promise<void>(resolve => { completeFirst = resolve; });
  } });
  assert.ok(f.connector.start().ok); const first = command(), second = command();
  await f.connector.apply('sampling', first.observation, first.context); await f.connector.apply('second', second.observation, second.context);
  f.connector.release('sampling', 'revoked', { routeId: 'route-1' }); f.connector.release('second', 'revoked', { routeId: 'route-1' });
  assert.ok(completeFirst); completeFirst(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes.filter(write => !write.value).map(write => write.resourceId), ['sampling', 'second']); f.connector.close();
});

test('source silence expires through an owned watchdog and a late reading first withdraws stale readiness', async () => {
  const f = await fixture({ maxAgeMs: 40, timeoutMs: 20 }); const started = f.connector.start(); assert.ok(started.ok);
  assert.ok(f.connector.push(started.value, line([sample()])).ok); f.now(141);
  await new Promise(resolve => setTimeout(resolve, 65)); assert.ok(f.invalidations.includes('resident')); f.connector.close();
  const resumed = await fixture({ maxAgeMs: 40, timeoutMs: 20 }); const capture = resumed.connector.start(); assert.ok(capture.ok);
  assert.ok(resumed.connector.push(capture.value, line([sample()])).ok); resumed.now(141);
  assert.ok(resumed.connector.push(capture.value, line([sample('resident', 65, 2, 8)])).ok);
  assert.ok(resumed.invalidations.includes('resident')); resumed.connector.close();
});
