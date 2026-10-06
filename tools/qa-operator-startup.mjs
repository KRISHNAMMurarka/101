#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), featureRed = args.includes('--feature-red');
assert.deepEqual(args.filter(value => value !== '--feature-red'), ['--source']);
const owned = ['packages/hub-server/src/operator-configuration.ts', 'packages/hub-server/src/operator-configuration.test.ts',
  'examples/coordinator/operator-startup.ts', 'tools/qa-operator-startup.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hashes = Object.fromEntries([...owned, 'packages/hub-server/src/index.ts', 'packages/hub-server/src/https-coordinator.ts',
  'packages/hub-server/src/private-directory.ts', 'packages/device-model/src/private-directory.ts', 'tools/qa-https-coordinator.mjs'].map(path => [path, hash(readFileSync(join(root, path)))]));
const scratch = mkdtempSync(join(tmpdir(), '101-operator-startup-')), fixture = createCoordinatorFixtures();
let hubEntry = join(root, 'packages/hub-server/src/index.ts');
if (featureRed) {
  const prefix = 'packages/hub-server/src/', paths = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', prefix], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.ok(paths.length > 0 && paths.length <= 128);
  for (const path of paths) if (path.startsWith(prefix) && path.endsWith('.ts') && !path.endsWith('.test.ts')) {
    const output = join(scratch, 'old-source', path); mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, execFileSync('git', ['cat-file', 'blob', `${base}:${path}`], { cwd: root, maxBuffer: 1048576 }));
  }
  hubEntry = join(scratch, 'old-source', 'packages/hub-server/src/index.ts');
}
const names = ['hub-server', 'protocol', 'pairing', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision', 'connect'];
// Task-owned source resolver selects real public barrels; it never substitutes an
// API implementation and is not an installed/browser hub-server packaging claim.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (names.some(name => specifier === '@101/' + name)) {
    const name = specifier.slice(5), entry = name === 'hub-server' ? hubEntry : join(root, 'packages', name, 'src/index.ts');
    return nextResolve(pathToFileURL(entry).href, context);
  }
  return nextResolve(specifier, context);
} });
let controller, oldCoordinator;
const callers = [];
try {
  const hub = await import('@101/hub-server'), sdk = await import('@101/connect');
  const origin = 'https://operator-ui.example', host = fixture.clients[0], peer = fixture.clients[2];
  const resource = sdk.parseDeviceDescriptor({ ...sdk.pointerSourceDescriptor('node'), id: 'operator-local-resource', label: 'Provisioned local observation', metadata: { ownerPrivateNote: 'not-exported-catalog-secret' } });
  const identity = { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
    enrollments: fixture.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) };
  const configuration = { schemaVersion: 1, profile: 'operator-loopback-startup/1', identity, origins: [origin], listener: { host: '127.0.0.1', port: 0 },
    directory: { resources: [{ principalId: host.principalId, deviceId: host.deviceId, descriptor: resource, capabilityIds: ['position'] }] },
    storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } };
  if (featureRed) {
    oldCoordinator = hub.createHttpsCoordinator({ ...identity, allowedOrigins: [origin], directoryResources: configuration.directory.resources });
    const endpoint = await oldCoordinator.start(), caller = hub.createCoordinatorFetcher({ endpoint, origin, caCertificatePem: fixture.ca, certificatePem: host.certificatePem, privateKeyPem: host.privateKeyPem }); callers.push(caller);
    const health = await caller.fetch(endpoint + '/v1/health'); assert.equal(health.status, 200);
    console.error(JSON.stringify({ actualOldProducerTlsHealth: health.status, operatorStartupExport: typeof hub.prepareOperatorStartup }));
    assert.equal(typeof hub.prepareOperatorStartup, 'function', 'Actual local TLS producer needs the explicit closed operator startup boundary');
  }
  assert.equal(typeof hub.prepareOperatorStartup, 'function');
  const { runOperatorStartupExample } = await import('../examples/coordinator/operator-startup.ts');
  const proof = await runOperatorStartupExample({ configuration, origin, host, peer, resourceId: resource.id });
  assert.equal(proof.actualLocalTlsStartups, 2); assert.equal(proof.independentlyAuthorizedDirectoryRows, 1); assert.equal(proof.resourceGrantsFromConfiguration, false);
  const rejected = [];
  for (const [field, value] of [['storage', { mode: 'filesystem', path: '/private/credential-path' }], ['relay', { mode: 'turn', credential: 'never-serialize-credential' }],
    ['quotas', { profile: 'fixed-coordinator-directory/1', sessions: 1000000 }], ['origins', ['*']]]) {
    const result = hub.prepareOperatorStartup({ ...configuration, [field]: value }); assert.equal(result.ok, false); rejected.push(result.issue);
  }
  const accepted = hub.prepareOperatorStartup(configuration); assert.ok(accepted.ok); controller = accepted.controller;
  const status = controller.snapshot(); assert.equal(status.phase, 'prepared'); assert.equal(status.endpoint, undefined);
  for (const privateValue of [host.principalId, host.deviceId, resource.id, resource.label, 'not-exported-catalog-secret', '/private/credential-path', 'never-serialize-credential', 'PRIVATE KEY', 'CERTIFICATE']) {
    assert.equal(JSON.stringify({ status, rejected }).includes(privateValue), false, 'Closed status/recovery cannot expose credential/catalog input');
  }
  await controller.stop(); assert.equal((await controller.start()).ok, false);
  const receipt = { schemaVersion: 1, result: 'pass', profile: hub.OPERATOR_CONFIGURATION_PROFILE, sourceBase: base, sourceSha256: hashes,
    node: process.version, publicResolution: 'task-owned-real-source-barrels', proof, rejected, effectiveRequirements: status.requirements,
    credentialsRetainedInReceipt: false, scope: 'Selected local Node mTLS coordinator/directory startup only. Ephemeral state, relay disabled, fixed existing ceilings. No persistent backend, relay, account lifecycle, public deployment, browser client-certificate provisioning, phone or general O01 qualification.' };
  fixture.close(); const receiptPath = join(scratch, 'operator-startup-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2));
} finally {
  callers.forEach(value => value.close()); await controller?.stop(); await oldCoordinator?.stop(); fixture.close(); hooks.deregister();
  if (featureRed) rmSync(scratch, { recursive: true, force: true });
}
