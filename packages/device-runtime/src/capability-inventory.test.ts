import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import { CAPABILITY_INVENTORY_LIMITS, createCapabilityInventory } from './capability-inventory.ts';
import type { CapabilityInventoryController, CapabilityInventoryOptions } from './capability-inventory.ts';
import type { JsonObject } from '@101/device-model';
import type { AuthorizationRequest } from './types.ts';

function descriptor(kind = 'sample', delivery = 'latest') {
  return { schemaVersion: 1, id: 'source', label: 'Camera vendor label is not evidence', revision: 1,
    adapter: { id: 'example:inventory', version: '1.0.0' }, runtime: { platform: 'test' },
    capabilities: [{ id: 'reading', semantic: 'example:reading', schemaVersion: 1, kind,
      value: { type: 'scalar', unit: '1', min: 0, max: 100 },
      delivery: delivery === 'latest' ? { mode: 'latest', maxHz: 100, maxAgeMs: 100 } : { mode: 'reliable', maxAgeMs: 100 },
      permissions: kind === 'command' ? ['invoke'] : kind === 'property' ? ['read', 'subscribe'] : ['subscribe'] }] };
}
function harness(config: { kind?: string; delivery?: string; operation?: 'read' | 'subscribe'; grantAge?: number;
  authorize?: (request: AuthorizationRequest, inventory: CapabilityInventoryController) => void; probeMs?: number } = {}) {
  let at = 0, allowed = true, inventory: CapabilityInventoryController;
  let clockHook: (() => void) | undefined; const requests: AuthorizationRequest[] = [];
  const runtime = createDeviceRuntime({ now: () => { clockHook?.(); return at; }, clockDomain: 'local', authorize(request) {
    requests.push(request); config.authorize?.(request, inventory);
    if (allowed && inventory.matches(request)) return { expiresAt: at + 1000, maxAgeMs: config.grantAge ?? 100, maxHz: 100 };
  } });
  const device = descriptor(config.kind, config.delivery), source = runtime.registerSource({ device, capability: 'reading' });
  runtime.setReadiness(source, 'available');
  const options: CapabilityInventoryOptions = { runtime, clockDomain: 'local', now: () => { clockHook?.(); return at; },
    scope: { principalId: 'operator', applicationId: 'inventory', sessionId: 'local' },
    resources: [{ id: 'reading', sourceHandle: source, device, capability: 'reading' }],
    selected: [{ id: 'reading', operation: config.operation ?? 'subscribe' }], probeMs: config.probeMs ?? 500 };
  inventory = createCapabilityInventory(options);
  return { inventory, runtime, source, options, requests, setTime: (value: number) => { at = value; },
    allow: (value: boolean) => { allowed = value; }, hook: (value?: () => void) => { clockHook = value; },
    replaceInventory: (value: CapabilityInventoryController) => { inventory = value; },
    publish(value = 3, provenance?: JsonObject) {
      const result = runtime.publish(source, value, { timestamp: at, clockDomain: 'local', ...(provenance ? { provenance } : {}) }); runtime.flush(); return result;
    }, row: () => inventory.snapshot().rows[0]!, close() { inventory.close(); runtime.close(); } };
}

test('declarations and labels are inert; denied route cannot establish live capability', () => {
  const h = harness();
  try {
    h.publish(); assert.equal(h.row().state, 'unavailable'); assert.equal(h.requests.length, 0);
    h.allow(false); assert.equal(h.inventory.start().ok, true);
    assert.equal(h.row().reason, 'access-denied'); assert.equal(h.row().proof, undefined);
    h.setTime(1); h.publish(); assert.equal(h.row().state, 'unavailable');
  } finally { h.close(); }
});
test('only a post-probe current subscription yields immutable original timing/quality/provenance proof', () => {
  const h = harness();
  try {
    h.publish(); h.setTime(10); h.inventory.start(); h.runtime.flush(); assert.equal(h.row().reason, 'waiting-for-data');
    // A reading received at the same start stamp is not a post-probe sample.
    h.publish(); assert.equal(h.row().state, 'unavailable');
    h.setTime(20); const provenance = { sourceTime: { clockId: 'hardware-clock', at: 7 }, calibration: { revision: 1 }, profile: 'reviewed' };
    h.publish(8, provenance); const row = h.row();
    assert.equal(row.state, 'supported'); assert.equal(row.proof?.timestamp, 20); assert.equal(row.proof?.receivedAt, 20);
    assert.equal(row.proof?.clockDomain, 'local'); assert.equal(row.proof?.quality, 'valid'); assert.equal(row.proof?.ageAtQualificationMs, 0);
    assert.deepEqual(row.proof?.provenance, provenance); assert.equal(Object.hasOwn(row.proof!, 'value'), false);
    assert.equal(Object.isFrozen(row.proof?.provenance), true); assert.equal(Object.isFrozen(row), true);
    provenance.sourceTime.at = 99; assert.equal((row.proof?.provenance?.sourceTime as { at: number }).at, 7);
  } finally { h.close(); }
});
test('one-shot read qualifies a genuine fresh retained property under separate read grant with original age', () => {
  const h = harness({ kind: 'property', operation: 'read' });
  try {
    h.setTime(4); h.publish(); h.setTime(25); assert.equal(h.inventory.start().ok, true); h.runtime.flush();
    assert.equal(h.row().state, 'supported'); assert.equal(h.row().proof?.timestamp, 4);
    assert.equal(h.row().proof?.ageAtQualificationMs, 21); assert.equal(h.row().proof?.expiresAt, 104);
    assert.equal(h.requests[0]?.sourceOperation, 'read'); assert.equal(h.inventory.snapshot().activeRoutes, 0);
    h.setTime(104); h.inventory.sweep(); assert.equal(h.row().state, 'expired');
  } finally { h.close(); }
});
test('unknown, missing provider, unsupported read and command selections never create routes', () => {
  const h = harness();
  const inventory = createCapabilityInventory({ ...h.options,
    resources: [...h.options.resources, { id: 'missing', device: descriptor(), capability: 'reading' },
      { id: 'command', device: descriptor('command', 'reliable'), capability: 'reading' }],
    selected: [{ id: 'camera-from-label', operation: 'subscribe' }, { id: 'missing', operation: 'subscribe' },
      { id: 'reading', operation: 'read' }, { id: 'command', operation: 'subscribe' }] });
  try {
    inventory.start(); assert.deepEqual(inventory.snapshot().rows.map(row => [row.state, row.reason]), [
      ['unsupported', 'unknown-resource'], ['unavailable', 'missing-provider'], ['unsupported', 'unsupported-operation'], ['unsupported', 'unsupported-operation']]);
    assert.equal(h.requests.length, 0);
  } finally { inventory.close(); h.close(); }
});
test('scope matching includes exact revision, schema, source and private sink and never itself grants', () => {
  const h = harness();
  try {
    h.inventory.start(); const request = h.requests[0]!; assert.equal(h.inventory.matches(request), true);
    for (const altered of [{ ...request, principalId: 'other' }, { ...request, applicationId: 'other' }, { ...request, sessionId: 'other' },
      { ...request, sourceOperation: 'read' as const }, { ...request, sinkOperation: 'invoke' as const }, { ...request, partition: 'p' },
      { ...request, source: { ...request.source, descriptorRevision: 2 } }, { ...request, source: { ...request.source, schemaVersion: 2 } },
      { ...request, sink: { ...request.sink, registrationId: 'foreign' } }]) assert.equal(h.inventory.matches(altered), false);
    h.inventory.stop(); assert.equal(h.inventory.matches(request), false);
  } finally { h.close(); }
});
test('forged handle and mismatched descriptor cannot qualify actual runtime data', () => {
  for (const variant of ['forged', 'descriptor']) {
    const h = harness(); const resource = h.options.resources[0]!;
    const inventory = createCapabilityInventory({ ...h.options, resources: [{ ...resource,
      ...(variant === 'forged' ? { sourceHandle: { ...h.source } } : { device: { ...descriptor(), revision: 2 } }) }] });
    try { h.replaceInventory(inventory); inventory.start(); h.setTime(1); h.publish(); assert.equal(inventory.snapshot().rows[0]?.state, 'unavailable'); }
    finally { inventory.close(); h.close(); }
  }
});
test('actual narrowed grant age expires quiet proof without widening descriptor or source time', () => {
  const h = harness({ grantAge: 20 });
  try {
    h.inventory.start(); h.setTime(1); h.publish(); assert.equal(h.row().proof?.expiresAt, 21);
    h.setTime(21); h.inventory.sweep(); assert.equal(h.row().state, 'expired'); assert.equal(h.inventory.snapshot().activeRoutes, 0);
    h.setTime(22); h.publish(); assert.equal(h.row().state, 'expired');
  } finally { h.close(); }
});
test('owned timer expires quiet actual data without requiring a caller flush', async () => {
  const h = harness({ grantAge: 10 });
  try {
    h.inventory.start(); h.setTime(1); h.publish(); h.setTime(12);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(h.row().state, 'expired');
    assert.equal(h.inventory.snapshot().timerArmed, false);
  } finally { h.close(); }
});
test('silence is expired, current source loss and unregister are unavailable, and old callbacks cannot restore', () => {
  for (const loss of ['silence', 'readiness', 'unregister']) {
    const h = harness({ probeMs: 10 });
    try {
      h.inventory.start(); if (loss !== 'silence') { h.setTime(1); h.publish(); assert.equal(h.row().state, 'supported'); }
      if (loss === 'readiness') h.runtime.setReadiness(h.source, 'unavailable');
      else if (loss === 'unregister') h.runtime.unregister(h.source);
      else { h.setTime(10); h.inventory.sweep(); }
      assert.equal(h.row().state, loss === 'silence' ? 'expired' : 'unavailable'); assert.equal(h.row().proof, undefined);
      h.setTime(11); h.publish(); assert.notEqual(h.row().state, 'supported');
    } finally { h.close(); }
  }
});
test('authorization callback stop/close/restart reentry cannot retain route or proof', () => {
  for (const action of ['stop', 'close', 'start']) {
    const h = harness({ authorize(_request, inventory) {
      if (action === 'stop') inventory.stop(); else if (action === 'close') inventory.close();
      else assert.deepEqual(inventory.start(), { ok: false, reason: 'busy' });
    } });
    try {
      h.inventory.start(); h.setTime(1); h.publish();
      if (action !== 'start') { assert.notEqual(h.row().state, 'supported'); assert.equal(h.inventory.snapshot().activeRoutes, 0); assert.equal(h.inventory.snapshot().timerArmed, false); }
    } finally { h.close(); }
  }
});
test('clock callback teardown at sink delivery/currentness never commits a stale proof or leaks timer', () => {
  const h = harness();
  try {
    h.inventory.start(); h.setTime(1); h.runtime.publish(h.source, 4);
    h.hook(() => { h.hook(); h.inventory.close(); }); h.runtime.flush();
    assert.equal(h.row().state, 'unavailable'); assert.equal(h.row().proof, undefined); assert.equal(h.inventory.snapshot().timerArmed, false);
  } finally { h.close(); }
});
test('invalid/backward/mismatched clock fails closed, rather than comparing foreign source epochs', () => {
  const h = harness();
  try {
    assert.throws(() => createCapabilityInventory({ ...h.options, clockDomain: 'foreign' }), TypeError);
    h.setTime(10); h.inventory.start(); h.setTime(9); h.inventory.sweep(); assert.equal(h.inventory.snapshot().closed, true);
    assert.equal(h.row().proof, undefined);
  } finally { h.close(); }
});
test('bounded starts do not reset on stop and constructor rejects excess/getters/duplicates', () => {
  const h = harness();
  try {
    h.allow(false); for (let index = 0; index < CAPABILITY_INVENTORY_LIMITS.attempts; index++) { assert.equal(h.inventory.start().ok, true); h.inventory.stop(); }
    assert.deepEqual(h.inventory.start(), { ok: false, reason: 'capacity' });
    assert.throws(() => createCapabilityInventory({ ...h.options, selected: Array(17).fill({ id: 'reading', operation: 'subscribe' }) }));
    assert.throws(() => createCapabilityInventory({ ...h.options, selected: [...h.options.selected, ...h.options.selected] }));
    let gets = 0; const malicious = Object.defineProperty({}, 'id', { enumerable: true, get() { gets++; return 'reading'; } });
    assert.throws(() => createCapabilityInventory({ ...h.options, selected: [malicious as never] })); assert.equal(gets, 0);
    assert.throws(() => createCapabilityInventory({ ...h.options, maxAgeMs: 30001 }));
    h.inventory.close(); assert.deepEqual(h.inventory.start(), { ok: false, reason: 'closed' });
  } finally { h.close(); }
});
test('reliable event source uses actual routed operation; proof is latest only and stop leaves borrowed source usable', () => {
  const h = harness({ kind: 'event', delivery: 'reliable' });
  try {
    h.inventory.start(); h.setTime(1); assert.equal(h.runtime.publish(h.source, 7, { operationId: '1', deadline: 50 }).ok, true); h.runtime.flush();
    assert.equal(h.row().state, 'supported'); assert.equal(h.row().proof?.sequence, 0);
    h.inventory.stop(); assert.equal(h.row().proof, undefined); assert.deepEqual(h.runtime.publish(h.source, 9, { operationId: '2', deadline: 50 }), { ok: false, reason: 'no-route' });
    assert.equal(h.inventory.snapshot().timerArmed, false);
  } finally { h.close(); }
});

test('every actual delivery clock boundary fences a stop followed by a new probe epoch', () => {
  // flush, dispatch, context.isCurrent, limits, and inventory receipt check all
  // call the same trusted clock. Replacing during each cannot give old work to
  // the replacement attempt, even though the private sink is reused.
  for (let boundary = 1; boundary <= 5; boundary++) {
    const h = harness();
    try {
      h.inventory.start(); h.setTime(1); assert.equal(h.runtime.publish(h.source, 4).ok, true);
      let calls = 0;
      h.hook(() => {
        if (++calls !== boundary) return;
        h.hook(); h.inventory.stop(); assert.equal(h.inventory.start().ok, true);
      });
      h.runtime.flush(); assert.equal(h.row().state, 'unavailable'); assert.equal(h.row().proof, undefined);
      h.setTime(20); h.publish(); assert.equal(h.row().state, 'supported'); assert.equal(h.row().proof?.timestamp, 20);
    } finally { h.close(); }
  }
});
test('initial clock close and quiet sweep clock close cannot leave owned timer or authorize late start', () => {
  for (const boundary of ['initial', 'sweep']) {
    const h = harness();
    try {
      if (boundary === 'sweep') { h.inventory.start(); h.setTime(1); h.publish(); }
      h.hook(() => { h.hook(); h.inventory.close(); });
      if (boundary === 'initial') assert.equal(h.inventory.start().ok, false); else h.inventory.sweep();
      assert.equal(h.inventory.snapshot().closed, true); assert.equal(h.inventory.snapshot().timerArmed, false);
      assert.equal(h.inventory.snapshot().activeRoutes, 0); assert.equal(h.row().proof, undefined);
    } finally { h.close(); }
  }
});
test('proof retention is bounded and invalid/future/nonvalid producer data cannot create support', () => {
  const h = harness();
  try {
    h.inventory.start(); h.setTime(1);
    assert.equal(h.runtime.publish(h.source, 4, { timestamp: 2 }).ok, false);
    assert.equal(h.runtime.publish(h.source, Infinity).ok, false); assert.equal(h.row().proof, undefined);
    h.publish(4, { note: 'x'.repeat(CAPABILITY_INVENTORY_LIMITS.provenanceBytes) });
    assert.equal(h.row().proof, undefined);
    h.setTime(20); h.publish(5); assert.equal(h.row().state, 'supported');
    assert.equal(h.runtime.publish(h.source, null, { quality: 'unavailable' }).ok, false);
    assert.equal(h.row().state, 'unavailable'); assert.equal(h.row().proof, undefined);
  } finally { h.close(); }
});
