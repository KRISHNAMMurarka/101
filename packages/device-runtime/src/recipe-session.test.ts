import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, createRecipeSession } from './index.ts';
import { application, phone } from '../../../examples/device-pipelines/pointer.ts';
import { pointerRecipe, roomControlRecipe } from '../../../examples/device-pipelines/recipe.ts';
import { relay, thermometer, thresholdDevice, thresholdManifest } from '../../../examples/device-pipelines/sensor-feedback.ts';

function fixture() {
  let now = 0, allowed = true, approved = true, missing = false, bindingFails = false;
  let consentCalls = 0, grantCalls = 0, delivered = 0, released = 0;
  const runtime = createDeviceRuntime({ now: () => now, authorize() {
    grantCalls++;
    return allowed ? { expiresAt: now + 100, maxAgeMs: 1000, maxHz: 60 } : undefined;
  } });
  const from = runtime.registerSource({ device: phone, capability: 'position' });
  const to = runtime.registerSink({ device: application, capability: 'position',
    apply(_observation, context) { if (context.isCurrent()) delivered++; },
    release() { released++; } });
  runtime.setReadiness(from, 'available'); runtime.setReadiness(to, 'available');
  const session = createRecipeSession(pointerRecipe, {
    runtime, identity: { principalId: 'owner', applicationId: 'pointer-recipe', sessionId: 'local' },
    getEnvironment() { return { devices: [phone, application], processors: [], selections: missing ? {
      surface: { deviceId: application.id, capability: 'position' },
    } : { touch: { deviceId: phone.id, capability: 'position' },
      surface: { deviceId: application.id, capability: 'position' } } }; },
    requestConsent(preview) {
      consentCalls++;
      assert.deepEqual(preview.requiredOperations.map(item => item.operation), ['subscribe', 'write']);
      return approved;
    },
    bind(reference) {
      if (bindingFails && reference.node === 'surface') throw new Error('missing sink');
      return reference.node === 'touch'
        ? { device: phone, capability: 'position', handle: from }
        : { device: application, capability: 'position', handle: to };
    },
  });
  return { runtime, from, to, session,
    setNow(value: number) { now = value; }, setAllowed(value: boolean) { allowed = value; },
    setApproved(value: boolean) { approved = value; }, setMissing(value: boolean) { missing = value; },
    setBindingFails(value: boolean) { bindingFails = value; },
    counts() { return { consentCalls, grantCalls, delivered, released }; },
  };
}

test('recipe consent preview precedes every grant and starts a selected route', async () => {
  const h = fixture();
  try {
    h.setApproved(false);
    assert.deepEqual(await h.session.start(), { ok: false, reason: 'consent-denied' });
    assert.equal(h.counts().grantCalls, 0);
    h.setApproved(true);
    assert.equal((await h.session.start()).ok, true);
    assert.equal(h.counts().grantCalls, 2);
    h.runtime.publish(h.from, { x: 0.2, y: 0.8 }); h.runtime.flush();
    assert.equal(h.counts().delivered, 1);
    h.session.stop();
    assert.equal(h.counts().released, 1);
  } finally { h.runtime.close(); }
});

test('missing selection and failed binding recover through fresh preview and consent', async () => {
  const h = fixture();
  try {
    h.setMissing(true);
    assert.deepEqual(await h.session.start(), { ok: false, reason: 'resolution-failed' });
    assert.equal(h.counts().consentCalls, 0);
    h.setMissing(false); h.setBindingFails(true);
    assert.deepEqual(await h.session.start(), { ok: false, reason: 'host-binding-failed' });
    h.setBindingFails(false);
    assert.equal((await h.session.start()).ok, true);
    assert.equal(h.counts().consentCalls, 2);
  } finally { h.session.stop(); h.runtime.close(); }
});

test('denied or expired grants and lost members require fresh authority on retry', async () => {
  const h = fixture();
  try {
    h.setAllowed(false);
    assert.deepEqual(await h.session.start(), { ok: false, reason: 'denied' });
    h.setAllowed(true);
    assert.equal((await h.session.start()).ok, true);
    h.setNow(101); h.runtime.flush();
    assert.equal(h.session.status().state, 'paused');
    assert.equal((await h.session.start()).ok, true);
    h.runtime.setReadiness(h.from, 'unavailable');
    assert.equal(h.session.status().state, 'paused');
    h.runtime.setReadiness(h.from, 'available');
    assert.equal((await h.session.start()).ok, true);
    assert.equal(h.counts().consentCalls, 4);
  } finally { h.session.stop(); h.runtime.close(); }
});

test('stop during pending consent cannot create a late route', async () => {
  let allow!: (value: boolean) => void;
  let grantCalls = 0;
  const runtime = createDeviceRuntime({ now: () => 0, authorize() {
    grantCalls++; return { expiresAt: 100, maxAgeMs: 1000, maxHz: 60 };
  } });
  try {
    const session = createRecipeSession(pointerRecipe, {
      runtime, identity: { principalId: 'owner', applicationId: 'pointer-recipe', sessionId: 'local' },
      getEnvironment: () => ({ devices: [phone, application], processors: [], selections: {
        touch: { deviceId: phone.id, capability: 'position' }, surface: { deviceId: application.id, capability: 'position' },
      } }),
      requestConsent: () => new Promise<boolean>(resolve => { allow = resolve; }),
      bind: () => { throw new Error('bind must not run'); },
    });
    const pending = session.start();
    session.stop(); allow(true);
    assert.deepEqual(await pending, { ok: false, reason: 'closed' });
    assert.equal(grantCalls, 0);
  } finally { runtime.close(); }
});

test('processor-backed recipe prepares both required legs and cancels after downstream denial', async () => {
  let allowRelay = false, commands = 0, released = 0;
  const runtime = createDeviceRuntime({ now: () => 0, authorize(request) {
    return request.sink.deviceId === relay.id && !allowRelay ? undefined
      : { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  const sensor = runtime.registerSource({ device: thermometer, capability: 'temperature' });
  const derived = runtime.registerSource({ device: thresholdDevice, capability: 'relay-state' });
  const input = runtime.registerSink({ device: thresholdDevice, capability: 'temperature-input',
    apply(observation, context) {
      if (context.isCurrent()) runtime.publish(derived, (observation.value as number) >= 30,
        { operationId: '1', deadline: 500 });
    }, release() { released++; } });
  const output = runtime.registerSink({ device: relay, capability: 'set-state',
    apply(_observation, context) { if (context.isCurrent()) commands++; }, release() { released++; } });
  for (const handle of [sensor, derived, input, output]) runtime.setReadiness(handle, 'available');
  const session = createRecipeSession(roomControlRecipe, {
    runtime, identity: { principalId: 'owner', applicationId: 'room-recipe', sessionId: 'local' },
    getEnvironment: () => ({ devices: [thermometer, relay], processors: [thresholdManifest], selections: {
      sensor: { deviceId: thermometer.id, capability: 'temperature' },
      relay: { deviceId: relay.id, capability: 'set-state' },
    } }),
    requestConsent(preview) {
      assert.deepEqual(preview.requiredOperations.map(item => item.operation), ['subscribe', 'invoke']);
      return true;
    },
    bind(reference) {
      if (reference.node === 'sensor') return { device: thermometer, capability: 'temperature', handle: sensor };
      if (reference.node === 'relay') return { device: relay, capability: 'set-state', handle: output };
      if (reference.port === 'temperature') return { device: thresholdDevice, capability: 'temperature-input', handle: input };
      return { device: thresholdDevice, capability: 'relay-state', handle: derived };
    },
  });
  try {
    assert.deepEqual(await session.start(), { ok: false, reason: 'denied' });
    assert.equal(commands, 0);
    allowRelay = true;
    const started = await session.start();
    assert.equal(started.ok, true);
    if (started.ok) assert.deepEqual(started.value.active, ['measure', 'actuate']);
    runtime.publish(sensor, 31.25); runtime.flush(); runtime.flush();
    assert.equal(commands, 1);
    session.stop();
    assert.equal(released, 2);
  } finally { runtime.close(); }
});
