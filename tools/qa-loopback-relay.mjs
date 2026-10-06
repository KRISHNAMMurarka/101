#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, realpathSync, lstatSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';
const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--sdk-root' && args[1] && !args[1].startsWith('--'));
const hash = input => createHash('sha256').update(input).digest('hex');
const owned = ['packages/hub-server/src/loopback-relay.ts', 'packages/hub-server/src/loopback-relay.test.ts', 'examples/coordinator/loopback-relay.ts', 'tools/qa-loopback-relay.mjs'];
const pins = Object.fromEntries([...owned, 'packages/hub-server/src/index.ts', 'packages/hub-server/package.json', 'tools/qa-https-coordinator.mjs', 'examples/device-pipelines/secure-websocket.ts'].map(path => [path, hash(readFileSync(join(root, path)))]));
const sdkNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
let external, manifestProof, hooks, fixture, directServer, directWss, directTimer;
const directSockets = new Set(), directPeers = [], ports = [];
const sourceNames = ['hub-server', 'pairing', 'protocol', 'input'];
const wsEntry = createRequire(import.meta.url).resolve('ws'), wsPackage = JSON.parse(readFileSync(join(dirname(wsEntry), 'package.json'), 'utf8'));
assert.equal(wsPackage.version, '8.21.0');
const ws = createRequire(import.meta.url)('ws'), sourceClosure = new Map();
function nativeInventory(directory, prefix = '') {
  const result = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, path = join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) Object.assign(result, nativeInventory(path, name + '/')); else { assert.ok(entry.isFile()); result[name] = hash(readFileSync(path)); }
    assert.ok(Object.keys(result).length <= 64);
  }
  return result;
}
const nativePins = nativeInventory(dirname(wsEntry));
try {
  let sdkEntries;
  if (args[0] === '--sdk-root') {
    const consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(receipt.status, 'pass');
    const bytes = readFileSync(receipt.manifest.path); assert.equal(hash(bytes), receipt.manifest.sha256);
    const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.equal(manifest.packages.length, 7);
    const sourceCount = Object.keys(manifest.source.sha256).length; assert.ok(sourceCount > 0 && sourceCount <= 256); assert.match(manifest.source.tree, /^[a-f0-9]{40}$/);
    assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
    for (const [path, pin] of Object.entries(manifest.source.sha256)) assert.equal(hash(readFileSync(join(root, path))), pin, path);
    let files = 0;
    for (const name of sdkNames) {
      const item = manifest.packages.find(item => item.name === '@101/' + name); assert.ok(item && item.files.length && item.files.length <= 1024);
      const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix); assert.equal(lstatSync(prefix).isSymbolicLink(), false);
      for (const row of item.files) { const path = resolve(prefix, row.path); assert.ok(path.startsWith(prefix + '/')); assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), row.sha256); files++; }
    }
    assert.equal(files, manifest.packages.reduce((sum, item) => sum + item.files.length, 0)); external = mkdtempSync(join(consumer, 'loopback-relay-public-caller-'));
    const resolver = join(external, 'resolve.mjs'); writeFileSync(resolver, 'export default {' + sdkNames.map(name => JSON.stringify('@101/' + name) + ':import.meta.resolve(' + JSON.stringify('@101/' + name) + ')').join(',') + '};\n');
    sdkEntries = (await import(pathToFileURL(resolver).href)).default;
    for (const name of sdkNames) assert.equal(sdkEntries['@101/' + name], pathToFileURL(join(consumer, 'node_modules/@101', name, 'dist/index.js')).href);
    manifestProof = { path: receipt.manifest.path, sha256: receipt.manifest.sha256, tree: manifest.source.tree, packages: 7, productionSourcePins: sourceCount, packedFiles: files, receipt: join(consumer, 'receipt.json') };
  } else sdkEntries = Object.fromEntries(sdkNames.map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href]));
  hooks = registerHooks({ resolve(specifier, context, next) {
    const selected = sdkEntries[specifier] ?? (sourceNames.some(name => specifier === '@101/' + name) ? pathToFileURL(join(root, 'packages', specifier.slice(5), 'src/index.ts')).href : specifier);
    const value = next(selected, context);
    if (value.url.startsWith('file:')) { const path = fileURLToPath(value.url); if (path.startsWith(root + '/') && /\.(ts|mjs)$/.test(path) && !path.includes('/node_modules/')) { assert.ok(sourceClosure.size < 256 || sourceClosure.has(path)); sourceClosure.set(path.slice(root.length + 1), hash(readFileSync(path))); } }
    return value;
  } });
  const sdk = await import('@101/connect'), hub = await import('@101/hub-server');
  const { runLoopbackRelayExample } = await import('../examples/coordinator/loopback-relay.ts');
  fixture = createCoordinatorFixtures(); const controller = new AbortController();
  const proof = await runLoopbackRelayExample({ selectedPath: 'authenticated-loopback-relay', serverCertificatePem: fixture.server.certificatePem,
    serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca, source: fixture.clients[0], receiver: fixture.clients[2], signal: controller.signal });
  assert.equal(proof.actualSoftwareEffects, 2); assert.equal(proof.resourceGrantsFromRelay, false); assert.equal(proof.endToEndPayloadProtection, false);
  assert.equal(proof.cleanup.pairs, 0); assert.equal(proof.cleanup.nativeConnections, 0); assert.equal(proof.cleanup.pendingRaw, 0); assert.equal(proof.selection.length, 6);
  // Actual direct encrypted SDK path for explicit comparison. This is a separately
  // pinned direct peer, never a health probe, auto-downgrade or gateway splice.
  const { createSecureWebSocketPeer } = await import('../examples/device-pipelines/secure-websocket.ts');
  const [sourceIdentity, sinkIdentity] = await Promise.all([sdk.createEphemeralWebIdentity(), sdk.createEphemeralWebIdentity()]);
  const epoch = 'a'.repeat(32), scope = { epoch, applicationId: 'direct-selected-example', sessionId: 'direct-selected', now: () => performance.now() };
  directServer = createServer({ cert: fixture.server.certificatePem, key: fixture.server.privateKeyPem, ca: fixture.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  directWss = new ws.WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  directServer.on('connection', socket => { directSockets.add(socket); socket.once('close', () => directSockets.delete(socket)); });
  directServer.on('upgrade', (request, socket, head) => {
    if (!request.socket.authorized || request.socket.getProtocol() !== 'TLSv1.3' || request.url !== '/direct' || request.headers.origin !== 'https://owned-direct.example' || request.headers['sec-websocket-protocol'] !== sdk.WSS_SUBPROTOCOL) { socket.destroy(); return; }
    directWss.handleUpgrade(request, socket, head, native => {
      const port = nativePort(native); const peer = createSecureWebSocketPeer({ ...scope, transport: { side: 'server', socket: port, endpoint, now: scope.now }, identity: sinkIdentity, role: 'receiver', expectedRemoteKeyId: sourceIdentity.keyId });
      directPeers.push(peer); void peer.start();
    });
  });
  function nativePort(native) {
    let raw = 0, closed = false, finish; const settled = new Promise(resolve => { finish = resolve; });
    const port = { get readyState() { return native.readyState; }, get protocol() { return native.protocol; }, get bufferedAmount() { return native.bufferedAmount; },
      get binaryType() { return native.binaryType; }, set binaryType(value) { native.binaryType = value; }, onopen: null, onclose: null, onerror: null, onmessage: null,
      send(data) { raw++; native.send(data, error => { raw--; if (error) port.onerror?.({}); complete(); }); }, close() { native.terminate(); }, native, settled, raw: () => raw };
    function complete() { if (!closed || raw) return; native.removeListener('open', open); native.removeListener('close', end); native.removeListener('error', error); native.removeListener('message', message); finish(); }
    const open = () => port.onopen?.({}), end = () => { closed = true; port.onclose?.({}); complete(); }, error = () => port.onerror?.({});
    const message = (data, binary) => port.onmessage?.({ data: binary ? data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer : data.toString() });
    native.binaryType = 'arraybuffer'; native.on('open', open); native.on('close', end); native.on('error', error); native.on('message', message); ports.push(port); return port;
  }
  const listening = once(directServer, 'listening'); directServer.listen(0, '127.0.0.1'); await listening;
  const endpoint = 'wss://127.0.0.1:' + directServer.address().port + '/direct';
  const sourcePeer = createSecureWebSocketPeer({ ...scope, transport: { side: 'client', endpoint, now: scope.now, createSocket: () => nativePort(new ws.WebSocket(endpoint, sdk.WSS_SUBPROTOCOL,
    { ca: fixture.ca, cert: fixture.clients[0].certificatePem, key: fixture.clients[0].privateKeyPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
      followRedirects: false, perMessageDeflate: false, headers: { Origin: 'https://owned-direct.example' } })) }, identity: sourceIdentity, role: 'source', expectedRemoteKeyId: sinkIdentity.keyId });
  directPeers.push(sourcePeer); await sourcePeer.start(); directTimer = setInterval(() => directPeers.forEach(peer => peer.tick()), 5);
  const began = performance.now(); while (directPeers.length !== 2 || !directPeers.every(peer => peer.peer.state === 'connected')) { assert.ok(performance.now() - began < 3000); await new Promise(resolve => setTimeout(resolve, 5)); }
  const directReceiver = directPeers.find(peer => peer !== sourcePeer); let received;
  const detach = directReceiver.peer.onData((_lane, data) => { received = data; }); assert.equal(sourcePeer.peer.send('reliable', 'direct state=7'), true);
  while (received === undefined) { assert.ok(performance.now() - began < 3500); await new Promise(resolve => setTimeout(resolve, 5)); } detach(); assert.equal(received, 'direct state=7');
  const directSelection = { selectedPath: 'direct-wss', plaintextGateway: false, profile: 'wss-data/1', epoch, transcriptDigest: sdk.authenticatedPeerScope(sourcePeer.peer).transcriptDigest };
  assert.match(directSelection.transcriptDigest, /^[0-9a-f]{64}$/); assert.notEqual(directSelection.transcriptDigest, proof.selection[0].transcriptDigest);
  clearInterval(directTimer); directTimer = undefined; directPeers.forEach(peer => peer.stop()); ports.forEach(port => port.close()); await Promise.all(ports.map(port => port.settled));
  await new Promise(resolve => directWss.close(resolve)); directWss = undefined; await new Promise(resolve => directServer.close(resolve)); directServer = undefined;
  assert.equal(directSockets.size, 0); assert.equal(ports.reduce((sum, port) => sum + port.raw(), 0), 0);
  const fixtureDirectory = fixture.directory; fixture.close(); fixture = undefined; assert.equal(existsSync(fixtureDirectory), false);
  const result = { schemaVersion: 1, result: 'pass', profile: hub.AUTHENTICATED_LOOPBACK_RELAY_PROFILE, sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: pins, publicResolution: manifestProof ? 'new-real-public-hub-source-barrel-with-byte-verified-ordinary-installed-seven-package-sdk' : 'task-owned-real-public-source-barrels',
    installedHubClaim: false, sourceResolverPackages: manifestProof ? sourceNames : [...sourceNames, ...sdkNames], resolvedSourceSha256: Object.fromEntries(sourceClosure), sdk: manifestProof,
    nativeLibrary: { version: wsPackage.version, sha256: nativePins, files: Object.keys(nativePins).length }, node: process.version, fixtureKeyDirectoryRemoved: true,
    proof, directSelection, directRawWritesSettled: true, ownedNativeContexts: 0, physicalQualification: false, InternetOrTurnQualification: false };
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of sourceClosure) assert.equal(hash(readFileSync(join(root, path))), pin); assert.deepEqual(nativeInventory(dirname(wsEntry)), nativePins);
  if (external) writeFileSync(join(external, 'receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  if (directTimer) clearInterval(directTimer); directPeers.forEach(peer => peer.stop()); ports.forEach(port => port.close()); for (const socket of directSockets) socket.destroy();
  await Promise.all(ports.map(port => port.settled)); if (directWss) await new Promise(resolve => directWss.close(resolve)); if (directServer) await new Promise(resolve => directServer.close(resolve));
  fixture?.close(); hooks?.deregister();
  if (external) rmSync(join(external, 'resolve.mjs'), { force: true }); // Keep exact redacted receipt; no package/user mutation.
}
