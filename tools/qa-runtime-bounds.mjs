#!/usr/bin/env node
/** Local bounded-load qualification. Run with --expose-gc; no network or device access. */
import assert from 'node:assert/strict';
import { createDeviceRuntime } from '../packages/device-runtime/src/index.ts';

assert.equal(typeof globalThis.gc, 'function', 'Run with node --expose-gc');
const heap = () => { globalThis.gc(); return process.memoryUsage().heapUsed; };
function device(id, mode, sink = false) {
  const command = mode === 'reliable';
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:bounded-load', version: '1.0.0' }, runtime: { platform: 'embedded-node' },
    capabilities: [{ id: 'signal', semantic: 'example:bounded-signal', schemaVersion: 1,
      kind: sink ? command ? 'command' : 'property' : command ? 'event' : 'sample',
      value: { type: 'boolean' },
      delivery: command ? { mode: 'reliable', maxAgeMs: 5000 } : { mode: 'latest', maxHz: 100, maxAgeMs: 1000 },
      permissions: sink ? [command ? 'invoke' : 'write'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'exclusive' } } : {}) }] };
}
const scope = { principalId: 'owner', applicationId: 'bounded-load', sessionId: 'local' };
const grant = () => ({ expiresAt: 100000, maxAgeMs: 5000, maxHz: 100 });

function fanout() {
  let delivered = 0, releases = 0;
  const runtime = createDeviceRuntime({ now: () => 0, authorize: grant, maxRoutes: 128 });
  try {
    const source = runtime.registerSource({ device: device('sample-source', 'latest'), capability: 'signal' });
    runtime.setReadiness(source, 'available');
    const routes = [];
    for (let index = 0; index < 33; index++) {
      const sink = runtime.registerSink({ device: device(`sample-sink-${index}`, 'latest', true), capability: 'signal',
        apply(observation) { assert.equal(observation.value, true); delivered++; }, release() { releases++; } });
      runtime.setReadiness(sink, 'available');
      const route = runtime.route({ from: source, to: sink, ...scope });
      assert.equal(route.start().ok, index < 32);
      if (index < 32) routes.push(route);
    }
    const first = heap();
    for (let index = 0; index < 1000; index++) assert.equal(runtime.publish(source, true).ok, true);
    const afterShortBurst = heap();
    for (let index = 0; index < 19000; index++) assert.equal(runtime.publish(source, true).ok, true);
    const afterLongBurst = heap();
    assert.ok(afterLongBurst - afterShortBurst < 8 * 1024 * 1024,
      `Latest fan-out retained unbounded heap: ${afterLongBurst - afterShortBurst} bytes`);
    assert.ok(routes.every(route => route.status().pending <= 1));
    assert.equal(runtime.publish(source, { value: true, hostile: 'x'.repeat(5000) }).ok, false);
    runtime.flush();
    assert.equal(delivered, 32);
    assert.ok(routes.every(route => route.status().pending === 0));
    runtime.setReadiness(source, 'unavailable');
    assert.ok(routes.every(route => route.status().state === 'closed'));
    assert.equal(releases, 32);
    return { routes: routes.length, publications: 20000, delivered,
      heapBaseline: first, heapAfterShortBurst: afterShortBurst, heapAfterLongBurst: afterLongBurst,
      retainedGrowthBytes: afterLongBurst - afterShortBurst };
  } finally { runtime.close(); }
}

function reliableQueue() {
  let applied = 0;
  const runtime = createDeviceRuntime({ now: () => 0, authorize: grant });
  try {
    const source = runtime.registerSource({ device: device('event-source', 'reliable'), capability: 'signal' });
    const sink = runtime.registerSink({ device: device('command-sink', 'reliable', true), capability: 'signal',
      apply() { applied++; }, release() {} });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ from: source, to: sink, ...scope, queueCapacity: 64 });
    assert.equal(route.start().ok, true);
    let accepted = 0, rejected = 0;
    for (let index = 1; index <= 1000; index++) {
      const result = runtime.publish(source, true, { operationId: String(index), deadline: 5000 });
      if (result.ok && result.value.accepted > 0) accepted++;
      else rejected++;
      assert.ok(route.status().pending <= 64);
    }
    assert.equal(accepted, 64);
    assert.equal(rejected, 936);
    assert.equal(route.operations().length, 64);
    route.stop('owner-revoked');
    assert.equal(route.status().pending, 0);
    assert.equal(route.operations().filter(operation => operation.state === 'cancelled').length, 64);
    runtime.flush(); assert.equal(applied, 0);
    return { queueLimit: 64, accepted, rejected, cancelled: 64 };
  } finally { runtime.close(); }
}

async function hangingProviders() {
  let called = 0, liveEffects = 0;
  const finish = [], contexts = [];
  const runtime = createDeviceRuntime({ now: () => 0, authorize: grant,
    maxPendingDeliveries: 4, maxRoutes: 16 });
  try {
    const source = runtime.registerSource({ device: device('hanging-source', 'latest'), capability: 'signal' });
    runtime.setReadiness(source, 'available');
    const sinks = [], routes = [];
    for (let index = 0; index < 8; index++) {
      const sink = runtime.registerSink({ device: device(`hanging-sink-${index}`, 'latest', true), capability: 'signal',
        apply(_observation, context) {
          called++; contexts.push(context);
          return new Promise(resolve => finish.push(() => { if (context.isCurrent()) liveEffects++; resolve(); }));
        }, release() {} });
      runtime.setReadiness(sink, 'available'); sinks.push(sink);
      const route = runtime.route({ from: source, to: sink, ...scope });
      assert.equal(route.start().ok, true); routes.push(route);
    }
    assert.equal(runtime.publish(source, true).ok, true);
    runtime.flush();
    assert.equal(called, 4);
    assert.equal(contexts.length, 4);
    runtime.setReadiness(source, 'unavailable');
    assert.ok(contexts.every(context => context.signal.aborted && !context.isCurrent()));
    assert.ok(routes.every(route => route.status().state === 'closed' && route.status().pending === 0));
    runtime.setReadiness(source, 'available');
    const replacement = runtime.route({ from: source, to: sinks[0], ...scope });
    assert.equal(replacement.start().ok, true);
    assert.equal(runtime.publish(source, true).ok, true);
    runtime.flush(); assert.equal(called, 4);
    for (const resolve of finish.splice(0)) resolve();
    await new Promise(resolve => setImmediate(resolve));
    runtime.flush(); assert.equal(called, 5);
    assert.equal(liveEffects, 0);
    for (const resolve of finish.splice(0)) resolve();
    replacement.stop('done');
    assert.equal(liveEffects, 1);
    return { pendingProviderLimit: 4, initialCalls: 4, callsAfterRelease: called,
      abortedContexts: contexts.length - 1, liveReplacementEffects: liveEffects };
  } finally { runtime.close(); }
}

const fanoutResult = fanout();
const queueResult = reliableQueue();
const hangingResult = await hangingProviders();
console.log(JSON.stringify({ status: 'pass', environment: { node: process.version, platform: process.platform,
  arch: process.arch }, fanout: fanoutResult, reliableQueue: queueResult, hangingProviders: hangingResult }));
