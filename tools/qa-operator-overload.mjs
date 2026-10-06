#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { channel } from 'node:diagnostics_channel';
import { Server } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

assert.deepEqual(process.argv.slice(2), ['--workspace-exports'], 'Use --workspace-exports; this is explicit public source/native producer evidence');
const root = fileURLToPath(new URL('../', import.meta.url));
const names = new Set(['hub-server', 'device-model', 'pairing', 'protocol', 'input', 'transport-webrtc']);
const resolved = new Map();
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
  const name = specifier.slice(5); assert.ok(names.has(name), 'Undeclared public dependency');
  const entry = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
  resolved.set(specifier, entry); return nextResolve(entry, context);
} });
const fixture = createCoordinatorFixtures();
let binds = 0, requests = 0, cancelOnRequest;
const ownedServers = new Set();
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) { binds++; ownedServers.add(this); return Reflect.apply(originalListen, this, args); };
const events = channel('http.client.request.start'), observe = () => { requests++; cancelOnRequest?.abort(); };
events.subscribe(observe);
try {
  const api = await import('../examples/coordinator/operator-overload.ts').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return undefined;
  });
  assert.equal(typeof api?.runOperatorOverloadDrill, 'function', 'A runnable operator overload drill needs the actual public first caller');
  const model = await import('@101/device-model'), hub = await import('@101/hub-server');
  // Principal/device enrollment is host configuration bound to the actual
  // fixture certificate fingerprint. Unique sentinels avoid matching public
  // case words such as "other" or "host-bearer" as an identity disclosure.
  const credentials = fixture.clients.slice(0, 5).map((credential, index) => ({ ...credential,
    principalId: 'owned-overload-identity-' + index, deviceId: 'owned-overload-device-' + index }));
  const resources = Array.from({ length: model.PRIVATE_DIRECTORY_LIMITS.resourcesPerSession + 2 }, (_, index) => {
    const owner = credentials[index > model.PRIVATE_DIRECTORY_LIMITS.resourcesPerSession ? 1 : 0];
    return { principalId: owner.principalId, deviceId: owner.deviceId, capabilityIds: ['status'],
      descriptor: model.parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-status-' + index, label: 'Owned status declaration ' + index,
        revision: 1, adapter: { id: 'example:operator-drill', version: '1' }, runtime: { platform: 'node' },
        capabilities: [{ id: 'status', semantic: 'example-operator:status', schemaVersion: 1, kind: 'sample',
          value: { type: 'scalar', unit: '1', min: 0, max: 1 }, delivery: { mode: 'latest', maxAgeMs: 1000, maxHz: 1 }, permissions: ['subscribe'] }],
        metadata: { privateOwnerNote: 'not-visible-secret' } }) };
  });
  const origin = 'https://operator-overload.example';
  const configuration = { schemaVersion: 1, profile: 'operator-loopback-startup/1',
    identity: { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
      clientCaCertificatePem: fixture.ca, enrollments: credentials.map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
    origins: [origin], listener: { host: '127.0.0.1', port: 0 }, directory: { resources },
    storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } };
  const prepared = hub.prepareOperatorStartup(configuration); assert.ok(prepared.ok); await prepared.controller.stop();
  assert.equal(binds, 0); assert.equal(requests, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => api.runOperatorOverloadDrill({ configuration, origin, credentials, signal: aborted.signal }));
  assert.equal(binds, 0); assert.equal(requests, 0);
  const cancellation = new AbortController(); cancelOnRequest = cancellation;
  await assert.rejects(() => api.runOperatorOverloadDrill({ configuration, origin, credentials, signal: cancellation.signal }));
  cancelOnRequest = undefined;
  assert.equal(cancellation.signal.aborted, true, 'cancel at an actual issued native HTTP request');
  assert.equal(binds, 1); assert.equal(requests, 1);
  assert.ok([...ownedServers].every(server => !server.listening && server.address() === null));
  const requestsBeforeDrill = requests;
  const started = performance.now();
  const report = await api.runOperatorOverloadDrill({ configuration, origin, credentials });
  assert.equal(report.profile, 'operator-loopback-overload-drill/1');
  assert.ok(report.elapsedMs >= 60_000 && report.elapsedMs < 85_000);
  assert.ok(performance.now() - started < 85_000);
  const required = ['relay-configuration-rejected', 'regions-configuration-rejected', 'principal-session-capacity-rejected',
    'other-principal-session-independent', 'global-session-capacity-rejected', 'copied-host-bearer-rejected',
    'session-peer-capacity-rejected', 'principal-peer-capacity-rejected', 'departure-retires-old-lease', 'fresh-peer-retry-admitted',
    'other-peer-principal-independent', 'directory-capacity-rejected', 'foreign-resource-rejected-before-capacity',
    'copied-directory-bearer-rejected', 'peer-has-no-implicit-visibility', 'explicit-metadata-visibility',
    'actual-directory-expiry-frees-capacity', 'reenrollment-does-not-restore-visibility', 'principal-rate-capacity-rejected',
    'other-principal-rate-independent', 'actual-next-window-explicit-retry', 'actual-session-expiry-retires-bearers-and-invitations',
    'actual-session-expiry-frees-principal-and-global-capacity'];
  assert.deepEqual(report.checks, required); assert.equal(report.nativeRequests, requests - requestsBeforeDrill);
  assert.deepEqual(report.cleanup, { callersClosed: 5, ownerPhase: 'stopped', operationTimers: 0, pendingRequests: 0 });
  assert.equal(report.resourceOperationsExercised, 0); assert.equal(report.syntheticPositiveResponses, false);
  assert.equal(binds, 2, 'one cancelled owned listener plus one complete drill listener');
  assert.ok([...ownedServers].every(server => !server.listening && server.address() === null));
  const text = JSON.stringify(report);
  for (const secret of [fixture.server.privateKeyPem, fixture.server.certificatePem, 'not-visible-secret', ...credentials.map(item => item.principalId)]) {
    assert.equal(text.includes(secret), false, 'Redacted operator report');
  }
  const paths = ['examples/coordinator/operator-overload.ts', 'tools/qa-operator-overload.mjs', 'packages/hub-server/src/operator-configuration.ts',
    'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/private-directory.ts', 'packages/device-model/src/private-directory.ts',
    'packages/hub-server/src/index.ts', 'packages/pairing/src/index.ts', 'packages/protocol/src/index.ts'];
  console.log(JSON.stringify({ result: 'pass', node: process.version, evidence: 'ordinary-public-source-imports-and-actual-owned-loopback-mTLS',
    resolvedPublicEntries: Object.fromEntries(resolved), implementationSha256: Object.fromEntries(paths.map(path => [path,
      createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])), noBindChecks: 2, nativeRequestCancellationChecks: 1,
    ownedListeners: binds, ownedListenersRemaining: 0, report,
    excluded: ['enabled-relay', 'regional-service', 'processor-overload', 'persistent-account-service', 'physical-devices', 'phones', 'UI', 'OS-clipboard', 'remote', 'installed-or-published-hub-package'] }, null, 2));
} finally { Server.prototype.listen = originalListen; events.unsubscribe(observe); fixture.close(); hooks.deregister(); }
