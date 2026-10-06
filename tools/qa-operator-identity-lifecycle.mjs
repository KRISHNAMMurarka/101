import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { connect, Server } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

assert.deepEqual(process.argv.slice(2), ['--source']);
const root = resolve(import.meta.dirname, '..'), paths = ['packages/hub-server/src/operator-identity-lifecycle.ts',
  'packages/hub-server/src/operator-identity-lifecycle.test.ts', 'packages/hub-server/src/operator-configuration.ts',
  'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/private-directory.ts', 'packages/hub-server/src/index.ts',
  'packages/device-model/src/private-directory.ts', 'examples/coordinator/operator-identity-lifecycle.ts',
  'tools/qa-operator-identity-lifecycle.mjs', 'tools/qa-https-coordinator.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = Object.fromEntries(paths.map(path => [path, sha(readFileSync(resolve(root, path)))]));
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === '@101/hub-server' ? pathToFileURL(resolve(root, 'packages/hub-server/src/index.ts')).href : specifier, context);
} });
const first = createCoordinatorFixtures(), next = createCoordinatorFixtures();
function configuration(fixture, exclude) {
  return { schemaVersion: 1, profile: 'operator-loopback-startup/1', identity: {
    serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, enrollments: fixture.clients.slice(0, 5).filter(value => value.principalId !== exclude)
      .map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
    origins: ['https://operator-identity.example'], listener: { host: '127.0.0.1', port: 0 }, directory: { resources: [] },
    storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } };
}
try {
  const { runOperatorIdentityLifecycleExample } = await import('../examples/coordinator/operator-identity-lifecycle.ts');
  const proof = await runOperatorIdentityLifecycleExample({ initial: configuration(first), narrowed: configuration(first, first.clients[1].principalId),
    replacement: configuration(next), origin: 'https://operator-identity.example', initialClient: first.clients[0], removedClient: first.clients[1],
    otherClient: first.clients[2], replacementClient: next.clients[0] });
  const { prepareOperatorIdentityLifecycle, createCoordinatorFetcher } = await import('@101/hub-server');
  const prepared = prepareOperatorIdentityLifecycle(configuration(first)); assert.ok(prepared.ok);
  const timed = prepared.controller, started = await timed.start(); assert.ok(started.ok);
  const current = createCoordinatorFetcher({ endpoint: started.endpoint, origin: 'https://operator-identity.example', caCertificatePem: first.ca,
    certificatePem: first.clients[0].certificatePem, privateKeyPem: first.clients[0].privateKeyPem });
  const originalListen = Server.prototype.listen;
  let delayed, observation, delayedBindCount = 0;
  Server.prototype.listen = function (...args) {
    // Preserve native args/result while holding this owned issued startup until
    // after the real five-second deadline; no fake successful listener/event.
    delayed = setTimeout(() => { delayedBindCount++; Reflect.apply(originalListen, this, args); }, 5050); return this;
  };
  let startupDeadline;
  try {
    const begun = performance.now(), replacement = timed.rotate(configuration(first));
    const observed = new Promise(resolve => { observation = setTimeout(() => resolve(timed.snapshot()), 5015); });
    const interim = await observed, result = await replacement;
    assert.equal(interim.pending, true); assert.equal(interim.timerArmed, false); assert.equal(result.ok, false);
    assert.equal(result.issue.code, 'startup-timeout'); assert.equal(delayedBindCount, 1);
    assert.equal(timed.snapshot().pending, false); assert.equal(timed.snapshot().endpoint, started.endpoint);
    assert.equal((await current.fetch(started.endpoint + '/v1/health')).status, 200);
    startupDeadline = { requestedTeardownAtMs: 5000, actualDelayedNativeBind: 1, rawReservationRetained: interim.pending,
      result: result.issue.code, incumbentHealth: 200, elapsedMs: performance.now() - begun, timersAfter: timed.snapshot().timerArmed };
  } finally { Server.prototype.listen = originalListen; clearTimeout(observation); clearTimeout(delayed); current.close(); await timed.stop(); }
  for (const endpoint of proof.endpoints) await new Promise((resolve, reject) => {
    const url = new URL(endpoint), socket = connect({ host: '127.0.0.1', port: Number(url.port) });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Owned closure check timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Owned listener remained active')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Owned closure check unavailable')));
  });
  console.log(JSON.stringify({ result: 'pass', profile: 'operator-identity-replacement/1', node: process.version, sourceSha256,
    proof, startupDeadline, checks: ['actual four native mTLS startup owners', 'invalid credentials preserve incumbent and session', 'new enrollment rejects removed current-CA certificate',
      'replacement destroys old session bearers and listeners', 'copied current token cannot select another tenant', 'independent new CA/key identities work',
      'terminal revocation destroys native access', 'fresh recovery does not revive old authority', 'redacted snapshots contain no credentials/bearers', 'all four owned native listeners closed',
      'actual five-second startup deadline retains delayed-native reservation and healthy incumbent'],
    scope: 'Provisioned closed Node loopback mTLS startup replacement only; no OS key store, live hot migration, persistent identity/tenant recovery, remote/relay or production qualification.' }, null, 2));
} finally { first.close(); next.close(); hooks.deregister(); }
