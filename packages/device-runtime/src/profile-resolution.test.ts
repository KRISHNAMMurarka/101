import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNodeMemoryProfile, NODE_MEMORY_REVIEWED_SHA256 } from '../../../examples/device-profiles/node-memory-profile.ts';
import { createTrustedConnectorProfileRegistry } from './profile-connector.ts';
import type { ConnectorDecoder, ConnectorProfileSample } from './profile-connector.ts';
import { createProfileResolutionController } from './profile-resolution.ts';
import type { ProfileChoiceHandle, ProfileObservationHandle, ProfileReviewHandle } from './profile-resolution.ts';
import type { DeliveryContext, Observation } from './types.ts';

const source = readFileSync(new URL('../../../examples/device-profiles/node-memory-producer.mjs', import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'), NODE_MEMORY_REVIEWED_SHA256);
const reviewed = await import(`data:text/javascript;base64,${source.toString('base64')}`) as { createNodeMemoryDecoder(): ConnectorDecoder };
const scope = { kind: 'local', id: 'owned-node-profile-review' } as const;
const facts = { backendId: 'node-memory', wireVersion: 1, clockId: 'node-rss:fixture' };
const manifest = createNodeMemoryProfile();
const pin = { id: manifest.id, version: manifest.version, codeSha256: NODE_MEMORY_REVIEWED_SHA256 };
function candidate(at = 100, expiresAt = 1000, id = 'owned-process') { return {
  schemaVersion: 1, id, scope, expiresAt, recovery: { action: 'review-identity', hint: 'Select a reviewed profile for the owned process.' },
  evidence: [{ stage: 'observed', kind: 'observation', candidateId: id, scope, receiptId: 'owned:process-observation', at, expiresAt }],
}; }
function frame(sequence = 1, clockId = facts.clockId) {
  return new TextEncoder().encode(`${JSON.stringify({ wireVersion: 1, kind: 'reading', clockId, at: 7.25, sequence,
    rssBytes: process.memoryUsage().rss, enabled: false, quality: 'valid', calibrationRevision: 1, absoluteErrorBound: 0 })}\n`);
}
async function fixture(options: { now?: () => number; factory?: () => void; verify?: () => boolean } = {}) {
  let at = 100, factories = 0, resets = 0;
  const registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source, factory() {
    factories++; options.factory?.(); const decoder = reviewed.createNodeMemoryDecoder();
    return { ...decoder, reset() { resets++; decoder.reset(); } };
  } });
  const controller = createProfileResolutionController({ registry, profiles: [pin], scope, now: options.now ?? (() => at),
    verifyObservation(c, evidence, observed) { return c.id === 'owned-process' && evidence.receiptId === 'owned:process-observation' &&
      observed.clockId === facts.clockId && (options.verify?.() ?? true); } });
  function observe(input = candidate(), identity: unknown = facts): ProfileObservationHandle {
    const result = controller.observe({ candidate: input, observedIdentity: identity }); assert.ok(result.ok); return result.value;
  }
  function request(observation: ProfileObservationHandle): ProfileReviewHandle {
    const result = controller.request(observation, pin); assert.ok(result.ok); return result.value;
  }
  function choose(observation = observe()): ProfileChoiceHandle {
    const result = controller.decide(request(observation), true); assert.ok(result.ok); assert.ok(result.value); return result.value;
  }
  const samples: ConnectorProfileSample[] = [], unavailable: string[] = [];
  function connector(choice: ProfileChoiceHandle, onSample: (sample: ConnectorProfileSample) => void = sample => samples.push(sample)) {
    const result = controller.createConnector(choice, { onSample, onUnavailable(id) { unavailable.push(id); } }); assert.ok(result.ok); return result.value;
  }
  return { controller, observe, request, choose, connector, samples, unavailable, at(value: number) { at = value; }, counters() { return { factories, resets }; } };
}

test('unknown device semantics require an exact inert review and explicit choice before the actual pinned decoder starts', async () => {
  const f = await fixture();
  try {
    const observation = f.observe(); assert.equal(f.controller.snapshot().state, 'unknown');
    const review = f.request(observation); assert.equal(f.controller.snapshot().state, 'reviewing');
    assert.equal(f.controller.snapshot().pending?.resources[0]!.capability.semantic, 'example:resident-memory');
    assert.equal(f.counters().factories, 0);
    const approved = f.controller.decide(review, true); assert.ok(approved.ok && approved.value);
    assert.equal(f.controller.snapshot().state, 'selected'); assert.equal(f.counters().factories, 0);
    const connector = f.connector(approved.value); assert.equal(f.counters().factories, 0);
    const capture = connector.start(); assert.ok(capture.ok); assert.equal(f.counters().factories, 1);
    assert.ok(connector.push(capture.value, frame()).ok);
    assert.equal(f.samples.length, 2); assert.equal(f.samples[0]!.sourceTime.at, 7.25);
    assert.equal(f.samples[0]!.sourceTime.clockId, 'node-rss:fixture'); assert.equal(f.samples[0]!.receivedAt, 100);
    assert.deepEqual(f.samples[0]!.calibration, { revision: 1, unit: 'By', absoluteErrorBound: 0 });
    assert.equal(f.samples[0]!.quality, 'valid');
  } finally { f.controller.close(); }
});

test('unsupported pins and cancelled or declined inert review retain the current valid chosen connector', async () => {
  const f = await fixture();
  try {
    const observation = f.observe(), choice = f.choose(observation), connector = f.connector(choice);
    const capture = connector.start(); assert.ok(capture.ok);
    assert.equal(f.controller.request(observation, { ...pin, version: '9.0.0' }).ok, false);
    assert.equal(f.controller.snapshot().outcome, 'unsupported'); assert.equal(f.controller.isCurrent(choice), true);
    assert.equal(connector.status().active, true);
    assert.ok(f.controller.cancel(f.request(observation)).ok); assert.equal(f.controller.isCurrent(choice), true);
    assert.ok(f.controller.decide(f.request(observation), false).ok); assert.equal(f.controller.isCurrent(choice), true);
    assert.ok(connector.push(capture.value, frame()).ok);
    const other = await fixture(); try {
      assert.equal(f.controller.decide(other.request(other.observe()), true).ok, false);
      assert.equal(f.controller.createConnector({ ...choice }, { onSample() {}, onUnavailable() {} }).ok, false);
      assert.equal(f.controller.remove(other.observe()).ok, false);
    } finally { other.controller.close(); }
    assert.equal(f.controller.isCurrent(choice), true);
  } finally { f.controller.close(); }
});

test('identity filter mismatch stays visibly unsupported without using vendor or label facts as capabilities', async () => {
  const f = await fixture();
  try {
    const observation = f.observe(candidate(), { ...facts, backendId: 'unknown', vendor: 'node-memory', label: 'Owned process' });
    assert.equal(f.controller.request(observation, pin).ok, false);
    assert.equal(f.controller.snapshot().state, 'unsupported'); assert.equal(f.controller.snapshot().current, undefined);
    assert.equal(f.counters().factories, 0);
  } finally { f.controller.close(); }
});

test('replacement observation, exact removal and explicit choice replacement close prior capture authority', async () => {
  const f = await fixture();
  try {
    const oldObservation = f.observe(), oldChoice = f.choose(oldObservation), old = f.connector(oldChoice);
    const oldCapture = old.start(); assert.ok(oldCapture.ok);
    const replacement = f.observe(); assert.equal(f.controller.snapshot().state, 'unknown');
    assert.equal(old.status().closed, true); assert.equal(old.push(oldCapture.value, frame()).ok, false);
    assert.equal(f.controller.isCurrent(oldChoice), false); assert.equal(f.controller.remove(oldObservation).ok, false);
    const choice = f.choose(replacement), current = f.connector(choice); assert.ok(current.start().ok);
    const next = f.controller.decide(f.request(replacement), true); assert.ok(next.ok && next.value);
    assert.equal(current.status().closed, true); assert.equal(f.controller.isCurrent(choice), false);
    assert.ok(f.controller.remove(replacement).ok); assert.equal(f.controller.isCurrent(next.value), false);
    assert.equal(f.controller.snapshot().state, 'unknown');
  } finally { f.controller.close(); }
});

test('bounded inert input rejects accessors, extra fields, scope/future/expired receipts and unverified observed facts', async () => {
  const f = await fixture(); let getters = 0;
  try {
    for (const input of [
      { candidate: candidate(), observedIdentity: { ...facts, get vendor() { getters++; return 'node-memory'; } } },
      { candidate: candidate(), observedIdentity: { ...facts, extra: 'x'.repeat(129) } },
      { candidate: candidate(), observedIdentity: { ...facts, nested: { id: 'credential-sentinel' } } },
      { candidate: { ...candidate(), scope: { kind: 'local', id: 'other' } }, observedIdentity: facts },
      { candidate: candidate(101, 1000), observedIdentity: facts },
      { candidate: candidate(0, 100), observedIdentity: facts },
      { candidate: candidate(), observedIdentity: facts, importPath: '/tmp/unreviewed.mjs' },
    ]) assert.equal(f.controller.observe(input as never).ok, false);
    assert.equal(getters, 0); assert.equal(f.counters().factories, 0);
    const denied = await fixture({ verify: () => false }); try { assert.equal(denied.controller.observe({ candidate: candidate(), observedIdentity: facts }).ok, false); }
    finally { denied.controller.close(); }
    const observation = f.observe(); const getter = { ...pin, get codeSha256() { getters++; return pin.codeSha256; } };
    assert.equal(f.controller.request(observation, getter).ok, false); assert.equal(getters, 0);
  } finally { f.controller.close(); }
});

test('one owned timer expires quiet observations and closes a started native connector without a caller tick', async () => {
  const now = () => Math.floor(performance.now()), f = await fixture({ now });
  try {
    const at = now(), observation = f.observe(candidate(at, at + 35)), choice = f.choose(observation), connector = f.connector(choice);
    assert.ok(connector.start().ok);
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.equal(f.controller.snapshot().state, 'expired'); assert.equal(connector.status().closed, true);
    assert.equal(f.controller.isCurrent(choice), false); assert.equal(f.controller.snapshot().timerArmed, false);
  } finally { f.controller.close(); }
});

test('fresh observation replaces an expired epoch in one call', async () => {
  const f = await fixture();
  try {
    f.choose(); f.at(1000);
    const fresh = f.controller.observe({ candidate: candidate(1000, 2000), observedIdentity: facts });
    assert.ok(fresh.ok); assert.equal(f.controller.snapshot().state, 'unknown');
  } finally { f.controller.close(); }
});

test('a factory crossing the observation expiry cannot return a live capture', async () => {
  const expiring: Awaited<ReturnType<typeof fixture>> = await fixture({ factory() { expiring.at(1000); } });
  try {
    const connector = expiring.connector(expiring.choose());
    assert.equal(connector.start().ok, false); assert.equal(connector.status().closed, true);
    assert.equal(expiring.controller.snapshot().state, 'expired'); assert.equal(expiring.controller.snapshot().timerArmed, false);
  } finally { expiring.controller.close(); }
});

test('clock rollback and reentrant observation verification close without retaining an expiry timer', async () => {
  const f = await fixture(); try {
    const choice = f.choose(), connector = f.connector(choice); assert.ok(connector.start().ok);
    f.at(99); f.controller.sweep(); assert.equal(f.controller.snapshot().state, 'closed'); assert.equal(connector.status().closed, true);
    assert.equal(f.controller.snapshot().timerArmed, false);
  } finally { f.controller.close(); }
  const reentrant: Awaited<ReturnType<typeof fixture>> = await fixture({ verify() { reentrant.controller.close(); return true; } });
  assert.equal(reentrant.controller.observe({ candidate: candidate(), observedIdentity: facts }).ok, false);
  assert.equal(reentrant.controller.snapshot().state, 'closed'); assert.equal(reentrant.controller.snapshot().timerArmed, false);
});

test('late factory and sample callback reentrancy cannot revive a replaced or closed resolution', async () => {
  const closing: Awaited<ReturnType<typeof fixture>> = await fixture({ factory() { closing.controller.close(); } });
  const choice = closing.choose(), connector = closing.connector(choice);
  assert.equal(connector.start().ok, false); assert.equal(connector.status().closed, true);
  assert.equal(closing.controller.snapshot().timerArmed, false);
  const sampling = await fixture(); try {
    const selected = sampling.choose(), owned = sampling.connector(selected, () => sampling.controller.clear());
    const capture = owned.start(); assert.ok(capture.ok);
    assert.equal(owned.push(capture.value, frame()).ok, false);
    assert.equal(owned.status().closed, true); assert.equal(sampling.controller.snapshot().current, undefined);
  } finally { sampling.controller.close(); }
});

test('resource delivery currentness remains separate and reentrant cancellation precedes any real writer', async () => {
  const f = await fixture(); let writes = 0;
  try {
    const choice = f.choose(); const created = f.controller.createConnector(choice, { onSample() {}, onUnavailable() {}, write() { writes++; } });
    assert.ok(created.ok); assert.ok(created.value.start().ok);
    const abort = new AbortController();
    const context: DeliveryContext = { signal: abort.signal, routeId: 'separately-authorized-route', generation: 1,
      isCurrent() { f.controller.clear(); return true; }, reportEvidence() {} };
    const observation: Observation = { value: true, sequence: 1, timestamp: 100, receivedAt: 100, clockDomain: 'host-clock', quality: 'valid',
      source: { registrationId: 'control', deviceId: 'owner', capabilityId: 'enabled' } };
    await created.value.apply('sampling', observation, context);
    assert.equal(writes, 0); assert.equal(created.value.status().closed, true);
  } finally { f.controller.close(); }
});

test('connector creation reservations remain finite across repeated explicit replacement and failed current factories', async () => {
  const f = await fixture();
  try {
    const observation = f.observe();
    for (let index = 0; index < 64; index++) {
      const choice = f.choose(observation), connector = f.connector(choice); assert.ok(connector.start().ok);
      assert.equal(f.controller.createConnector(choice, { onSample() {}, onUnavailable() {} }).ok, false);
    }
    const choice = f.choose(observation);
    const denied = f.controller.createConnector(choice, { onSample() {}, onUnavailable() {} });
    assert.equal(denied.ok, false); assert.equal(f.counters().factories, 64);
    assert.equal(f.controller.snapshot().remainingConnectorCreations, 0);
  } finally { f.controller.close(); }
});
