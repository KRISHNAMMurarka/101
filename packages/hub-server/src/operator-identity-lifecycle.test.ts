import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinatorFixtures } from '../../../tools/qa-https-coordinator.mjs';
import { createCoordinatorFetcher } from './https-coordinator.ts';
import type { OperatorConfiguration } from './operator-configuration.ts';
import { Server, createServer } from 'node:net';

const api = await import('./operator-identity-lifecycle.ts').catch(() => undefined);
const fixture = createCoordinatorFixtures();
process.once('exit', () => fixture.close());
const origin = 'https://operator-identity.example';
function configuration(selected = fixture, omitted?: string): OperatorConfiguration {
  return { schemaVersion: 1, profile: 'operator-loopback-startup/1',
    identity: { serverCertificatePem: selected.server.certificatePem, serverPrivateKeyPem: selected.server.privateKeyPem,
      clientCaCertificatePem: selected.ca, enrollments: selected.clients.slice(0, 5).filter(value => value.principalId !== omitted)
        .map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
    origins: [origin], listener: { host: '127.0.0.1', port: 0 }, directory: { resources: [] },
    storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' },
    quotas: { profile: 'fixed-coordinator-directory/1' } };
}
function caller(endpoint: string, selected = fixture, index = 0) {
  return createCoordinatorFetcher({ endpoint, origin, caCertificatePem: selected.ca,
    certificatePem: selected.clients[index]!.certificatePem, privateKeyPem: selected.clients[index]!.privateKeyPem });
}

test('an invalid credential replacement preserves the actual running mTLS owner and its current session', async () => {
  assert.ok(api, 'Operator credentials need an explicit bounded replacement lifecycle');
  const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, started = await lifecycle.start(); assert.ok(started.ok);
  const current = caller(started.endpoint);
  try {
    const response = await current.fetch(started.endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ROTATION-SAFE' }) });
    assert.equal(response.status, 201); const session = await response.json();
    const valid = configuration(), invalid = { ...valid, identity: { ...valid.identity, serverPrivateKeyPem: 'invalid-key' } };
    const replacement = await lifecycle.rotate(invalid); assert.equal(replacement.ok, false);
    assert.equal(lifecycle.snapshot().endpoint, started.endpoint); assert.equal(lifecycle.snapshot().generation, 1);
    assert.equal((await current.fetch(started.endpoint + '/v1/sessions/ROTATION-SAFE/host/peers', { headers: { Authorization: `Bearer ${session.hostToken}` } })).status, 200);
    assert.equal(JSON.stringify(lifecycle.snapshot()).includes('PRIVATE KEY'), false);
  } finally { current.close(); await lifecycle.stop(); }
});

test('credential expiry during real incumbent teardown cannot publish a replacement as running', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, initial = await lifecycle.start(); assert.ok(initial.ok);
  const port = Number(new URL(initial.endpoint).port), originalClose = Server.prototype.close, originalNow = Date.now;
  let retired = false;
  Server.prototype.close = function (...args) {
    const address = this.address();
    if (address && typeof address === 'object' && address.port === port) {
      retired = true; Date.now = () => originalNow() + 2 * 24 * 60 * 60 * 1000;
    }
    return Reflect.apply(originalClose, this, args);
  };
  try {
    const result = await lifecycle.rotate(configuration(fixture, fixture.clients[1]!.principalId));
    assert.equal(retired, true, 'clock advance follows actual incumbent native close');
    assert.equal(result.ok, false, 'expired replacement must not be published');
    assert.equal(lifecycle.snapshot().endpoint, undefined); assert.equal(lifecycle.snapshot().phase, 'failed');
  } finally { Date.now = originalNow; Server.prototype.close = originalClose; await lifecycle.stop(); }
});

test('a new enrollment owner rejects removed native credentials, old bearers and a different tenant', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, first = await lifecycle.start(); assert.ok(first.ok);
  const old = caller(first.endpoint); let fresh: ReturnType<typeof caller> | undefined, removed: ReturnType<typeof caller> | undefined, other: ReturnType<typeof caller> | undefined;
  try {
    const created = await old.fetch(first.endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ROTATE-OWNER' }) });
    const previous = await created.json(); assert.equal(created.status, 201);
    const rotated = await lifecycle.rotate(configuration(fixture, fixture.clients[1]!.principalId)); assert.ok(rotated.ok);
    assert.equal(rotated.generation, 2); assert.notEqual(rotated.endpoint, first.endpoint);
    await assert.rejects(old.fetch(first.endpoint + '/v1/health'));
    fresh = caller(rotated.endpoint); removed = caller(rotated.endpoint, fixture, 1); other = caller(rotated.endpoint, fixture, 2);
    assert.equal((await removed.fetch(rotated.endpoint + '/v1/health')).status, 401);
    assert.equal((await fresh.fetch(rotated.endpoint + '/v1/sessions/ROTATE-OWNER/host/peers', { headers: { Authorization: `Bearer ${previous.hostToken}` } })).status, 404);
    const response = await fresh.fetch(rotated.endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ROTATE-OWNER' }) });
    const current = await response.json(); assert.equal(response.status, 201); assert.notEqual(current.hostToken, previous.hostToken);
    assert.equal((await other.fetch(rotated.endpoint + '/v1/sessions/ROTATE-OWNER/host/peers', { headers: { Authorization: `Bearer ${current.hostToken}` } })).status, 404);
    const status = JSON.stringify(lifecycle.snapshot()); for (const secret of [previous.hostToken, current.hostToken, 'PRIVATE KEY', 'BEGIN CERTIFICATE', fixture.clients[0]!.principalId]) assert.ok(!status.includes(secret));
    await lifecycle.stop(); await assert.rejects(fresh.fetch(rotated.endpoint + '/v1/health'));
    assert.equal((await lifecycle.rotate(configuration())).ok, false); assert.equal((await lifecycle.start()).ok, false);
    assert.equal(lifecycle.snapshot().pending, false); assert.equal(lifecycle.snapshot().timerArmed, false);
  } finally { old.close(); fresh?.close(); removed?.close(); other?.close(); await lifecycle.stop(); }
});

test('a real occupied candidate port preserves the running incumbent, and an explicit fresh retry succeeds', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, first = await lifecycle.start(); assert.ok(first.ok);
  const current = caller(first.endpoint), occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); assert.ok(address && typeof address === 'object');
  try {
    const config = configuration(), result = await lifecycle.rotate({ ...config, listener: { host: '127.0.0.1', port: address.port } });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.issue.code, 'startup-failed');
    assert.equal(lifecycle.snapshot().endpoint, first.endpoint); assert.equal((await current.fetch(first.endpoint + '/v1/health')).status, 200);
    assert.equal(lifecycle.snapshot().pending, false); assert.equal(lifecycle.snapshot().timerArmed, false);
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    const retried = await lifecycle.rotate({ ...config, listener: { host: '127.0.0.1', port: address.port } });
    assert.ok(retried.ok); assert.equal(Number(new URL(retried.endpoint).port), address.port);
  } finally { if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve())); current.close(); await lifecycle.stop(); }
});

test('stop and reentry during credential validation reserve preparation and cannot start a late native owner', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller; assert.ok((await lifecycle.start()).ok);
  const originalNow = Date.now, originalListen = Server.prototype.listen; let reentered = false, binds = 0;
  let stopping: Promise<void> | undefined, nested: Promise<import('./operator-identity-lifecycle.ts').OperatorIdentityResult> | undefined;
  Server.prototype.listen = function (...args) { binds++; return Reflect.apply(originalListen, this, args); };
  Date.now = () => {
    if (!reentered) { reentered = true; nested = lifecycle.rotate(configuration()); stopping = lifecycle.stop(); }
    return originalNow();
  };
  try {
    const result = await lifecycle.rotate(configuration()); assert.equal(result.ok, false); await stopping;
    const denied = await nested; assert.ok(denied && !denied.ok); assert.equal(denied.issue.code, 'busy');
    assert.equal(binds, 0); assert.equal(lifecycle.snapshot().phase, 'stopped'); assert.equal(lifecycle.snapshot().pending, false);
  } finally { Date.now = originalNow; Server.prototype.listen = originalListen; await lifecycle.stop(); }
});

test('stop at the actual replacement bind retains its reservation until both native owners settle', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller; assert.ok((await lifecycle.start()).ok);
  const originalListen = Server.prototype.listen; let stopping: Promise<void> | undefined, reserved = false, listeners = 0;
  Server.prototype.listen = function (...args) {
    const value = Reflect.apply(originalListen, this, args);
    this.once('listening', () => { listeners++; stopping = lifecycle.stop(); reserved = lifecycle.snapshot().pending; });
    return value;
  };
  try {
    const result = await lifecycle.rotate(configuration()); assert.equal(result.ok, false); await stopping;
    assert.equal(listeners, 1); assert.equal(reserved, true); assert.equal(lifecycle.snapshot().endpoint, undefined);
    assert.equal(lifecycle.snapshot().pending, false); assert.equal(lifecycle.snapshot().timerArmed, false);
  } finally { Server.prototype.listen = originalListen; await lifecycle.stop(); }
});

test('bounded invalid attempts and expired native credentials never retire a healthy incumbent', async () => {
  assert.ok(api); const prepared = api.prepareOperatorIdentityLifecycle(configuration()); assert.ok(prepared.ok);
  const lifecycle = prepared.controller, initial = await lifecycle.start(); assert.ok(initial.ok); const current = caller(initial.endpoint);
  try {
    const config = configuration();
    const expired = await lifecycle.rotate({ ...config, identity: { ...config.identity, serverCertificatePem: fixture.expiredServer.certificatePem, serverPrivateKeyPem: fixture.expiredServer.privateKeyPem } });
    assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.issue.startupIssue?.code, 'identity-invalid');
    for (let attempt = 2; attempt < api.OPERATOR_IDENTITY_LIFECYCLE_LIMITS.attempts; attempt++) assert.equal((await lifecycle.rotate({})).ok, false);
    const rejected = await lifecycle.rotate(configuration()); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.issue.code, 'capacity');
    assert.equal((await current.fetch(initial.endpoint + '/v1/health')).status, 200);
    assert.equal(lifecycle.snapshot().attempts, 16); assert.equal(lifecycle.snapshot().generation, 1);
  } finally { current.close(); await lifecycle.stop(); }
});
