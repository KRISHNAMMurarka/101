import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceValidationError } from './descriptor.ts';
import { assessDeviceHealth, parseDeviceHealthReport } from './health.ts';

const report = { schemaVersion: 1, deviceId: 'demo-thermometer', observed: { clockId: 'embedded-demo', at: 100 },
  maxAgeMs: 1000, battery: { levelPercent: 0, charging: false }, thermal: 'nominal',
  firmware: { version: '1.2.3' }, connectivity: 'not-applicable', faults: [],
  resources: [{ capabilityId: 'temperature', state: 'available', maxHz: 10, maxActiveRoutes: 1 }] } as const;
const now = { clockId: 'embedded-demo', at: 1100 } as const;

test('health reports are closed immutable provider data with exact resource limits', () => {
  const parsed = parseDeviceHealthReport(report);
  assert.deepEqual(parsed, report);
  assert.equal(Object.isFrozen(parsed.resources[0]), true);
  assert.equal(Object.isFrozen(parsed.battery), true);
  assert.deepEqual(assessDeviceHealth(parsed, report.deviceId, 'temperature', now),
    { readiness: 'available', limits: { maxHz: 10, maxActiveRoutes: 1 } });
  // An empty battery or an unverified firmware string does not synthesize loss.
  assert.equal(assessDeviceHealth(report, report.deviceId, 'temperature', now).readiness, 'available');
  assert.throws(() => parseDeviceHealthReport({ ...report, working: true }));
  assert.throws(() => parseDeviceHealthReport({ ...report, resources: [...report.resources, report.resources[0]] }));
  assert.throws(() => parseDeviceHealthReport({ ...report, resources: [{ ...report.resources[0], maxHz: 0 }] }));
  assert.throws(() => parseDeviceHealthReport({ ...report, battery: { levelPercent: 101, charging: false } }));
  assert.throws(() => parseDeviceHealthReport({ ...report, faults: [{ code: 'hardware:fan', severity: 'warning' },
    { code: 'hardware:fan', severity: 'blocking' }] }));
});

test('freshness, identity, connectivity, thermal and faults fail closed', () => {
  assert.deepEqual(assessDeviceHealth(report, report.deviceId, 'temperature', { ...now, at: 1100.001 }),
    { readiness: 'stale', reason: 'stale' });
  assert.deepEqual(assessDeviceHealth(report, 'other-device', 'temperature', now),
    { readiness: 'unavailable', reason: 'device' });
  assert.deepEqual(assessDeviceHealth(report, report.deviceId, 'missing', now),
    { readiness: 'unavailable', reason: 'resource' });
  assert.deepEqual(assessDeviceHealth({ ...report, connectivity: 'offline' }, report.deviceId, 'temperature', now),
    { readiness: 'unavailable', reason: 'connectivity' });
  assert.deepEqual(assessDeviceHealth({ ...report, thermal: 'critical' }, report.deviceId, 'temperature', now),
    { readiness: 'unavailable', reason: 'thermal' });
  assert.deepEqual(assessDeviceHealth({ ...report, faults: [{ code: 'hardware:fan', severity: 'blocking' }] },
    report.deviceId, 'temperature', now), { readiness: 'unavailable', reason: 'fault' });
  assert.deepEqual(assessDeviceHealth({ ...report, resources: [{ ...report.resources[0], state: 'busy' }] },
    report.deviceId, 'temperature', now), { readiness: 'busy', reason: 'resource-state' });
  assert.throws(() => assessDeviceHealth(report, report.deviceId, 'temperature', { clockId: 'other-clock', at: 1100 }),
    (error: unknown) => error instanceof DeviceValidationError && error.code === 'unsupported-clock-comparison');
  assert.throws(() => assessDeviceHealth(report, report.deviceId, 'temperature', { ...now, at: 99 }));
});

test('ordinary report accessors reject without executing', () => {
  let reads = 0;
  const input = { ...report, get battery() { reads += 1; return report.battery; } };
  assert.throws(() => parseDeviceHealthReport(input), DeviceValidationError);
  assert.equal(reads, 0);
  const clock = { clockId: 'embedded-demo', get at() { reads += 1; return 1100; } };
  assert.throws(() => assessDeviceHealth(report, report.deviceId, 'temperature', clock), DeviceValidationError);
  assert.equal(reads, 0);
});
