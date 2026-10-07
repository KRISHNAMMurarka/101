import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/invitation-connection.ts', 'packages/device-web/src/invitation-connection.test.ts', 'packages/device-web/src/invitation-discovery.test.ts',
  'examples/device-pipelines/invitation-connection.ts', 'tools/qa-invitation-connection.mjs'];
const dependencies = ['packages/device-web/src/index.ts', 'packages/device-web/src/invitation.ts', 'packages/device-web/src/authenticated-peer.ts',
  'packages/device-web/src/binding.ts', 'packages/device-runtime/src/runtime.ts', 'packages/transport-websocket/src/peer.ts'];
const fingerprints = Object.fromEntries([...owned, ...dependencies].map(path => [path, hash(readFileSync(join(root, path)))]));
const baseline = process.argv.includes('--unsafe-baseline');
const nodeOnly = process.argv.includes('--node-only');
const args = process.argv.slice(2).filter(value => !['--unsafe-baseline', '--node-only'].includes(value));
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--sdk-root', 'Use --source or --sdk-root <fresh consumer>, optionally --node-only');
let consumer, compiledSourceSha256, sourceTree, manifestPin;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) { return readdirSync(directory).sort().flatMap(name => {
  const path = join(directory, name), entry = lstatSync(path); assert.equal(entry.isSymbolicLink(), false);
  if (entry.isDirectory()) return files(path); assert.ok(entry.isFile()); return [path];
}); }
if (args[0] === '--source') {
  consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-invitation-source-')));
  const compiled = join(consumer, '.compiled'), example = join(root, owned[2]);
  const program = ts.createProgram([...names.map(name => join(root, `packages/${name}/src/index.ts`)), example], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.every(source => source.fileName === example || names.some(name => source.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  assert.equal(program.emit().emitSkipped, false);
  compiledSourceSha256 = Object.fromEntries(sources.map(source => [relative(root, source.fileName), hash(readFileSync(source.fileName))]));
  assert.equal(compiledSourceSha256[owned[0]], fingerprints[owned[0]]);
  for (const name of names) {
    const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
    for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
    const exports = { '.': { import: './dist/index.js' } };
    if (name === 'connect') { copy(join(compiled, 'examples/device-pipelines/invitation-connection.js'), join(destination, 'examples/invitation-connection.js'));
      exports['./examples/invitation-connection'] = { import: './examples/invitation-connection.js' }; }
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports }));
  }
  sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} else {
  consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(receipt.status, 'pass');
  sourceTree = receipt.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/);
  for (const path of owned) assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 })), fingerprints[path]);
  for (const path of dependencies) assert.equal(receipt.source.sha256[path], fingerprints[path]);
  const bytes = readFileSync(receipt.manifest.path); assert.equal(hash(bytes), receipt.manifest.sha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, sourceTree); assert.equal(manifest.packages.length, names.length);
  assert.equal(new Set(manifest.packages.map(item => item.name)).size, names.length);
  for (const name of names) {
    const item = manifest.packages.find(item => item.name === `@101/${name}`); assert.ok(item && item.files.length > 0 && item.files.length <= 1024);
    const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
    for (const file of item.files) { const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep));
      assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), file.sha256); }
  }
  manifestPin = { path: receipt.manifest.path, sha256: receipt.manifest.sha256 };
}
const publicLoader = join(consumer, 'invitation-public-loader.mjs');
writeFileSync(publicLoader, `import * as sdk from '@101/connect';\nimport * as web from '@101/device-web';\nimport { createInvitationConnectionSource } from '@101/connect/examples/invitation-connection';\nexport { sdk, web, createInvitationConnectionSource };\nexport const resolutions = ${JSON.stringify(names)}.map(name=>({name,url:import.meta.resolve('@101/'+name)}));\n`);
const { sdk, web, createInvitationConnectionSource, resolutions } = await import(pathToFileURL(publicLoader).href);
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
assert.equal(sdk.createInvitationConnectionController, web.createInvitationConnectionController);
const examplePath = join(consumer, 'node_modules/@101/connect/examples/invitation-connection.js');
const work = mkdtempSync(join(tmpdir(), '101-invitation-tls-'));
let origin, endpoint, config, received = 0, created = 0, socketConstructionAttempts = 0, live = 0, maxLive = 0, browser, context, server, wss, active;
let stage = 'TLS credential setup';
const applications = new Set(), liveSockets = new Set(), nativeSockets = new Set(), errors = [], checks = [], records = [];
try {
const key = join(work, 'leaf.key'), cert = join(work, 'leaf.crt');
const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
  '-subj', '/CN=101 owned localhost invitation', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { encoding: 'utf8' });
assert.equal(generated.status, 0);
const ca = readFileSync(cert), receiverIdentity = await sdk.createEphemeralWebIdentity();
server = createServer({ key: readFileSync(key), cert: ca, minVersion: 'TLSv1.3' }, (request, response) => {
  const path = new URL(request.url, origin).pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Owned invitation caller</title>'); return; }
  if (!path.startsWith('/sdk/')) { response.writeHead(404).end(); return; }
  try { const prefix = realpathSync(join(consumer, 'node_modules/@101')), file = realpathSync(resolve(prefix, decodeURIComponent(path.slice(5))));
    assert.ok(file.startsWith(prefix + sep) && file.endsWith('.js')); response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
server.on('connection', socket => { nativeSockets.add(socket); socket.once('close', () => nativeSockets.delete(socket)); });
wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 + 39,
  handleProtocols: protocols => protocols.has(sdk.WSS_SUBPROTOCOL) ? sdk.WSS_SUBPROTOCOL : false });
server.on('upgrade', (request, socket, head) => {
  if (request.socket.encrypted !== true || request.headers.origin !== origin || !['/connect', '/tls-probe'].includes(request.url) ||
    request.headers['sec-websocket-protocol'] !== sdk.WSS_SUBPROTOCOL) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(request, socket, head, connection => wss.emit('connection', connection, request));
});
function application(peer, invitation, measurement) {
  const now = Date.now, readings = []; let receiver, allowed = false, releases = 0;
  const semantic = measurement === 'node-rss' ? 'example:resident-memory' : 'example:viewport-width';
  const sinkDevice = sdk.parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-reading-sink', label: 'Owned local readings', revision: 1,
    adapter: { id: 'example:owned-reading-sink', version: '1.0.0' }, runtime: { platform: 'node-process' }, capabilities: [{ id: 'measurement', semantic,
      schemaVersion: 1, kind: 'property', value: { type: 'scalar', unit: measurement === 'node-rss' ? 'By' : 'px', min: 0, max: Number.MAX_SAFE_INTEGER },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, ownership: { mode: 'exclusive' }, permissions: ['write'] }] });
  const runtime = sdk.createDeviceRuntime({ now, clockDomain: 'owned-receiver-clock', authorize(request) {
    if (allowed && request.principalId === 'application-owner' && request.applicationId === invitation.applicationId && request.sessionId === invitation.sessionId &&
      request.source.deviceId === receiver.description()?.id && request.source.capabilityId === 'measurement' && request.sink.deviceId === sinkDevice.id && request.sink.capabilityId === 'measurement')
      return { expiresAt: now() + 10000, maxHz: 20, maxAgeMs: 1000 };
  } });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'measurement', apply(observation, current) {
    if (!current.isCurrent()) return; readings.push(observation.value); if (readings.length > 32) readings.shift(); received++;
  }, release() { releases++; } }); runtime.setReadiness(sink, 'available');
  receiver = new sdk.RemoteResourceReceiver({ peer, epoch: invitation.epoch, runtime, now, clockId: 'owned-receiver-clock', principalId: 'application-owner',
    applicationId: invitation.applicationId, sessionId: invitation.sessionId });
  return { receiver, readings, get releases() { return releases; }, allow(value) { allowed = value; }, approve() {
    return receiver.approve({ capability: 'measurement', sink, sinkDevice, sinkCapability: 'measurement', codec: 'json/1',
      grant: { expiresAt: now() + 10000, maxHz: 20, maxAgeMs: 1000 } });
  }, stop() { receiver.stop(); runtime.close(); } };
}
wss.on('connection', (raw, request) => {
  if (request.url === '/tls-probe') { raw.close(); return; }
  const selected = config; if (!selected) { raw.close(); return; }
  created++; live++; maxLive = Math.max(maxLive, live); liveSockets.add(raw);
  const port = { get readyState() { return raw.readyState; }, get protocol() { return raw.protocol; }, get bufferedAmount() { return raw.bufferedAmount; },
    get binaryType() { return raw.binaryType; }, set binaryType(value) { raw.binaryType = value; }, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(value) { raw.send(value); }, close() { raw.close(); } };
  raw.on('message', (bytes, binary) => port.onmessage?.({ data: binary ? new Uint8Array(bytes).buffer : bytes.toString() }));
  raw.on('error', () => port.onerror?.({}));
  const transport = new sdk.SecureWebSocketTransport({ endpoint, side: 'server', socket: port, now: Date.now });
  const peer = new sdk.AuthenticatedResourcePeer({ transport, identity: receiverIdentity, crypto: sdk.webEndpointCrypto, now: Date.now,
    ...selected.invitation, role: 'receiver', expectedRemoteKeyId: selected.clientKey, timeoutMs: 5000 });
  const app = application(peer, selected.invitation, selected.measurement), record = { peer, app, transport, raw, selected };
  records.push(record); applications.add(record);
  const timer = setInterval(() => { transport.tick(); peer.tick(); app.receiver.tick(); }, 10);
  raw.on('close', () => { live--; liveSockets.delete(raw); port.onclose?.({}); clearInterval(timer); app.stop(); peer.stop(); applications.delete(record); });
  void transport.connect();
});
stage = 'owned TLS bind';
await new Promise((resolve, reject) => {
  const failed = error => { server.off('listening', ready); reject(error); };
  const ready = () => { server.off('error', failed); resolve(); };
  server.once('error', failed); server.once('listening', ready); server.listen(0, '127.0.0.1');
});
origin = `https://127.0.0.1:${server.address().port}`; endpoint = origin.replace('https:', 'wss:') + '/connect';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 6000) { const started = performance.now(); while (performance.now() - started < timeout) {
  const value = await predicate(); if (value) return value; await delay(10);
} throw new Error(`Timed out: ${label}`); }
async function tls(options) { return new Promise(resolve => {
  const socket = new WebSocket(origin.replace('https:', 'wss:') + '/tls-probe', sdk.WSS_SUBPROTOCOL,
    { headers: { Origin: origin }, minVersion: 'TLSv1.3', handshakeTimeout: 2000, followRedirects: false, ...options });
  socket.once('open', () => { socket.close(); resolve({ open: true }); }); socket.once('error', error => resolve({ open: false, code: error.code }));
}); }
async function fixture(extra = {}) {
  const { discovered = false, ...connectionExtra } = extra;
  const identity = await sdk.createEphemeralWebIdentity(); let at, enrolled = true, allowed = true, sourceAllowed = false, beforeIssue, discoveryCurrent = true;
  const now = () => at ?? Date.now();
  const invitation = sdk.createReceiverInvitation({ applicationId: 'owned-invitation-reading', sessionId: `trial-${records.length}-${created}`, now: now(), randomBytes: sdk.webEndpointCrypto.randomBytes });
  config = { invitation, clientKey: identity.keyId, measurement: 'node-rss' };
  const hint = discovered ? sdk.privateDirectoryCandidates({ schemaVersion: 1, profile: sdk.PRIVATE_DIRECTORY_PROFILE,
    scope: { kind: 'directory', id: 'owned-receiver-directory' }, issuedAt: now(), expiresAt: now() + 10000,
    resources: [{ id: 'owned-reading-sink', revision: 1, label: 'Owned local readings', expiresAt: now() + 9000,
      capabilities: [{ id: 'measurement', semantic: 'example:resident-memory', schemaVersion: 1, kind: 'property' }] }] }, 'owned-host-generation-3')[0] : undefined;
  const abort = new AbortController(); const options = { ownerId: 'owned-caller', identity, crypto: sdk.webEndpointCrypto, now,
    endpoints: [{ id: 'enrolled-receiver', endpoint, remoteKeyId: receiverIdentity.keyId, expiresAt: now() + 600000, isCurrent: () => enrolled,
      createSocket(url, protocol) { beforeIssue?.(); socketConstructionAttempts++; return new WebSocket(url, protocol, { ca, minVersion: 'TLSv1.3', headers: { Origin: origin }, handshakeTimeout: 2000, followRedirects: false }); } }],
    authorizeConnect: scope => allowed ? { scope, expiresAt: scope.deadline, isCurrent: () => !abort.signal.aborted, signal: abort.signal } : undefined,
    ...(hint ? { discoveryEnrollments: [{ endpointId: 'enrolled-receiver', candidate: hint, generation: 3, isCurrent: () => discoveryCurrent }] } : {}), ...connectionExtra };
  const source = createInvitationConnectionSource({ ...options, measurement: 'node-rss', clockId: 'owned-node-clock', sourceOwnerCurrent: () => sourceAllowed });
  return { source, invitation, identity, options, abort, hint, discovery(value) { discoveryCurrent = value; }, allow(value) { allowed = value; }, enroll(value) { enrolled = value; }, sourceAllow(value) { sourceAllowed = value; },
    time(value) { at = value; }, beforeIssue(value) { beforeIssue = value; }, review(input = sdk.encodeReceiverInvitation(invitation), kind = 'manual') { const result = source.review(input, kind, 'enrolled-receiver'); assert.ok(result.ok); return result.value; } };
}
stage = 'TLS trust';
  assert.deepEqual(await tls({ ca }), { open: true }); assert.equal((await tls({})).code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal((await tls({ ca, servername: 'wrong.invalid' })).code, 'ERR_TLS_CERT_ALTNAME_INVALID'); checks.push('native Node TLS CA and hostname validation');
  if (baseline) {
    stage = 'unsafe helper composition after held invitation expiry';
    const f = await fixture(); active = f.source; f.time(f.invitation.expiresAt);
    // Existing public helpers do not own invitation lifetime. This deliberately unsafe
    // caller composition is an actual TLS RED, not a claim about the legacy App.
    const transport = new sdk.SecureWebSocketTransport({ endpoint, side: 'client', now: () => f.invitation.expiresAt,
      createSocket: f.options.endpoints[0].createSocket });
    const peer = new sdk.AuthenticatedResourcePeer({ transport, identity: f.identity, crypto: sdk.webEndpointCrypto, epoch: f.invitation.epoch,
      applicationId: f.invitation.applicationId, sessionId: f.invitation.sessionId, role: 'source', now: () => f.invitation.expiresAt, expectedRemoteKeyId: receiverIdentity.keyId });
    await transport.connect(); const timer = setInterval(() => { transport.tick(); peer.tick(); }, 10);
    try { await until(() => sdk.authenticatedPeerScope(peer), 'unsafe helper authenticated after expiry');
      assert.equal(created, 0, 'expired invitation must not connect after held consent; unsafe composition authenticated over real TLS');
    } finally { clearInterval(timer); peer.stop(); }
  } else {
    stage = 'discovered independently enrolled receiver';
    const discovered = await fixture({ discovered: true }); active = discovered.source;
    const beforeDiscoveredSocket = socketConstructionAttempts;
    assert.equal(discovered.source.controller.snapshot().issuedAttempts, 0);
    const wrongHint = { ...discovered.hint, expiresAt: discovered.hint.expiresAt + 1 };
    assert.equal(discovered.source.reviewDiscovered(wrongHint, sdk.encodeReceiverInvitation(discovered.invitation), 'manual', 'enrolled-receiver').ok, false);
    assert.equal(socketConstructionAttempts, beforeDiscoveredSocket);
    const discoveredReview = discovered.source.reviewDiscovered(discovered.hint, sdk.encodeReceiverInvitation(discovered.invitation), 'manual', 'enrolled-receiver');
    assert.ok(discoveredReview.ok); assert.equal(socketConstructionAttempts, beforeDiscoveredSocket);
    assert.equal(discovered.source.controller.snapshot().pending.discovery.generation, 3);
    assert.equal(discovered.source.controller.snapshot().pending.remoteKeyId, receiverIdentity.keyId);
    const discoveredConnection = await discovered.source.connect(discoveredReview.value); assert.ok(discoveredConnection.ok, JSON.stringify(discoveredConnection));
    const discoveredRecord = records.at(-1); assert.equal(discoveredRecord.app.receiver.description(), undefined);
    discovered.sourceAllow(true); await until(() => discoveredRecord.app.receiver.description(), 'discovered source separately approved');
    assert.ok(discoveredRecord.app.approve()); await until(() => discoveredRecord.app.receiver.status().pending === 0, 'discovered runtime denial');
    assert.equal(discoveredRecord.app.readings.length, 0);
    discoveredRecord.app.allow(true); assert.ok(discoveredRecord.app.approve()); await until(() => discoveredRecord.app.readings.length > 0, 'discovered independent runtime effect');
    discovered.discovery(false); discovered.source.controller.sweep(); await until(() => live === 0, 'discovery loss closes actual TLS socket');
    const afterLoss = socketConstructionAttempts; await delay(50); assert.equal(socketConstructionAttempts, afterLoss);
    assert.equal(discovered.source.reviewDiscovered(discovered.hint, sdk.encodeReceiverInvitation(discovered.invitation), 'manual', 'enrolled-receiver').ok, false);
    discovered.discovery(true);
    const freshDiscoveryReview = discovered.source.reviewDiscovered(discovered.hint, sdk.encodeReceiverInvitation(discovered.invitation), 'manual', 'enrolled-receiver'); assert.ok(freshDiscoveryReview.ok);
    assert.ok((await discovered.source.connect(freshDiscoveryReview.value)).ok);
    discovered.source.close(); active = undefined; await until(() => live === 0, 'fresh explicit discovered retry closes');
    checks.push('exact candidate receipt/scope/expiry and independent generation/endpoint/key review; real pinned TLS/P256; separate source/runtime grants; loss fences output; fresh explicit retry');
    stage = 'provisional review cancelled by trusted clock';
    let clockCallout;
    const cancelledReview = await fixture({ now: () => { clockCallout?.(); return Date.now(); } }); active = cancelledReview.source;
    let clockReads = 0;
    clockCallout = () => { if (++clockReads === 4) { clockCallout = undefined; cancelledReview.source.controller.disconnect(); } };
    const reviewResult = cancelledReview.source.controller.review(sdk.encodeReceiverInvitation(cancelledReview.invitation),
      { source: 'manual', endpointId: 'enrolled-receiver' });
    assert.equal(clockReads, 4); assert.equal(reviewResult.ok, false);
    assert.equal(cancelledReview.source.controller.snapshot().pending, undefined);
    assert.equal(cancelledReview.source.controller.snapshot().timerArmed, false);
    cancelledReview.source.close(); active = undefined;
    checks.push('reentrant Stop during review admission publishes no review or timer');
    stage = 'provisional connect cancelled by trusted clock';
    for (const action of ['cancel', 'disconnect']) {
      let duringAdmission, approvals = 0;
      const cancelled = await fixture({ now: () => { duringAdmission?.(); return Date.now(); }, authorizeConnect: scope => {
        approvals++; return { scope, expiresAt: scope.deadline, isCurrent: () => true };
      } }); active = cancelled.source;
      const handle = cancelled.review(), beforeSocket = created, beforeConstruction = socketConstructionAttempts; let reads = 0;
      duringAdmission = () => { if (++reads === 4) { duringAdmission = undefined;
        if (action === 'cancel') assert.ok(cancelled.source.controller.cancel(handle).ok); else cancelled.source.controller.disconnect();
      } };
      const result = await cancelled.source.connect(handle);
      assert.equal(reads, 4); assert.equal(result.ok, false); assert.equal(approvals, 0); assert.equal(created, beforeSocket);
      assert.equal(socketConstructionAttempts, beforeConstruction);
      assert.equal(cancelled.source.controller.snapshot().issuedAttempts, 0);
      assert.equal(cancelled.source.controller.snapshot().timerArmed, false);
      assert.equal((await cancelled.source.connect(handle)).ok, false);
      const fresh = await cancelled.source.connect(cancelled.review()); assert.ok(fresh.ok, JSON.stringify(fresh));
      assert.equal(approvals, 1); assert.equal(created, beforeSocket + 1); assert.equal(socketConstructionAttempts, beforeConstruction + 1);
      assert.equal(cancelled.source.controller.snapshot().current.invitationExpiresAt, cancelled.invitation.expiresAt);
      assert.ok(cancelled.source.controller.snapshot().current.deadline <= cancelled.invitation.expiresAt);
      cancelled.source.close(); active = undefined; await until(() => live === 0, 'fresh explicit retry raw socket closes');
      checks.push(`reentrant ${action} at final admission issues no approval/socket; fresh reviewed retry connects over real pinned TLS/P256`);
    }
    stage = 'Stop notification reentry';
    let stopApprovals = 0;
    const stopping = await fixture({ authorizeConnect: scope => {
      stopApprovals++; return { scope, expiresAt: scope.deadline, isCurrent: () => true };
    } }); active = stopping.source;
    const stoppingConnection = await stopping.source.connect(stopping.review()); assert.ok(stoppingConnection.ok);
    const stoppingPeer = stopping.source.controller.connection(stoppingConnection.value); assert.ok(stoppingPeer);
    const staleReview = stopping.review(), beforeStopSocket = created, beforeStopConstruction = socketConstructionAttempts;
    let notified = 0, nestedReview, nestedConnect;
    stoppingPeer.onStateChange(state => { if (state !== 'disconnected' || notified) return; notified++;
      nestedReview = stopping.source.controller.review(sdk.encodeReceiverInvitation(stopping.invitation),
        { source: 'manual', endpointId: 'enrolled-receiver' });
      nestedConnect = stopping.source.controller.connect(nestedReview.ok ? nestedReview.value : staleReview);
    });
    stopping.source.controller.disconnect();
    assert.equal(notified, 1); assert.deepEqual(nestedReview, { ok: false, reason: 'busy' });
    assert.deepEqual(await nestedConnect, { ok: false, reason: 'busy' });
    assert.equal(stopApprovals, 1); assert.equal(created, beforeStopSocket);
    assert.equal(socketConstructionAttempts, beforeStopConstruction);
    assert.equal(stopping.source.controller.snapshot().pending, undefined);
    assert.equal(stopping.source.controller.snapshot().current, undefined);
    assert.equal(stopping.source.controller.snapshot().timerArmed, false);
    await until(() => live === 0, 'Stop notification real socket closes');
    const stopRetry = await stopping.source.connect(stopping.review()); assert.ok(stopRetry.ok, JSON.stringify(stopRetry));
    assert.equal(stopApprovals, 2); assert.equal(created, beforeStopSocket + 1);
    assert.equal(socketConstructionAttempts, beforeStopConstruction + 1);
    stopping.source.close(); active = undefined; await until(() => live === 0, 'Stop retry real socket closes');
    checks.push('actual disconnected observer cannot review/connect during Stop; explicit reviewed retry after Stop connects over pinned TLS/P256');
    stage = 'held consent expiry'; let release, scope;
    const f = await fixture({ authorizeConnect(value) { scope = value; return new Promise(resolve => { release = resolve; }); } }); active = f.source;
    const before = created, pending = f.source.connect(f.review()); f.time(f.invitation.expiresAt); f.source.controller.sweep(); assert.equal((await pending).ok, false);
    release({ scope, expiresAt: scope.deadline, isCurrent: () => true }); await delay(25); assert.equal(created, before); f.source.close(); active = undefined;
    checks.push('held approval expires before real TLS socket dispatch');
    stage = 'manual/link/QR-decoded text';
    const n = await fixture(); active = n.source;
    n.review(sdk.encodeReceiverInvitationLink(n.invitation, 'https://carrier.invalid/pointer-lab'), 'link'); n.review(sdk.encodeReceiverInvitation(n.invitation), 'qr');
    assert.equal(created, before); const connected = await n.source.connect(n.review()); assert.ok(connected.ok, JSON.stringify(connected));
    const incumbent = n.source.controller.connection(connected.value); assert.ok(incumbent);
    const nodeRecord = records.at(-1); assert.ok(sdk.authenticatedPeerScope(nodeRecord.peer)); assert.equal(nodeRecord.app.receiver.description(), undefined);
    assert.equal(nodeRecord.app.readings.length, 0); checks.push('manual/link/QR text inert; real bilateral P256 WSS pin and exact invitation scope');
    n.sourceAllow(true); await until(() => nodeRecord.app.receiver.description(), 'explicit source owner description');
    nodeRecord.app.approve(); await until(() => nodeRecord.app.receiver.status().pending === 0, 'denied runtime admission retires binding');
    assert.equal(nodeRecord.app.readings.length, 0);
    nodeRecord.app.allow(true); assert.ok(nodeRecord.app.approve()); await until(() => nodeRecord.app.readings.length, 'actual Node RSS via independently authorized runtime route');
    assert.ok(nodeRecord.app.readings.every(value => Number.isSafeInteger(value) && value > 0)); checks.push('connection alone gives no source capture, receiver selection or runtime route permission');
    stage = 'incumbent and revoked connection';
    assert.equal(n.source.review(sdk.encodeReceiverInvitation(n.invitation), 'manual', 'unknown').ok, false); assert.equal(n.source.controller.connection(connected.value), incumbent);
    n.allow(false); assert.equal((await n.source.connect(n.review())).ok, false); assert.equal(n.source.controller.connection(connected.value), incumbent);
    n.allow(true); n.beforeIssue(() => assert.equal(n.source.controller.connection(connected.value), undefined, 'incumbent authority must retire before replacement dispatch'));
    const transferred = await n.source.connect(n.review()); assert.ok(transferred.ok); assert.equal(n.source.controller.connection(connected.value), undefined);
    assert.equal(sdk.authenticatedPeerScope(incumbent), undefined); assert.equal(incumbent.send('disposable', 'late-retired-frame'), false); const effects = received; n.abort.abort();
    await until(() => !n.source.controller.connection(transferred.value), 'revoked issued scope'); await delay(80);
    assert.equal(received, effects); assert.ok(nodeRecord.app.releases > 0); n.source.close(); active = undefined;
    await until(() => live === 0, 'real close completion'); checks.push('unsupported/denied review preserves incumbent; accepted transfer retires old authority before new socket; explicit grant abort fences late effects');
    stage = 'wrong endpoint key';
    const wrong = await fixture(); active = wrong.source;
    const wrongOptions = { ...wrong.options, endpoints: [{ ...wrong.options.endpoints[0], remoteKeyId: '0'.repeat(64) }] };
    const rejected = sdk.createInvitationConnectionController(wrongOptions); const review = rejected.review(sdk.encodeReceiverInvitation(wrong.invitation), { source: 'manual', endpointId: 'enrolled-receiver' }); assert.ok(review.ok);
    assert.equal((await rejected.connect(review.value)).ok, false); assert.equal(rejected.snapshot().current, undefined); rejected.close(); wrong.source.close(); active = undefined;
    await until(() => live === 0, 'wrong key close'); checks.push('real incorrect enrolled key fails authentication without resources');
    stage = 'real application and session mismatch';
    for (const field of ['applicationId', 'sessionId']) {
      const mismatch = await fixture(); active = mismatch.source;
      const mismatchedInvitation = sdk.createReceiverInvitation({ applicationId: field === 'applicationId' ? 'different-owned-application' : mismatch.invitation.applicationId,
        sessionId: field === 'sessionId' ? 'different-owned-session' : mismatch.invitation.sessionId, now: Date.now(),
        // Same valid invitation nonce isolates this one scope field; handshake nonces/signatures remain native crypto.
        randomBytes: () => new Uint8Array(Buffer.from(mismatch.invitation.epoch, 'hex')) });
      config = { ...config, invitation: mismatchedInvitation };
      assert.equal((await mismatch.source.connect(mismatch.review())).ok, false); assert.equal(mismatch.source.controller.snapshot().current, undefined);
      mismatch.source.close(); active = undefined; await until(() => live === 0, 'scope mismatch closes real socket');
    }
    checks.push('real pinned endpoint rejects distinct application and session transcript scopes');
    stage = 'quiet current grant expiry';
    const expiring = await fixture({ authorizeConnect: scope => ({ scope, expiresAt: Date.now() + 1500, isCurrent: () => true }) }); active = expiring.source;
    const expiringConnection = await expiring.source.connect(expiring.review()); assert.ok(expiringConnection.ok);
    // No controller sweep/tick or authority lookup is issued during this quiet interval.
    await delay(1700); assert.equal(expiring.source.controller.snapshot().state, 'expired');
    assert.equal(expiring.source.controller.snapshot().current, undefined); expiring.source.close(); active = undefined;
    await until(() => live === 0, 'quiet expiry real socket close'); checks.push('owned timer expires current connection grant during quiet interval');
    stage = 'disappearance and explicit retry';
    const retry = await fixture(); active = retry.source; const first = await retry.source.connect(retry.review()); assert.ok(first.ok);
    const firstRecord = records.at(-1), firstCount = created; firstRecord.raw.terminate(); await until(() => !retry.source.controller.connection(first.value), 'endpoint disappearance');
    await delay(80); assert.equal(created, firstCount); assert.equal((await retry.source.connect({ kind: 'invitation-review' })).ok, false);
    const second = await retry.source.connect(retry.review()); assert.ok(second.ok); retry.enroll(false); retry.source.controller.sweep();
    assert.equal(retry.source.controller.connection(second.value), undefined); retry.source.close(); active = undefined;
    await until(() => live === 0, 'retry enrollment close'); checks.push('disappearance has no automatic reconnect; explicit reviewed retry and enrollment revocation');
    if (!nodeOnly) {
      stage = 'native browser WebSocket';
      browser = await chromium.launch({ headless: true }); context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 913, height: 601 } });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => assert.equal(new URL(request.url()).origin, origin)); await page.goto(origin);
      const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
      imports['@101/connect/examples/invitation-connection'] = '/sdk/connect/examples/invitation-connection.js';
      await page.addScriptTag({ type: 'importmap', content: JSON.stringify({ imports }) });
      const browserSetup = await page.evaluate(async () => {
        const sdk = await import('@101/connect'), example = await import('@101/connect/examples/invitation-connection');
        const identity = await sdk.createEphemeralWebIdentity();
        const invitation = sdk.createReceiverInvitation({ applicationId: 'owned-invitation-reading', sessionId: 'owned-browser-caller', now: Date.now(), randomBytes: sdk.webEndpointCrypto.randomBytes });
        globalThis.fixture = { sdk, example, identity, invitation, sourceAllowed: false, connectAllowed: true, enrolled: true };
        return { invitation, clientKey: identity.keyId };
      });
      config = { ...browserSetup, measurement: 'browser-viewport-width' };
      const browserResult = await page.evaluate(async ({ endpoint, remoteKeyId }) => {
        const f = globalThis.fixture; f.source = f.example.createInvitationConnectionSource({ ownerId: 'owned-browser', identity: f.identity, crypto: f.sdk.webEndpointCrypto, now: Date.now,
          endpoints: [{ id: 'enrolled-receiver', endpoint, remoteKeyId, expiresAt: Date.now() + 600000, isCurrent: () => f.enrolled }],
          authorizeConnect: scope => f.connectAllowed ? { scope, expiresAt: scope.deadline, isCurrent: () => f.connectAllowed } : undefined,
          measurement: 'browser-viewport-width', clockId: 'owned-browser-clock', sourceOwnerCurrent: () => f.sourceAllowed });
        const input = f.sdk.encodeReceiverInvitationLink(f.invitation, location.origin + '/pointer-lab');
        const review = f.source.review(input, 'link', 'enrolled-receiver'); if (!review.ok) return review;
        const result = await f.source.connect(review.value); f.handle = result.ok ? result.value : undefined; return result;
      }, { endpoint, remoteKeyId: receiverIdentity.keyId }); assert.ok(browserResult.ok, JSON.stringify(browserResult));
      const browserRecord = records.at(-1); assert.equal(browserRecord.app.receiver.description(), undefined);
      await page.evaluate(() => { globalThis.fixture.sourceAllowed = true; });
      await until(() => browserRecord.app.receiver.description(), 'browser source owner description'); browserRecord.app.approve();
      await until(() => browserRecord.app.receiver.status().pending === 0, 'denied browser runtime admission retires binding');
      assert.equal(browserRecord.app.readings.length, 0);
      browserRecord.app.allow(true); assert.ok(browserRecord.app.approve()); await until(() => browserRecord.app.readings.includes(913), 'actual browser viewport effect');
      const browserStatus = await page.evaluate(() => globalThis.fixture.source.status()); assert.ok(browserStatus.published > 0); assert.equal(browserStatus.measured, 913);
      await page.evaluate(() => globalThis.fixture.source.close()); await until(() => live === 0, 'browser real socket closed');
      assert.equal(errors.length, 0); checks.push('native Chromium WebSocket, genuine viewport measurement and separately granted Node effect');
    }
  }
  const receipt = { schemaVersion: 1, result: 'pass', profile: sdk.INVITATION_CONNECTION_PROFILE,
    mode: compiledSourceSha256 ? 'owned-public-source-closure' : 'installed-immutable-public-sdk', sourceTree, sourceSha256: fingerprints,
    ...(compiledSourceSha256 ? { compiledSourceSha256 } : {}), ...(manifestPin ? { manifestPin } : {}), consumer,
    compiledExampleSha256: hash(readFileSync(examplePath)), publicEsmResolutions: resolutions, publicLoaderSha256: hash(readFileSync(publicLoader)), environment: { node: process.version, typescript: ts.version, browser: await browser?.version() },
    proof: { checks, genuineTlsConnections: created, socketConstructionAttempts, maximumObservedSocketOverlap: maxLive, resourceEffects: received, pageErrors: errors },
    limits: sdk.INVITATION_CONNECTION_LIMITS,
    scope: `Provisioned fixed WSS/P256 endpoint; actual Node RSS${nodeOnly ? ' software caller; browser execution deferred' : ' and Chromium viewport callers'}; no native LAN discovery qualification, optical QR scan, phone/physical network/OS chooser/account identity or invitation-derived resource grant.`,
    browserCertificateTrust: nodeOnly ? 'Not executed; native Node independently validates owned CA and wrong hostname' : 'isolated Playwright local certificate exception; native Node independently validates owned CA and wrong hostname', work };
  const receiptPath = join(consumer, 'invitation-connection-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ receiptPath, ...receipt }));
} catch (error) { console.error(JSON.stringify({ stage, baseline, error: String(error), created, live, lastPeer: records.at(-1)?.peer.status(), lastApp: records.at(-1)?.app.receiver.status(), errors })); process.exitCode = 1; }
finally {
  try {
    active?.close(); await context?.close(); await browser?.close();
    for (const record of applications) { record.app.stop(); record.peer.stop(); }
    for (const raw of liveSockets) raw.terminate();
    for (const raw of nativeSockets) raw.destroy();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (wss) await new Promise(resolve => wss.close(() => resolve()));
  } finally { rmSync(work, { recursive: true, force: true }); }
}
