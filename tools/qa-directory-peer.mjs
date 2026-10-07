#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), source = args.includes('--workspace-exports'), sdkIndex = args.indexOf('--sdk-root');
if (args.some((value, index) => value !== '--workspace-exports' && value !== '--sdk-root' && index !== sdkIndex + 1) ||
    source === (sdkIndex !== -1) || sdkIndex !== -1 && !args[sdkIndex + 1]) throw new Error('Choose --workspace-exports or --sdk-root ABS_INSTALLED_CONSUMER');
const sdkRoot = sdkIndex === -1 ? undefined : realpathSync(resolve(args[sdkIndex + 1]));
const installedParent = sdkRoot ? pathToFileURL(join(sdkRoot, 'peer-directory-public-caller.mjs')).href : undefined;
const sdkNames = new Set(['device-model', 'device-runtime', 'device-web', 'connect', 'transport-webrtc', 'transport-websocket', 'vision']);
const sourceNames = new Set(['hub-server', 'pairing', 'protocol', 'input']), resolved = new Map();
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
  const name = specifier.slice(5);
  if (!sdkNames.has(name) && !sourceNames.has(name)) throw new Error('Unexpected public package outside declared proof closure');
  let entry;
  if (source || sourceNames.has(name)) entry = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
  else {
    const imported = nextResolve(specifier, { ...context, parentURL: installedParent });
    const path = realpathSync(fileURLToPath(imported.url));
    if (!path.startsWith(join(sdkRoot, 'node_modules', '@101', name) + '/')) throw new Error('Public SDK import escaped installed consumer');
    entry = pathToFileURL(path).href;
  }
  resolved.set(specifier, entry); return nextResolve(entry, context);
} });
const paths = ['packages/device-model/src/private-directory.ts', 'packages/device-model/src/private-directory.test.ts',
  'packages/device-model/src/index.ts', 'packages/hub-server/src/private-directory.ts', 'packages/hub-server/src/private-directory-peer.test.ts',
  'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/index.ts', 'examples/coordinator/private-directory.ts',
  'tools/qa-directory-peer.mjs', 'tools/qa-https-coordinator.mjs'];
const hashes = () => Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const before = hashes(), checks = [], callers = [];
const check = (condition, name) => { assert.equal(condition, true, name); checks.push(name); };
let fixture, coordinator;
const interrupt = () => { for (const caller of callers) caller.close(); void Promise.resolve(coordinator?.stop()).finally(() => { fixture?.close(); hooks.deregister(); process.exit(130); }); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  const sdk = await import('@101/connect'), hub = await import('@101/hub-server'), pairing = await import('@101/pairing');
  check(typeof sdk.parsePrivateDirectoryPublication === 'function' && typeof hub.createPrivateDirectoryClient === 'function', 'real-public-publication-parser-and-native-client');
  fixture = createCoordinatorFixtures();
  const origin = 'https://directory-peer.example', config = { serverCertificatePem: fixture.server.certificatePem,
    serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca, allowedOrigins: [origin],
    enrollments: fixture.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 };
  const { runPrivateDirectoryExample } = await import('../examples/coordinator/private-directory.ts');
  const example = await runPrivateDirectoryExample({ coordinator: config, origin, host: fixture.clients[0], peer: fixture.clients[2] });
  check(example.directoryRows === 1 && example.joinGrantedRows === 0 && example.hintState === 'unverified' && !example.metadataGrantedResourceRoute &&
    example.localApprovedObservations === 1 && example.resourceRevokeFencedLateAndQueued && example.excludedPrivateMetadata,
  'public-peer-publication-and-separate-runtime-deny-approve-revoke-first-caller');
  coordinator = hub.createHttpsCoordinator(config);
  const endpoint = await coordinator.start();
  const credential = index => ({ endpoint, origin, caCertificatePem: fixture.ca, certificatePem: fixture.clients[index].certificatePem,
    privateKeyPem: fixture.clients[index].privateKeyPem });
  const transports = [0, 1, 2, 3, 4].map(index => hub.createCoordinatorFetcher(credential(index))); callers.push(...transports);
  const session = await pairing.createHttpSignalingSession(endpoint, 'PUBLIC-PEER-DIRECTORY101', { fetcher: transports[0].fetch });
  const other = await pairing.createHttpSignalingSession(endpoint, 'PUBLIC-PEER-DIRECTORY202', { fetcher: transports[1].fetch });
  const join = async index => {
    const signaling = new pairing.HttpControllerSignalingClient(session.ticket, transports[index].fetch);
    const lease = await signaling.join({ deviceId: fixture.clients[index].deviceId, label: 'Display claims confer no ownership', capabilities: { touch: true } });
    const directory = hub.createPrivateDirectoryClient({ ...credential(index), sessionId: session.ticket.sessionId, role: 'peer', peerId: lease.peerId, token: lease.peerToken });
    callers.push(directory); return { signaling, lease, directory };
  };
  const owner = await join(2), recipient = await join(3), denied = await join(4);
  const host = hub.createPrivateDirectoryClient({ ...credential(0), sessionId: session.ticket.sessionId, role: 'host', token: session.hostToken }); callers.push(host);
  const originalExpiry = Date.now() + 5000, deviceId = fixture.clients[2].deviceId;
  const publication = (revision = 1, expiresAt = originalExpiry, generation = owner.lease.generation) => sdk.parsePrivateDirectoryPublication({ generation,
    descriptor: sdk.parseDeviceDescriptor({ ...sdk.pointerSourceDescriptor('node'), id: deviceId, revision, metadata: { private: { a: { b: { c: { d: { e: { f: 'excluded-owner-detail' } } } } } } } }),
    capabilityIds: ['position'], expiresAt, consent: true });
  await owner.directory.publish(publication());
  check((await owner.directory.list()).resources.length === 0 && (await recipient.directory.list()).resources.length === 0 &&
    (await denied.directory.list()).resources.length === 0, 'joining-and-publication-do-not-grant-recipient-or-owner-visibility');
  const path = `/v1/sessions/${session.ticket.sessionId}/peers/${owner.lease.peerId}/directory/publication`;
  const send = (index, url, body) => transports[index].fetch(endpoint + url, { method: 'POST', headers: {
    Authorization: `Bearer ${owner.lease.peerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  check((await send(3, path, publication(2))).status === 404 && (await send(2, path.replace(session.ticket.sessionId, other.ticket.sessionId), publication(2))).status === 404 &&
    (await send(2, path, { ...publication(2), principalId: 'host-a' })).status === 404, 'real-mtls-rejects-copied-owner-cross-session-and-forged-identity');
  await host.allow(recipient.lease.peerId, [deviceId], originalExpiry);
  const visible = sdk.parsePrivateDirectorySnapshot(await recipient.directory.list());
  check(visible.resources.length === 1 && visible.resources[0].revision === 1 && visible.resources[0].capabilities.length === 1 &&
    visible.resources[0].capabilities[0].id === 'position' && !JSON.stringify(visible).includes('excluded-owner-detail') &&
    (await denied.directory.list()).resources.length === 0, 'host-grant-projects-only-selected-current-peer-metadata-to-one-recipient');
  await assert.rejects(() => owner.directory.update(publication(2, originalExpiry + 1)));
  await assert.rejects(() => owner.directory.update(publication(1)));
  await owner.directory.update(publication(2));
  check((await recipient.directory.list()).resources.length === 0, 'new-descriptor-revision-retires-prior-visibility-without-extending-original-expiry');
  await host.allow(recipient.lease.peerId, [deviceId], originalExpiry);
  await assert.rejects(() => owner.directory.unpublish(owner.lease.generation, 1));
  await owner.directory.unpublish(owner.lease.generation, 2);
  await assert.rejects(() => owner.directory.publish(publication(2)));
  await owner.directory.publish(publication(3));
  check((await recipient.directory.list()).resources.length === 0, 'revision-pinned-loss-removes-publication-and-replay-does-not-restore-visibility');
  await host.allow(recipient.lease.peerId, [deviceId], originalExpiry);
  const replacement = await owner.signaling.requestReconnect(owner.lease);
  await assert.rejects(() => owner.directory.publish(publication(4)));
  check((await recipient.directory.list()).resources.length === 0, 'real-owner-reconnect-retires-publication-and-old-generation');
  const shortExpiry = Date.now() + 250;
  await owner.directory.publish(publication(1, shortExpiry, replacement.generation));
  await host.allow(recipient.lease.peerId, [deviceId], originalExpiry);
  check((await recipient.directory.list()).resources[0].expiresAt === shortExpiry, 'recipient-grant-cannot-extend-original-publication-expiry');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, shortExpiry - Date.now() + 30)));
  check((await recipient.directory.list()).resources.length === 0, 'actual-wall-clock-publication-expiry-retires-visibility');
  await owner.directory.publish(publication(2, originalExpiry, replacement.generation));
  await host.allow(recipient.lease.peerId, [deviceId], originalExpiry);
  await owner.signaling.leave(replacement);
  await assert.rejects(() => owner.directory.publish(publication(3, originalExpiry, replacement.generation)));
  check((await recipient.directory.list()).resources.length === 0, 'real-owner-departure-removes-recipient-metadata');
  assert.deepEqual(hashes(), before);
  console.log(JSON.stringify({ result: 'pass', node: process.version, profile: sdk.PRIVATE_DIRECTORY_PROFILE,
    sdkProof: source ? 'source-bound-public-barrels' : 'actual-installed-sdk-model-runtime-and-web',
    hubProof: 'source-bound-native-node-mtls-coordinator', implementationSha256: before,
    resolvedPublicEntries: Object.fromEntries(resolved), checks, example, limits: sdk.PRIVATE_DIRECTORY_LIMITS,
    excluded: ['persistent-account-directory', 'physical-live-inventory-probes', 'device-browser-os-acquisition', 'enrollment-key-lifecycle',
      'published-hub-package', 'new-supported-source-profile'] }, null, 2));
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  for (const caller of callers) caller.close(); if (coordinator) await coordinator.stop(); fixture?.close(); hooks.deregister();
}
