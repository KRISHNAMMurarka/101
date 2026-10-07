#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), source = args.includes('--workspace-exports'), sdkIndex = args.indexOf('--sdk-root');
if (args.some((value, index) => value !== '--workspace-exports' && value !== '--sdk-root' && index !== sdkIndex + 1) || source === (sdkIndex !== -1) || sdkIndex !== -1 && !args[sdkIndex + 1]) {
  throw new Error('Choose --workspace-exports or --sdk-root ABS_INSTALLED_CONSUMER; source Node hub is always reported separately');
}
const sdkRoot = sdkIndex === -1 ? undefined : realpathSync(resolve(args[sdkIndex + 1]));
const installedParent = sdkRoot ? pathToFileURL(join(sdkRoot, 'directory-public-caller.mjs')).href : undefined;
const sdkNames = new Set(['device-model', 'device-runtime', 'device-web', 'connect', 'transport-webrtc', 'transport-websocket', 'vision']);
const sourceNames = new Set(['hub-server', 'pairing', 'protocol', 'input']);
const resolved = new Map();
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
  const name = specifier.slice(5);
  if (!sdkNames.has(name) && !sourceNames.has(name)) throw new Error(`Unexpected public package outside declared proof closure: ${specifier}`);
  let entry;
  if (sourceNames.has(name) || source) entry = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
  else {
    // Ask the native ESM resolver for the actual public import condition, from the installed consumer.
    const resolvedImport = nextResolve(specifier, { ...context, parentURL: installedParent });
    const path = realpathSync(fileURLToPath(resolvedImport.url));
    if (!path.startsWith(join(sdkRoot, 'node_modules', '@101', name) + '/')) throw new Error('SDK package did not resolve to the exact installed consumer');
    entry = pathToFileURL(path).href;
  }
  resolved.set(specifier, entry); return nextResolve(entry, context);
} });
const paths = ['packages/hub-server/src/private-directory.ts', 'packages/hub-server/src/private-directory.test.ts',
  'packages/device-model/src/private-directory.ts', 'packages/device-model/src/private-directory.test.ts',
  'examples/coordinator/private-directory.ts', 'tools/qa-private-directory.mjs',
  'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/https-coordinator.test.ts'];
const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const before = hashes(), fixture = createCoordinatorFixtures();
const callers = [], checks = [];
const check = (condition, name) => { assert.equal(condition, true, name); checks.push(name); };
let coordinator;
const interrupt = () => { for (const caller of callers) caller.close(); void Promise.resolve(coordinator?.stop()).finally(() => { fixture.close(); hooks.deregister(); process.exit(130); }); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  const sdk = await import('@101/connect'), hub = await import('@101/hub-server'), pairing = await import('@101/pairing');
  check(typeof sdk.parsePrivateDirectorySnapshot === 'function' && typeof sdk.privateDirectoryCandidates === 'function' && typeof hub.createPrivateDirectoryClient === 'function', 'real-public-hooks-present');
  const { runPrivateDirectoryExample } = await import('../examples/coordinator/private-directory.ts');
  const origin = 'https://directory-client.example';
  const config = { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
    clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 };
  const example = await runPrivateDirectoryExample({ coordinator: config, origin, host: fixture.clients[0], peer: fixture.clients[2] });
  check(example.directoryRows === 1 && example.joinGrantedRows === 0 && example.hintState === 'unverified' && !example.metadataGrantedResourceRoute &&
    example.localApprovedObservations === 1 && example.resourceRevokeFencedLateAndQueued && example.excludedPrivateMetadata, 'actual-public-directory-and-independent-sdk-route-first-caller');
  const resources = [0, 1].map(index => ({ principalId: fixture.clients[index].principalId, deviceId: fixture.clients[index].deviceId,
    descriptor: sdk.parseDeviceDescriptor({ ...sdk.pointerSourceDescriptor('node'), id: `reviewed-owner-${index}`, label: `Reviewed owner ${index}`,
      metadata: { private: 'excluded' } }), capabilityIds: ['position'] }));
  coordinator = hub.createHttpsCoordinator({ ...config, directoryResources: resources });
  const endpoint = await coordinator.start();
  const credential = index => ({ endpoint, origin, caCertificatePem: fixture.ca, certificatePem: fixture.clients[index].certificatePem, privateKeyPem: fixture.clients[index].privateKeyPem });
  const host = hub.createCoordinatorFetcher(credential(0)), peer = hub.createCoordinatorFetcher(credential(2)), otherHost = hub.createCoordinatorFetcher(credential(1));
  callers.push(host, peer, otherHost);
  const session = await pairing.createHttpSignalingSession(endpoint, 'DIRECTORY-QA101', { fetcher: host.fetch });
  const otherSession = await pairing.createHttpSignalingSession(endpoint, 'DIRECTORY-QA202', { fetcher: otherHost.fetch });
  const peerSignaling = new pairing.HttpControllerSignalingClient(session.ticket, peer.fetch);
  const lease = await peerSignaling.join({ deviceId: fixture.clients[2].deviceId, label: 'host-a display claim', capabilities: { touch: true } });
  const eventChannel = channel('http.client.request.start'); let requests = 0;
  const observed = () => { requests++; }; eventChannel.subscribe(observed);
  let hostDirectory, reader;
  try {
    hostDirectory = hub.createPrivateDirectoryClient({ ...credential(0), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken });
    reader = hub.createPrivateDirectoryClient({ ...credential(2), sessionId: session.ticket.sessionId, role: 'peer', token: lease.peerToken, peerId: lease.peerId });
    callers.push(hostDirectory, reader);
    await new Promise(resolve => setImmediate(resolve)); check(requests === 0, 'constructing-native-directory-callers-dispatches-no-request');
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(() => reader.list(aborted.signal));
    check(requests === 0, 'already-aborted-list-dispatches-no-request');
    check((await reader.list()).resources.length === 0 && requests > 0, 'actual-authenticated-member-needs-explicit-visibility');
    const expiry = Date.now() + 5000;
    await hostDirectory.enroll(resources[0].descriptor.id, expiry);
    await assert.rejects(() => hostDirectory.enroll(resources[1].descriptor.id, expiry));
    await hostDirectory.allow(lease.peerId, [resources[0].descriptor.id], expiry);
    const snapshot = sdk.parsePrivateDirectorySnapshot(await reader.list());
    check(snapshot.resources.length === 1 && snapshot.scope.id === session.ticket.sessionId && !JSON.stringify(snapshot).includes('excluded') &&
      !JSON.stringify(snapshot).includes(session.hostToken) && !JSON.stringify(snapshot).includes(lease.peerToken), 'closed-projection-excludes-unselected-private-data-and-bearers');
    const wrongOwner = hub.createPrivateDirectoryClient({ ...credential(1), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken });
    const wrongSession = hub.createPrivateDirectoryClient({ ...credential(2), sessionId: otherSession.ticket.sessionId, role: 'peer', token: lease.peerToken, peerId: lease.peerId });
    callers.push(wrongOwner, wrongSession);
    await assert.rejects(() => wrongOwner.list()); await assert.rejects(() => wrongSession.list());
    check(true, 'copied-owner-and-cross-session-bearers-rejected-over-real-tls');
    const reconnect = await peerSignaling.requestReconnect(lease);
    check((await reader.list()).resources.length === 0, 'real-reconnect-generation-retires-visibility');
    await hostDirectory.allow(lease.peerId, [resources[0].descriptor.id], expiry);
    await hostDirectory.remove(resources[0].descriptor.id);
    await hostDirectory.enroll(resources[0].descriptor.id, expiry);
    check((await reader.list()).resources.length === 0, 'remove-reenroll-never-restores-member-visibility');
    await hostDirectory.allow(lease.peerId, [resources[0].descriptor.id], Date.now() + 150);
    await new Promise(resolve => setTimeout(resolve, 180));
    check((await reader.list()).resources.length === 0, 'actual-wall-clock-visibility-expiry');
    await hostDirectory.allow(lease.peerId, [resources[0].descriptor.id], expiry);
    await hostDirectory.revoke(lease.peerId);
    check((await reader.list()).resources.length === 0, 'explicit-host-revoke-removes-metadata');
    await peerSignaling.leave(reconnect); await assert.rejects(() => reader.list());
    check(true, 'current-membership-is-required-after-real-leave');
  } finally { eventChannel.unsubscribe(observed); }
  await coordinator.stop(); await assert.rejects(() => coordinator.start());
  check(true, 'owned-shutdown-destroys-ephemeral-authority');
  assert.deepEqual(hashes(), before);
  console.log(JSON.stringify({ result: 'pass', profile: sdk.PRIVATE_DIRECTORY_PROFILE, node: process.version,
    sdkProof: source ? 'source-bound-worker-public-barrels-only' : 'actual-installed-sdk-model-and-runtime',
    hubProof: 'source-bound-worker-node-hub-server-and-native-mtls', resolvedPublicEntries: Object.fromEntries(resolved),
    implementationSha256: before, checks, limits: sdk.PRIVATE_DIRECTORY_LIMITS, example,
    excluded: ['persistent/account-directory', 'browser-client-certificate-provisioning', 'enrollment/key-lifecycle', 'live-capability-probes', 'unmanaged/native-data', 'physical-effects', 'phones', 'multiple-physical-networks', 'published-hub-package'] }, null, 2));
} finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); for (const caller of callers) caller.close(); if (coordinator) await coordinator.stop(); fixture.close(); hooks.deregister(); }
