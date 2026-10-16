import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerSourceDescriptor } from '../../device-web/src/pointer-provider.ts';
import { createDeviceRuntime } from './index.ts';
import { createInputOwnershipController } from './input-ownership.ts';
import type { InputOwnershipController } from './input-ownership.ts';
import type { AuthorizationRequest, DeliveryContext } from './types.ts';
import { createInputOwnershipExample } from '../../../examples/device-pipelines/input-ownership.ts';

function harness(partitions = false) {
  let time = 0, allowed = true, grants = 0; let clockHook: (() => void) | undefined; const grantRequests: AuthorizationRequest[] = [];
  const values = new Map<string, { route: string; value: unknown }>(), releases: string[] = [];
  let holdPosition = false;
  const delayed: Array<{ context: DeliveryContext; finish: () => void }> = [];
  const runtime = createDeviceRuntime({ now: () => time, authorize(request) {
    if (!allowed || !controller?.isApproved(request)) return;
    grantRequests.push(request); grants++; return { expiresAt: time + 60000, maxAgeMs: 1000, maxHz: 60 };
  } });
  const descriptors = ['first', 'second'].map(id => ({ ...pointerSourceDescriptor(), id }));
  const sources = descriptors.map((device, index) => ({ id: device.id, label: device.id, principalId: `local-${index}`,
    resources: device.capabilities.map(capability => {
      const handle = runtime.registerSource({ device, capability: capability.id }); runtime.setReadiness(handle, 'available');
      return { handle, device, capability: capability.id };
    }) }));
  const device = { ...pointerSourceDescriptor(), id: 'owned-application', capabilities: pointerSourceDescriptor().capabilities.map(capability => ({ ...capability,
    kind: 'property', permissions: ['write'], ownership: partitions ? { mode: 'partitioned', partitions: ['left', 'right'] } : { mode: 'exclusive' } })) };
  const resources = device.capabilities.map(capability => {
    const handle = runtime.registerSink({ device, capability: capability.id, apply(observation, context) {
      if (holdPosition && capability.id === 'position') return new Promise<void>(resolve => delayed.push({ context, finish() {
        if (!context.signal.aborted && context.isCurrent()) values.set(`${context.partition ?? 'exclusive'}:${capability.id}`, { route: context.routeId, value: observation.value }); resolve();
      } }));
      if (context.isCurrent()) values.set(`${context.partition ?? 'exclusive'}:${capability.id}`, { route: context.routeId, value: observation.value });
    }, release(_reason, context) {
      releases.push(`${context.partition ?? 'exclusive'}:${capability.id}`);
      const key = `${context.partition ?? 'exclusive'}:${capability.id}`;
      if (values.get(key)?.route === context.routeId) values.delete(key);
    } }); runtime.setReadiness(handle, 'available'); return { handle, device, capability: capability.id };
  });
  const controller: InputOwnershipController = createInputOwnershipController({ runtime, applicationId: 'ownership-example', sessionId: 'local', sources,
    destination: { label: 'Application pointer', resources }, now: () => { const callback = clockHook; clockHook = undefined; callback?.(); return time; } });
  let operation = 0;
  const request = (source = 'first', slot = partitions ? 'left' : 'exclusive') => {
    const result = controller.request(source, slot); if (!result.ok) throw new Error(result.reason); assert.equal(result.ok, true); return result.value;
  };
  const approve = (source = 'first', slot = partitions ? 'left' : 'exclusive') => {
    const pending = request(source, slot); return controller.decide(pending.id, pending.expectedOwnerEpoch, true);
  };
  const publish = (source = 0, contact = true) => {
    time += 20; runtime.publish(sources[source]!.resources[1]!.handle, contact, { operationId: String(++operation), deadline: time + descriptors[source]!.capabilities[1]!.delivery.maxAgeMs });
    runtime.publish(sources[source]!.resources[0]!.handle, { x: source ? 0.8 : 0.2, y: 0.4 }); runtime.flush();
  };
  return { controller, runtime, sources, resources, request, approve, publish, values, releases, grants: () => grants,
    grantRequests, setClockHook: (value: () => void) => { clockHook = value; }, setNow: (value: number) => { time = value; }, setAllowed: (value: boolean) => { allowed = value; },
    setHoldPosition: (value: boolean) => { holdPosition = value; }, delayed };
}

test('pending second request, decline, cancel and expiry retain actual incumbent input and grant', () => {
  const h = harness(); assert.equal(h.approve().ok, true); h.publish(); const first = h.controller.snapshot().slots[0]!.owner!;
  const grants = h.grants(), pending = h.request('second'); h.publish();
  assert.equal(h.values.get('exclusive:contact')?.value, true); assert.equal(h.releases.length, 0); assert.equal(h.grants(), grants);
  assert.equal(h.controller.snapshot().slots[0]!.owner?.epoch, first.epoch);
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, false).ok, true);
  const cancelled = h.request('second'); assert.equal(h.controller.cancel(cancelled.id).ok, true);
  const expired = h.request('second');
  for (let at = expired.expiresAt - 29000; at <= expired.expiresAt; at += 500) { h.setNow(at); h.controller.tick(); }
  assert.equal(h.controller.snapshot().slots[0]!.request, undefined); assert.equal(h.releases.length, 0);
  assert.equal(h.controller.snapshot().slots[0]!.owner?.sourceId, 'first'); h.controller.close(); h.runtime.close();
});

test('explicit transfer releases grouped old input once before new effect, and stale consent cannot replace it', () => {
  const h = harness(); h.approve(); h.publish(); const pending = h.request('second');
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch + 1, true).ok, false); assert.equal(h.releases.length, 0);
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, true).ok, true);
  assert.equal(h.values.size, 0); assert.equal(h.releases.length, 2); h.publish(1);
  assert.deepEqual(h.values.get('exclusive:position')?.value, { x: 0.8, y: 0.4 });
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, true).ok, false);
  assert.equal(h.controller.release('exclusive', pending.expectedOwnerEpoch).ok, false);
  const owner = h.controller.snapshot().slots[0]!.owner!; assert.equal(h.controller.release('exclusive', owner.epoch).ok, true);
  h.controller.close(); assert.equal(h.releases.length, 4); h.runtime.close();
});

test('declared partitions have independent actual routes, consent, releases and recovery', () => {
  const h = harness(true); assert.equal(h.approve('first', 'left').ok, true); assert.equal(h.approve('second', 'right').ok, true);
  h.publish(); h.publish(1); assert.equal(h.values.get('left:contact')?.value, true); assert.equal(h.values.get('right:contact')?.value, true);
  assert.equal(h.controller.request('first', 'invented').ok, false);
  const left = h.controller.snapshot().slots[0]!.owner!; h.controller.release('left', left.epoch);
  assert.equal(h.values.has('left:contact'), false); assert.equal(h.values.get('right:contact')?.value, true);
  assert.deepEqual(h.releases, ['left:contact', 'left:position']); h.controller.close(); h.runtime.close();
});

test('post-consent denial leaves released failure with explicit retry; external loss cancels stale request', () => {
  const h = harness(); h.approve(); h.publish(); const pending = h.request('second'); h.setAllowed(false);
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, true).ok, false);
  assert.equal(h.controller.snapshot().slots[0]!.owner, undefined); assert.equal(h.controller.snapshot().slots[0]!.state, 'failed');
  assert.equal(h.values.size, 0); h.setAllowed(true); assert.equal(h.approve().ok, true);
  const obsolete = h.request('second'); h.runtime.setReadiness(h.sources[0]!.resources[0]!.handle, 'unavailable');
  assert.equal(h.controller.decide(obsolete.id, obsolete.expectedOwnerEpoch, true).ok, false);
  assert.equal(h.controller.snapshot().slots[0]!.owner, undefined); assert.equal(h.values.size, 0); h.controller.close(); h.runtime.close();
});

test('reentrant observer close and invalid clock fence target activation and release owned resources', () => {
  const h = harness(); const pending = h.request(); h.controller.subscribe(() => h.controller.close());
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, true).ok, false);
  assert.equal(h.grants(), 0); assert.equal(h.controller.snapshot().closed, true); h.runtime.close();
  const clock = harness(); clock.approve(); clock.publish(); clock.setNow(NaN); clock.controller.tick();
  assert.equal(clock.controller.snapshot().closed, true); assert.equal(clock.values.size, 0); assert.equal(clock.controller.request('second', 'exclusive').ok, false); clock.runtime.close();
});

test('a bounded controller lifetime cannot accumulate unlimited closed runtime routes', () => {
  const h = harness();
  for (let index = 0; index < 64; index++) assert.equal(h.approve(index % 2 ? 'second' : 'first').ok, true);
  const before = h.controller.snapshot().slots[0]!.owner!;
  assert.deepEqual(h.controller.request(before.sourceId === 'first' ? 'second' : 'first', 'exclusive'), { ok: false, reason: 'capacity' });
  assert.equal(h.controller.snapshot().slots[0]!.owner?.epoch, before.epoch); h.controller.close(); h.runtime.close();
});

test('public pointer producer uses actual captured timestamps, profile deadlines and grants before application frames', () => {
  let time = 0;
  const example = createInputOwnershipExample({ partitioned: true, now: () => time });
  example.sources[0]!.driver.nudge(0.02, 0); example.tick();
  assert.equal(example.state().grants, 0); assert.equal(example.state().frames, 0);
  const pending = example.controller.request('first', 'left'); if (!pending.ok) throw new Error('Request failed'); assert.equal(pending.ok, true);
  example.controller.decide(pending.value.id, pending.value.expectedOwnerEpoch, true);
  time += 20; example.sources[0]!.driver.setContact(true); example.tick();
  // Reliable dispatch preserves the initial neutral edge before the later pressed edge.
  time += 20; example.tick();
  assert.equal(example.state().surfaces[0]!.contact, true); assert.equal(example.state().surfaces[1]!.contact, false);
  assert.ok(example.state().grants > 0); assert.ok(example.state().accepted > 0); assert.ok(example.state().frames > 0);
  example.interrupt(); assert.equal(example.state().surfaces[0]!.contact, false);
  assert.equal(example.controller.snapshot().slots[0]!.owner, undefined);
  const frames = example.state().frames; example.stop(); time += 20; example.sources[0]!.driver.setContact(true); example.tick();
  assert.equal(example.state().frames, frames); assert.equal(example.controller.snapshot().closed, true);
});

test('transfer aborts an actual in-flight provider and late completion cannot overwrite the new owner', async () => {
  const h = harness(); h.approve(); h.setHoldPosition(true); h.publish(); assert.equal(h.delayed.length, 1);
  const previous = h.delayed[0]!; h.setHoldPosition(false); const pending = h.request('second');
  assert.equal(h.controller.decide(pending.id, pending.expectedOwnerEpoch, true).ok, true);
  assert.equal(previous.context.signal.aborted, true); assert.equal(previous.context.isCurrent(), false);
  h.publish(1); const current = h.values.get('exclusive:position'); previous.finish(); await Promise.resolve();
  assert.deepEqual(h.values.get('exclusive:position'), current); assert.deepEqual(current?.value, { x: 0.8, y: 0.4 }); h.controller.close(); h.runtime.close();
});

test('current grant expiry removes ownership and pending requests; renewal cannot extend the original grant', () => {
  const h = harness(); h.approve(); h.publish(); h.request('second');
  for (let at = 500; at <= 60000; at += 500) { h.setNow(at); h.controller.tick(); }
  assert.equal(h.controller.snapshot().slots[0]!.owner, undefined); assert.equal(h.controller.snapshot().slots[0]!.request, undefined);
  assert.equal(h.values.size, 0); assert.equal(h.releases.length, 2);
  assert.equal(h.approve('second').ok, true); h.controller.close(); h.runtime.close();
});


function freshSource(h: ReturnType<typeof harness>, principalId = 'replacement-principal') {
  const device = { ...pointerSourceDescriptor(), id: 'replacement-pointer' };
  return { id: 'first', label: 'Replacement', principalId, resources: device.capabilities.map(capability => {
    const handle = h.runtime.registerSource({ device, capability: capability.id }); h.runtime.setReadiness(handle, 'available');
    return { handle, device, capability: capability.id };
  }) };
}

test('source replacement refuses live or pending ownership, then preserves the independent held partition and needs fresh approval', () => {
  const h = harness(true), next = freshSource(h);
  try {
    h.approve('first', 'left'); h.approve('second', 'right'); h.publish(); h.publish(1);
    const independent = h.controller.snapshot().slots[1]!;
    assert.deepEqual(h.controller.replaceSource(h.sources[0]!, next), { ok: false, reason: 'busy' });
    const first = h.controller.snapshot().slots[0]!; assert.equal(h.controller.release('left', first.epoch).ok, true);
    const pending = h.request('first', 'left');
    assert.deepEqual(h.controller.replaceSource(h.sources[0]!, next), { ok: false, reason: 'busy' });
    h.controller.cancel(pending.id);
    const grants = h.grants(); assert.equal(h.controller.replaceSource(h.sources[0]!, next).ok, true);
    assert.deepEqual(h.controller.snapshot().slots[1], independent); assert.equal(h.values.get('right:contact')?.value, true);
    assert.equal(h.grants(), grants); assert.equal(h.values.has('left:contact'), false);
    h.publish(); assert.equal(h.values.has('left:contact'), false, 'Retired issued handles retain no consent');
    assert.deepEqual(h.controller.replaceSource(h.sources[0]!, next), { ok: false, reason: 'stale' });
    const approvalStart = h.grantRequests.length; const request = h.request('first', 'left'); assert.equal(h.controller.decide(request.id, request.expectedOwnerEpoch, true).ok, true);
    assert.equal(h.controller.snapshot().slots[0]!.owner?.principalId, next.principalId); assert.ok(h.grantRequests.length > approvalStart); assert.ok(h.grantRequests.slice(approvalStart).every(request => request.principalId === next.principalId));
    h.setNow(100); assert.equal(h.runtime.publish(next.resources[1]!.handle, true, { operationId: '1', deadline: 200 }).ok, true); h.runtime.flush();
    assert.equal(h.values.get('left:contact')?.value, true); assert.deepEqual(h.controller.snapshot().slots[1], independent);
  } finally { h.controller.close(); h.runtime.close(); }
});

test('source replacement requires current runtime-issued directions and exact identities without touching an independent owner', () => {
  const h = harness(true), next = freshSource(h), foreign = createDeviceRuntime({ authorize() { return undefined; } });
  try {
    h.approve('second', 'right'); h.publish(1); const independent = h.controller.snapshot().slots[1]!;
    const refused = (candidate: typeof next) => { assert.equal(h.controller.replaceSource(h.sources[0]!, candidate).ok, false); assert.deepEqual(h.controller.snapshot().slots[1], independent); assert.equal(h.values.get('right:contact')?.value, true); };
    refused({ ...next, principalId: h.sources[1]!.principalId });
    refused({ ...next, principalId: h.sources[0]!.principalId });
    refused({ ...next, resources: next.resources.map(value => ({ ...value, handle: { id: value.handle.id } })) });
    refused({ ...next, resources: next.resources.map(value => ({ ...value, handle: foreign.registerSource({ device: value.device, capability: value.capability }) })) });
    refused({ ...next, resources: next.resources.map(value => ({ ...value, handle: h.runtime.registerSink({ device: { ...value.device, capabilities: value.device.capabilities.map(capability => ({ ...capability, kind: 'property', permissions: ['write'] })) }, capability: value.capability, apply() {}, release() {} }) })) });
    refused({ ...next, resources: next.resources.map(value => ({ ...value, device: { ...value.device, label: 'False descriptor' } })) });
    h.runtime.unregister(next.resources[0]!.handle); refused(next);
  } finally { h.controller.close(); h.runtime.close(); foreign.close(); }
});

test('source replacement snapshots input across accessor and clock reentry and refuses closed runtime provenance', () => {
  const h = harness(true), next = freshSource(h);
  try {
    h.approve('second', 'right'); h.publish(1); const independent = h.controller.snapshot().slots[1]!; let reentry: unknown;
    const candidate = { ...next, get label() { reentry = h.controller.request('first', 'left'); return next.label; } };
    assert.equal(h.controller.replaceSource(h.sources[0]!, candidate).ok, true); assert.deepEqual(reentry, { ok: false, reason: 'busy' });
    assert.deepEqual(h.controller.snapshot().slots[1], independent);
    const newer = freshSource(h, 'another-principal'); h.setClockHook(() => h.runtime.unregister(newer.resources[0]!.handle));
    assert.equal(h.controller.replaceSource(next, newer).ok, false); assert.deepEqual(h.controller.snapshot().slots[1], independent);
  } finally { h.controller.close(); h.runtime.close(); }
  const closed = harness(true), unused = freshSource(closed); closed.runtime.close();
  assert.equal(closed.controller.replaceSource(closed.sources[0]!, unused).ok, false); closed.controller.close();
});


test('constructor compatibility remains available to a custom runtime while source replacement refuses absent issuance provenance', () => {
  const h = harness(true);
  const custom = new Proxy(h.runtime, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
  const controller = createInputOwnershipController({ runtime: custom, applicationId: 'custom-host', sessionId: 'test', sources: h.sources,
    destination: { label: 'Application pointer', resources: h.resources }, now: () => 0 });
  try { assert.equal(controller.snapshot().closed, false); assert.deepEqual(controller.replaceSource(h.sources[0]!, freshSource(h)), { ok: false, reason: 'invalid-source' }); }
  finally { controller.close(); h.controller.close(); h.runtime.close(); }
});
