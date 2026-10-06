#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
assert.deepEqual(process.argv.slice(2), ['--workspace-exports'], 'This proof uses actual public source barrels only');
assert.equal(process.version, 'v24.14.0', 'Pinned native Node producer toolchain');
const packages = new Set(['hub-server', 'device-model', 'device-runtime', 'device-web', 'connect', 'pairing', 'protocol', 'input',
  'transport-webrtc', 'transport-websocket', 'vision']);
const resolutions = {}, dependencies = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// This inert fixture helper was imported before hooks, and executes native certificate creation below.
dependencies.set('tools/qa-https-coordinator.mjs', sha(readFileSync(join(root, 'tools/qa-https-coordinator.mjs'))));
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
  const name = specifier.slice(5); assert.ok(packages.has(name), 'Selected public dependency closure only');
  const entry = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
  resolutions[specifier] = entry; return nextResolve(entry, context);
}, load(url, context, nextLoad) {
  if (url.startsWith(pathToFileURL(root + '/').href) && /\.(?:ts|mjs)$/.test(url)) {
    const path = fileURLToPath(url); dependencies.set(path.slice(root.length + 1), sha(readFileSync(path)));
  }
  return nextLoad(url, context);
} });
const owned = ['packages/hub-server/src/gateway-inventory.ts', 'packages/hub-server/src/gateway-inventory.test.ts',
  'examples/gateway-inventory/node-agent-gateway.mjs', 'examples/gateway-inventory/consumer.mjs', 'tools/qa-gateway-inventory.mjs'];
const pins = () => Object.fromEntries(owned.map(path => [path, sha(readFileSync(join(root, path)))]));
const before = pins(), fixture = createCoordinatorFixtures();
try {
  const fixturePath = realpathSync(fixture.directory);
  assert.equal(dirname(fixturePath), realpathSync(tmpdir()), 'Owned native temporary fixture parent');
  assert.ok(/^101-coordinator-tls-[A-Za-z0-9]+$/.test(basename(fixturePath)), 'Owned native TLS fixture only');
  const { runGatewayInventoryExample } = await import('../examples/gateway-inventory/consumer.mjs');
  const origin = 'https://owned-gateway-inventory.example';
  const result = await runGatewayInventoryExample({ origin, host: fixture.clients[0], peer: fixture.clients[2],
    coordinator: { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem,
      clientCaCertificatePem: fixture.ca, allowedOrigins: [origin], enrollments: fixture.clients.slice(0, 3).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 } });
  assert.deepEqual(pins(), before);
  for (const [path, digest] of dependencies) assert.equal(sha(readFileSync(join(root, path))), digest, 'Proof dependency bytes unchanged');
  assert.equal(JSON.stringify(result).includes('rssBytes'), false);
  for (const secret of [fixture.clients[0].privateKeyPem, fixture.clients[2].privateKeyPem, 'BEGIN CERTIFICATE']) assert.equal(JSON.stringify(result).includes(secret), false);
  fixture.close(); assert.equal(existsSync(fixture.directory), false, 'Owned TLS fixture files removed after native settlement');
  console.log(JSON.stringify({ ...result, sourceRoot: root, sourcePins: before, publicResolutions: resolutions,
    dependencyPins: Object.fromEntries([...dependencies].sort(([a], [b]) => a.localeCompare(b))),
    provenance: { mode: 'ordinary-public-source-exports', installedSDK: false, nativeTLS: true, nativeChild: true, sourceHashesFrozen: true, ownedTLSFixtureRemoved: true } }));
} finally { fixture.close(); hooks.deregister(); }
