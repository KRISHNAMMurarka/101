import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from './index.ts';
import { createAssetReference, DeviceValidationError } from '@101/device-model';
import type { JsonValue } from '@101/device-model';

const capture = (runtime as Record<string, unknown>).createApplicationSnapshot as
  ((workload: unknown, context: unknown, state: unknown) => runtime.ApplicationSnapshot) | undefined;
const restore = (runtime as Record<string, unknown>).restoreApplicationSnapshot as
  ((workload: unknown, context: unknown, snapshot: unknown, assets: unknown,
    validateState: (state: JsonValue) => boolean) => Promise<runtime.SnapshotRestoreResult>) | undefined;
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const context = { devices: [sensor], processors: [] };
const bytes = new TextEncoder().encode('{"calibration":1}');
const base = { schemaVersion: 1, id: 'example:temperature-tracker', version: '1.0.0',
  application: { codeSha256: 'a'.repeat(64), runtime: { platform: 'node', minimumVersion: '24.0.0' },
    budget: { maxComputeMs: 5, maxMemoryBytes: 65536 } },
  processors: [], assets: [], resources: [
    { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe', required: true }],
  privacy: { mode: 'local-only', purpose: null, destinations: [], retention: 'none' },
  budget: { maxComputeMs: 5, maxMemoryBytes: 65536 },
  restart: { mode: 'snapshot', formatVersion: 2, applicationCodeSha256: 'a'.repeat(64),
    processorState: 'reset-on-resume', onIncompatible: 'cold-restart' } };

function referenceApp() {
  let count = 0, lastTemperature: number | null = null;
  return {
    record(temperature: number) { count++; lastTemperature = temperature; },
    serialize() { return { count, lastTemperature }; },
    validate(state: JsonValue): boolean {
      return state !== null && typeof state === 'object' && !Array.isArray(state) &&
        Object.keys(state).sort().join(',') === 'count,lastTemperature' &&
        typeof state.count === 'number' && Number.isSafeInteger(state.count) && state.count >= 0 &&
        (state.lastTemperature === null || typeof state.lastTemperature === 'number' &&
          Number.isFinite(state.lastTemperature) && state.lastTemperature >= -40 && state.lastTemperature <= 125);
    },
    resume(state: JsonValue) {
      if (!this.validate(state)) throw new TypeError('Invalid application state');
      const value = state as { count: number; lastTemperature: number | null };
      count = value.count; lastTemperature = value.lastTemperature;
    },
  };
}

test('reference application captures and resumes versioned state with verified asset bytes', async () => {
  assert.equal(typeof capture, 'function'); assert.equal(typeof restore, 'function');
  const asset = await createAssetReference('example:calibration', 'text', bytes);
  const workload = { ...base, assets: [asset] };
  const app = referenceApp(); app.record(29); app.record(31);
  const snapshot = capture!(workload, context, app.serialize());
  assert.equal(snapshot.formatVersion, 2);
  assert.equal(Object.isFrozen(snapshot.state), true);
  const resumed = await restore!(workload, context, snapshot, [{ reference: asset, bytes }], state => app.validate(state));
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error('Expected resume');
  const next = referenceApp(); next.resume(resumed.state); next.record(30);
  assert.deepEqual(next.serialize(), { count: 3, lastTemperature: 30 });
  assert.deepEqual(app.serialize(), { count: 2, lastTemperature: 31 });
});

test('incompatible snapshot identity and format choose explicit cold restart', async () => {
  assert.equal(typeof capture, 'function'); assert.equal(typeof restore, 'function');
  const snapshot = capture!(base, context, { count: 1, lastTemperature: 25 });
  const app = referenceApp();
  for (const changed of [
    { ...snapshot, formatVersion: 3 },
    { ...snapshot, application: { ...snapshot.application, codeSha256: 'b'.repeat(64) } },
    { ...snapshot, application: { ...snapshot.application, version: '2.0.0' } },
  ]) assert.deepEqual(await restore!(base, context, changed, [], state => app.validate(state)),
    { ok: false, reason: 'incompatible-snapshot', alternative: 'cold-restart' });
  assert.deepEqual(app.serialize(), { count: 0, lastTemperature: null });
});

test('absent or changed required asset bytes block resume and name asset recovery', async () => {
  assert.equal(typeof capture, 'function'); assert.equal(typeof restore, 'function');
  const asset = await createAssetReference('example:calibration', 'text', bytes);
  const workload = { ...base, assets: [asset] };
  const snapshot = capture!(workload, context, { count: 1, lastTemperature: 25 });
  const app = referenceApp();
  for (const assets of [[], [{ reference: asset, bytes: new TextEncoder().encode('changed') }]])
    assert.deepEqual(await restore!(workload, context, snapshot, assets, state => app.validate(state)),
      { ok: false, reason: 'missing-assets', alternative: 'install-assets-then-cold-restart' });
  assert.deepEqual(app.serialize(), { count: 0, lastTemperature: null });
});

test('invalid state and unsafe input fail before application mutation', async () => {
  assert.equal(typeof capture, 'function'); assert.equal(typeof restore, 'function');
  const app = referenceApp();
  const snapshot = capture!(base, context, { count: 1, lastTemperature: 25 });
  assert.deepEqual(await restore!(base, context, { ...snapshot, state: { count: -1, lastTemperature: 25 } }, [],
    state => app.validate(state)), { ok: false, reason: 'invalid-state', alternative: 'cold-restart' });
  let reads = 0;
  const malicious = Object.defineProperty({ ...snapshot }, 'state', { enumerable: true,
    get() { reads++; return app.serialize(); } });
  assert.deepEqual(await restore!(base, context, malicious, [], state => app.validate(state)),
    { ok: false, reason: 'incompatible-snapshot', alternative: 'cold-restart' });
  assert.equal(reads, 0);
  assert.throws(() => capture!(base, context, { data: 'x'.repeat(70000) }), DeviceValidationError);
  assert.deepEqual(app.serialize(), { count: 0, lastTemperature: null });
});

test('cold-only manifest cannot capture and requests cold restart on resume', async () => {
  assert.equal(typeof capture, 'function'); assert.equal(typeof restore, 'function');
  const snapshot = capture!(base, context, { count: 1, lastTemperature: 25 });
  const cold = { ...base, restart: { mode: 'cold' } };
  assert.throws(() => capture!(cold, context, { count: 1, lastTemperature: 25 }), DeviceValidationError);
  assert.deepEqual(await restore!(cold, context, snapshot, [], () => true),
    { ok: false, reason: 'snapshot-disabled', alternative: 'cold-restart' });
});
