import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from './index.ts';
import { createAssetReference } from '@101/device-model';
import type { JsonValue } from '@101/device-model';

const create = (runtime as Record<string, unknown>).createWorkloadHandoff as
  ((options: unknown) => runtime.WorkloadHandoff) | undefined;
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const context = { devices: [sensor], processors: [] };
const workload = { schemaVersion: 1, id: 'example:handoff', version: '1.0.0',
  application: { codeSha256: 'a'.repeat(64), runtime: { platform: 'node', minimumVersion: '24.0.0' },
    budget: { maxComputeMs: 5, maxMemoryBytes: 65536 } },
  processors: [], assets: [], resources: [
    { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe', required: true }],
  privacy: { mode: 'local-only', purpose: null, destinations: [], retention: 'none' },
  budget: { maxComputeMs: 5, maxMemoryBytes: 65536 },
  restart: { mode: 'snapshot', formatVersion: 1, applicationCodeSha256: 'a'.repeat(64),
    processorState: 'reset-on-resume', onIncompatible: 'cold-restart' } };

function host(id: string, trace: string[], initial: JsonValue = { count: 0 }) {
  let state = initial, running = id === 'host-a';
  const value: runtime.HandoffHost = { id, assets: [],
    pause(epoch) { trace.push(`${id}:pause:${epoch.epoch}`); running = false; return state; },
    stage(next, epoch) { trace.push(`${id}:stage:${epoch.epoch}`); state = next; },
    resume(epoch) { trace.push(`${id}:resume:${epoch.epoch}`); assert.equal(epoch.isCurrent(), true); running = true; },
    stop(epoch) { trace.push(`${id}:stop:${epoch.epoch}`); running = false; },
    abort(epoch) { trace.push(`${id}:abort:${epoch.epoch}`); running = false; },
  };
  return { value, state: () => state, running: () => running,
    command(epoch: runtime.HandoffEpoch): boolean { return running && epoch.isCurrent() && !epoch.signal.aborted; } };
}

test('handoff transfers validated state only after source fencing and leaves one command authority', async () => {
  assert.equal(typeof create, 'function');
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  const handoff = create!({ workload, context, source: source.value,
    validateState: (state: JsonValue) => typeof state === 'object' && state !== null && !Array.isArray(state) &&
      state.count === 2 });
  const oldEpoch = handoff.authority();
  assert.equal(source.command(oldEpoch), true);
  const result = await handoff.transfer(target.value);
  assert.equal(result.ok, true);
  assert.equal(oldEpoch.isCurrent(), false);
  assert.equal(source.command(oldEpoch), false);
  assert.equal(target.command(handoff.authority()), true);
  assert.deepEqual(target.state(), { count: 2 });
  assert.deepEqual(trace, ['host-a:pause:1', 'host-b:stage:2', 'host-a:stop:1', 'host-b:resume:2']);
  assert.deepEqual(handoff.status(), { state: 'active', hostId: 'host-b', epoch: 2 });
  const targetEpoch = handoff.authority();
  assert.equal((await handoff.transfer(source.value)).ok, true);
  assert.equal(target.command(targetEpoch), false);
  assert.equal(source.command(handoff.authority()), true);
  assert.deepEqual(handoff.status(), { state: 'active', hostId: 'host-a', epoch: 3 });
});

test('cancelling an interrupted target stage restores the source under a newer epoch', async () => {
  assert.equal(typeof create, 'function');
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  let entered!: () => void;
  const staging = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  target.value.stage = async (_state, epoch) => {
    trace.push(`host-b:stage:${epoch.epoch}`);
    entered();
    await blocked;
    assert.equal(epoch.isCurrent(), false);
  };
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  const oldEpoch = handoff.authority();
  const transfer = handoff.transfer(target.value);
  await staging;
  assert.equal(handoff.cancel(), true);
  const result = await transfer;
  assert.equal(result.ok, false);
  assert.equal(source.command(oldEpoch), false);
  assert.equal(source.command(handoff.authority()), true);
  assert.equal(handoff.status().hostId, 'host-a');
  assert.ok(handoff.status().epoch > 2);
  assert.ok(trace.includes('host-b:abort:2'));
  release();
});

test('target activation failure revokes its epoch before restoring source authority', async () => {
  assert.equal(typeof create, 'function');
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  target.value.resume = epoch => { trace.push(`host-b:resume:${epoch.epoch}`); throw new Error('offline'); };
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  const result = await handoff.transfer(target.value);
  assert.equal(result.ok, false);
  assert.deepEqual(handoff.status(), { state: 'active', hostId: 'host-a', epoch: 3 });
  assert.equal(source.command(handoff.authority()), true);
  assert.deepEqual(trace, ['host-a:pause:1', 'host-b:stage:2', 'host-a:stop:1',
    'host-b:resume:2', 'host-b:abort:2', 'host-a:stage:3', 'host-a:resume:3']);
});

test('cancellation during source retirement waits for its acknowledgement before rollback', async () => {
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  let entered!: () => void, release!: () => void;
  const stopping = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const originalStop = source.value.stop.bind(source.value);
  source.value.stop = async epoch => { entered(); await blocked; originalStop(epoch); };
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  const transfer = handoff.transfer(target.value);
  await stopping;
  assert.equal(handoff.cancel(), true);
  assert.equal(handoff.status().state, 'transferring');
  release();
  assert.deepEqual(await transfer, { ok: false, reason: 'cancelled', recovered: true });
  assert.deepEqual(handoff.status(), { state: 'active', hostId: 'host-a', epoch: 3 });
  assert.equal(source.command(handoff.authority()), true);
});

test('cancellation during target resume fences it and waits before restoring source', async () => {
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  let entered!: () => void, release!: () => void;
  const resuming = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  target.value.resume = async epoch => { entered(); await blocked;
    assert.equal(epoch.isCurrent(), false); };
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  const transfer = handoff.transfer(target.value);
  await resuming;
  assert.equal(handoff.cancel(), true);
  assert.equal(handoff.status().state, 'transferring');
  release();
  assert.deepEqual(await transfer, { ok: false, reason: 'cancelled', recovered: true });
  assert.equal(target.running(), false);
  assert.equal(source.command(handoff.authority()), true);
});

test('invalid transferred state never reaches target staging and leaves no authority', async () => {
  const trace: string[] = [];
  const source = host('host-a', trace, { count: -1 }), target = host('host-b', trace);
  const handoff = create!({ workload, context, source: source.value,
    validateState: (state: JsonValue) => typeof state === 'object' && state !== null && !Array.isArray(state) &&
      typeof state.count === 'number' && state.count >= 0 });
  const result = await handoff.transfer(target.value);
  assert.deepEqual(result, { ok: false, reason: 'recovery-failed', recovered: false });
  assert.equal(handoff.status().state, 'paused');
  assert.equal(trace.some(item => item.startsWith('host-b:stage')), false);
  assert.equal(source.command(handoff.authority()), false);
});

test('invalid target is rejected before revoking the active source epoch', async () => {
  const trace: string[] = [];
  const source = host('host-a', trace, { count: 1 }), target = host('host-b', trace);
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  const initial = handoff.authority();
  assert.deepEqual(await handoff.transfer({ ...target.value, assets: undefined }),
    { ok: false, reason: 'invalid-target', recovered: true });
  assert.equal(initial.isCurrent(), true);
  assert.deepEqual(trace, []);
});

test('missing target asset bytes reject transfer and restore source from its verified snapshot', async () => {
  const trace: string[] = [];
  const bytes = new TextEncoder().encode('{"calibration":1}');
  const asset = await createAssetReference('example:calibration', 'text', bytes);
  const withAsset = { ...workload, assets: [asset] };
  const source = host('host-a', trace, { count: 2 }), target = host('host-b', trace);
  source.value = { ...source.value, assets: [{ reference: asset, bytes }] };
  const handoff = create!({ workload: withAsset, context, source: source.value,
    validateState: (state: JsonValue) => typeof state === 'object' && state !== null && !Array.isArray(state) &&
      state.count === 2 });
  assert.deepEqual(await handoff.transfer(target.value),
    { ok: false, reason: 'invalid-snapshot', recovered: true });
  assert.deepEqual(handoff.status(), { state: 'active', hostId: 'host-a', epoch: 3 });
  assert.equal(source.command(handoff.authority()), true);
  assert.equal(trace.some(item => item.startsWith('host-b:stage')), false);
});

test('two embedded hosts cancel queued source commands and admit only the new epoch', async () => {
  const output: string[] = [];
  const commandSource = { ...sensor, capabilities: [{ id: 'state', semantic: 'example:relay-state', schemaVersion: 1,
    kind: 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 },
    permissions: ['subscribe'] }] };
  const commandSink = { ...commandSource, id: 'relay', capabilities: [{ ...commandSource.capabilities[0],
    id: 'set-state', kind: 'command', permissions: ['invoke'], ownership: { mode: 'exclusive' } }] };
  function embeddedHost(id: string) {
    const local = runtime.createDeviceRuntime({ now: () => 0,
      authorize: () => ({ expiresAt: 10000, maxAgeMs: 500, maxHz: 10 }) });
    const from = local.registerSource({ device: commandSource, capability: 'state' });
    let token: runtime.HandoffEpoch | undefined;
    const to = local.registerSink({ device: commandSink, capability: 'set-state',
      apply(_observation, context) { if (context.isCurrent() && token?.isCurrent()) output.push(id); },
      release() {} });
    local.setReadiness(from, 'available'); local.setReadiness(to, 'available');
    let connection: runtime.Connection | undefined;
    let state: JsonValue = { count: 2 };
    const value: runtime.HandoffHost = { id, assets: [],
      pause() { connection?.stop('handoff-pause'); return state; },
      stage(next) { state = next; },
      resume(epoch) { token = epoch; connection = local.route({ from, to, principalId: 'owner',
        applicationId: 'example:handoff', sessionId: 'local' }); assert.equal(connection.start().ok, true); },
      stop() { connection?.stop('handoff-stop'); },
      abort() { connection?.stop('handoff-abort'); },
    };
    return { value, local, from, connection: () => connection };
  }
  const source = embeddedHost('host-a'), target = embeddedHost('host-b');
  const handoff = create!({ workload, context, source: source.value, validateState: () => true });
  await source.value.resume(handoff.authority());
  const old = source.connection()!;
  assert.equal(source.local.publish(source.from, true, { operationId: '1', deadline: 500 }).ok, true);
  assert.equal(old.status().pending, 1);
  assert.equal((await handoff.transfer(target.value)).ok, true);
  assert.equal(old.operations()[0].state, 'cancelled');
  source.local.flush();
  assert.equal(source.local.publish(source.from, true, { operationId: '2', deadline: 500 }).ok, false);
  assert.equal(target.local.publish(target.from, true, { operationId: '1', deadline: 500 }).ok, true);
  target.local.flush();
  assert.deepEqual(output, ['host-b']);
  source.local.close(); target.local.close();
});
