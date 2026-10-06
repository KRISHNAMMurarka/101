import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';
import { createCoordinatorFetcher } from './https-coordinator.ts';
import { createServer } from 'node:net';
import { pointerSourceDescriptor } from '@101/device-web';
import { X509Certificate } from 'node:crypto';
const api = await import('./operator-configuration.ts').catch(() => undefined);
const fixtures = createCoordinatorFixtures();
process.once('exit', () => fixtures.close());
const origin = 'https://operator-ui.example';
function configuration() {
  return { schemaVersion: 1 as const, profile: 'operator-loopback-startup/1' as const,
    identity: { serverCertificatePem: fixtures.server.certificatePem, serverPrivateKeyPem: fixtures.server.privateKeyPem,
      clientCaCertificatePem: fixtures.ca, enrollments: fixtures.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
    origins: [origin], listener: { host: '127.0.0.1' as const, port: 0 }, directory: { resources: [] },
    storage: { mode: 'ephemeral' as const, acknowledgeLossOnStop: true as const }, relay: { mode: 'disabled' as const },
    quotas: { profile: 'fixed-coordinator-directory/1' as const } };
}

test('actual provisioned TLS producer configuration starts the existing local coordinator without serialized credentials', async () => {
  assert.ok(api, 'actual coordinator requires an explicit operator startup boundary');
  const prepared = api.prepareOperatorStartup(configuration()); assert.ok(prepared.ok);
  const startup = prepared.controller; assert.equal(startup.snapshot().phase, 'prepared');
  assert.equal(startup.snapshot().endpoint, undefined); assert.equal(JSON.stringify(prepared).includes('PRIVATE KEY'), false);
  const started = await startup.start(); assert.ok(started.ok);
  const caller = createCoordinatorFetcher({ endpoint: started.endpoint, origin, caCertificatePem: fixtures.ca,
    certificatePem: fixtures.clients[0]!.certificatePem, privateKeyPem: fixtures.clients[0]!.privateKeyPem });
  try { assert.equal((await caller.fetch(started.endpoint + '/v1/health')).status, 200); }
  finally { caller.close(); await startup.stop(); }
  assert.equal(startup.snapshot().phase, 'stopped'); assert.equal((await startup.start()).ok, false);
});

test('missing sections, unsupported persistence/relay and claimed quota changes fail closed with fixed readable recovery', () => {
  assert.ok(api);
  for (const field of ['identity', 'origins', 'listener', 'directory', 'storage', 'relay', 'quotas'] as const) {
    const value: Record<string, unknown> = configuration(); delete value[field]; const result = api.prepareOperatorStartup(value);
    assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.issue.field, field); assert.ok(result.issue.recovery.length > 10); }
  }
  for (const change of [{ storage: { mode: 'filesystem', path: '/private/example-secret' } }, { relay: { mode: 'turn', credential: 'not-supported-secret' } },
    { quotas: { profile: 'fixed-coordinator-directory/1', requestsPerSecond: 1000000 } }]) {
    const result = api.prepareOperatorStartup({ ...configuration(), ...change }); assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('/private'), false);
  }
});

test('startup validation rejects accessor configuration without invoking it and preserves actual certificate checks', () => {
  assert.ok(api); let reads = 0; const config = configuration();
  Object.defineProperty(config.identity, 'serverPrivateKeyPem', { enumerable: true, get() { reads++; return fixtures.server.privateKeyPem; } });
  assert.equal(api.prepareOperatorStartup(config).ok, false); assert.equal(reads, 0);
  const wrong = configuration(); wrong.identity.serverCertificatePem = fixtures.wrongHost.certificatePem; wrong.identity.serverPrivateKeyPem = fixtures.wrongHost.privateKeyPem;
  const rejected = api.prepareOperatorStartup(wrong); assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.issue.code, 'identity-invalid');
});

test('exact origin/listener and actual closed directory ownership requirements are enforced before binding', () => {
  assert.ok(api);
  for (const origins of [[], ['*'], ['http://operator-ui.example'], [origin + '/path'], ['https://secret@operator-ui.example'], [origin, origin], Array(17).fill(origin)]) {
    const result = api.prepareOperatorStartup({ ...configuration(), origins }); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issue.code, 'origins-invalid');
  }
  for (const listener of [{ host: '0.0.0.0', port: 0 }, { host: '127.0.0.1', port: -1 }, { host: '127.0.0.1', port: 65536 }]) {
    const result = api.prepareOperatorStartup({ ...configuration(), listener }); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issue.code, 'listener-invalid');
  }
  const resource = { principalId: 'forged-owner', deviceId: fixtures.clients[0]!.deviceId, descriptor: pointerSourceDescriptor('node'), capabilityIds: ['position'] };
  const result = api.prepareOperatorStartup({ ...configuration(), directory: { resources: [resource] } }); assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issue.code, 'directory-invalid');
});

test('mutable input cannot change the prepared origin, enrollment or redacted effective requirements', async () => {
  assert.ok(api); const config = configuration(), prepared = api.prepareOperatorStartup(config); assert.ok(prepared.ok);
  config.origins[0] = 'https://changed.example'; config.identity.enrollments[0]!.principalId = 'changed-owner';
  const started = await prepared.controller.start(); assert.ok(started.ok);
  const options = { endpoint: started.endpoint, caCertificatePem: fixtures.ca, certificatePem: fixtures.clients[0]!.certificatePem, privateKeyPem: fixtures.clients[0]!.privateKeyPem };
  const original = createCoordinatorFetcher({ ...options, origin }), changed = createCoordinatorFetcher({ ...options, origin: config.origins[0]! });
  try { assert.equal((await original.fetch(started.endpoint + '/v1/health')).status, 200); assert.equal((await changed.fetch(started.endpoint + '/v1/health')).status, 403);
    const snapshot = prepared.controller.snapshot(); assert.equal(snapshot.requirements.enrollmentCount, 5); assert.equal(snapshot.requirements.originCount, 1);
    assert.equal(JSON.stringify(snapshot).includes('host-a'), false); assert.equal(JSON.stringify(snapshot).includes('PRIVATE KEY'), false);
    assert.throws(() => { (snapshot.requirements.quotas.coordinator as unknown as { sessions: number }).sessions = 1000000; });
  } finally { original.close(); changed.close(); await prepared.controller.stop(); }
});

test('an occupied owned port fails readably and recovery requires a fresh validated startup owner', async () => {
  assert.ok(api); const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  const config = configuration(); config.listener.port = address.port; const prepared = api.prepareOperatorStartup(config); assert.ok(prepared.ok);
  try { const failed = await prepared.controller.start(); assert.equal(failed.ok, false); if (!failed.ok) assert.equal(failed.issue.code, 'startup-unavailable');
    assert.equal(prepared.controller.snapshot().phase, 'failed'); assert.equal(prepared.controller.snapshot().endpoint, undefined);
    assert.deepEqual(await prepared.controller.start(), failed);
  } finally { await prepared.controller.stop(); await new Promise<void>(resolve => occupied.close(() => resolve())); }
  const replacement = api.prepareOperatorStartup(config); assert.ok(replacement.ok);
  try { assert.ok((await replacement.controller.start()).ok); } finally { await replacement.controller.stop(); }
});

test('stop before or during bind cannot publish a running endpoint or restart discarded authority', async () => {
  assert.ok(api);
  for (const mode of ['before', 'during'] as const) {
    const prepared: ReturnType<typeof api.prepareOperatorStartup> = api.prepareOperatorStartup(configuration()); assert.ok(prepared.ok);
    const pending: Promise<import('./operator-configuration.ts').OperatorStartupResult> | undefined = mode === 'during' ? prepared.controller.start() : undefined; const stopped = prepared.controller.stop();
    if (pending) assert.equal((await pending).ok, false); await stopped;
    assert.equal(prepared.controller.snapshot().phase, 'stopped'); assert.equal(prepared.controller.snapshot().endpoint, undefined);
    assert.equal((await prepared.controller.start()).ok, false);
  }
});

for (const mode of ['expired', 'invalid-clock'] as const) test(`prepared certificate validation cannot authorize startup after ${mode}`, async () => {
  assert.ok(api); const prepared = api.prepareOperatorStartup(configuration()); assert.ok(prepared.ok);
  const originalNow = Date.now, expiry = Date.parse(new X509Certificate(fixtures.server.certificatePem).validTo);
  try {
    Date.now = () => mode === 'expired' ? expiry + 1 : NaN;
    const started = await prepared.controller.start(); assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.issue.code, 'identity-invalid');
    assert.equal(prepared.controller.snapshot().endpoint, undefined);
  } finally { Date.now = originalNow; await prepared.controller.stop(); }
});

test('identity loss while actual bind is pending cannot publish a running endpoint', async () => {
  assert.ok(api); const prepared = api.prepareOperatorStartup(configuration()); assert.ok(prepared.ok);
  const originalNow = Date.now, expiry = Date.parse(new X509Certificate(fixtures.server.certificatePem).validTo);
  const pending = prepared.controller.start();
  try { Date.now = () => expiry + 1; const started = await pending; assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.issue.code, 'identity-invalid'); assert.equal(prepared.controller.snapshot().endpoint, undefined);
  } finally { Date.now = originalNow; await prepared.controller.stop(); }
});
