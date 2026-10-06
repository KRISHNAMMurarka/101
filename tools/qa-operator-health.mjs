import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/operator-health.ts', 'packages/device-runtime/src/operator-health.test.ts',
  'examples/operator-health/consumer.mjs', 'tools/qa-operator-health.mjs'];
const assets = [];
const fingerprints = Object.fromEntries([...owned, ...assets].map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const argument = process.argv[2];
assert.ok(argument === '--source' && process.argv.length === 3 || argument === '--sdk-root' && process.argv.length === 4,
  'Use --source for an owned public source closure or --sdk-root <fresh installed consumer>');
let consumer, mode, sourceTree, compiledSource, immutableManifest;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path);
    assert.equal(entry.isSymbolicLink(), false, 'No source/consumer file may be a symlink');
    if (entry.isDirectory()) return files(path);
    assert.ok(entry.isFile()); return [path];
  });
}
if (argument === '--source') {
  mode = 'owned-public-source-closure';
  consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-operator-health-source-')));
  const compiled = join(consumer, '.compiled'), roots = names.map(name => join(root, `packages/${name}/src/index.ts`));
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])),
  });
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.every(source => names.some(name => source.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
  compiledSource = Object.fromEntries(sources.map(source => [relative(root, source.fileName), hash(readFileSync(source.fileName))]));
  assert.equal(compiledSource['packages/device-runtime/src/operator-health.ts'], fingerprints[owned[0]]);
  for (const name of names) {
    const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
    for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  }
  sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} else {
  mode = 'installed-immutable-public-sdk'; consumer = realpathSync(resolve(process.argv[3]));
  assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
  sourceTree = packed.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/);
  for (const path of [...owned, ...assets]) {
    const immutable = execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 });
    assert.equal(hash(immutable), fingerprints[path], `Caller bytes differ from immutable SDK source: ${path}`);
  }
  assert.equal(packed.source.sha256[owned[0]], fingerprints[owned[0]]);
  for (const path of ['packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/inspector.ts', 'packages/transport-websocket/src/peer.ts'])
    assert.equal(packed.source.sha256[path], hash(readFileSync(join(root, path))));
  const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, sourceTree);
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => `@101/${name}`).sort());
  for (const item of manifest.packages) {
    assert.ok(names.some(name => item.name === `@101/${name}`));
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const prefix = join(consumer, 'node_modules', item.name);
    assert.equal(realpathSync(prefix), prefix); assert.equal(lstatSync(prefix).isSymbolicLink(), false);
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep));
      assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile());
      assert.equal(hash(readFileSync(path)), file.sha256, `Installed bytes differ: ${item.name}/${file.path}`);
    }
  }
  immutableManifest = { path: packed.manifest.path, sha256: packed.manifest.sha256 };
}
const caller = join(consumer, 'operator-health-caller'); mkdirSync(caller);
copy(join(root, owned[2]), join(caller, 'consumer.mjs'));
writeFileSync(join(caller, 'public-loader.mjs'), `import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';
import { createOwnedOperatorExample } from './consumer.mjs';
export { sdk, runtime, createOwnedOperatorExample };
export const resolutions=${JSON.stringify(names)}.map(name=>({name,url:import.meta.resolve('@101/'+name)}));\n`);
const { sdk, runtime, createOwnedOperatorExample, resolutions } = await import(pathToFileURL(join(caller, 'public-loader.mjs')).href);
assert.equal(sdk.createOperatorHealthMonitor, runtime.createOperatorHealthMonitor);
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules/@101', item.name, 'dist/index.js')).href);
const tlsFiles = mkdtempSync(join(tmpdir(), '101-operator-health-tls-')), key = join(tlsFiles, 'leaf.key'), cert = join(tlsFiles, 'leaf.crt');
const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
  '-subj', '/CN=101 owned operator health', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { encoding: 'utf8' });
assert.equal(generated.status, 0); const ca = readFileSync(cert);
const server = createServer({ key: readFileSync(key), cert: ca, minVersion: 'TLSv1.3' }, (_request, response) => response.writeHead(404).end());
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 + 39,
  handleProtocols: protocols => protocols.has(sdk.WSS_SUBPROTOCOL) ? sdk.WSS_SUBPROTOCOL : false });
let origin, endpoint, receiver, rawServer, rawClient, example, observedPayload;
const sockets = new Set();
server.on('upgrade', (request, socket, head) => {
  if (!request.socket.encrypted || request.headers.origin !== origin || request.url !== '/health' || request.headers['sec-websocket-protocol'] !== sdk.WSS_SUBPROTOCOL) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(request, socket, head, connection => wss.emit('connection', connection));
});
wss.on('connection', raw => {
  rawServer = raw; sockets.add(raw); raw.once('close', () => sockets.delete(raw));
  const port = { get readyState() { return raw.readyState; }, get protocol() { return raw.protocol; }, get bufferedAmount() { return raw.bufferedAmount; },
    get binaryType() { return raw.binaryType; }, set binaryType(value) { raw.binaryType = value; }, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(value) { raw.send(value); }, close() { raw.close(); } };
  raw.on('message', (bytes, binary) => port.onmessage?.({ data: binary ? new Uint8Array(bytes).buffer : bytes.toString() }));
  raw.on('close', () => port.onclose?.({})); raw.on('error', () => port.onerror?.({}));
  receiver = new sdk.SecureWebSocketTransport({ endpoint, side: 'server', socket: port, now: Date.now });
  receiver.onData((_lane, value) => { observedPayload = value; }); void receiver.connect();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `https://127.0.0.1:${server.address().port}`; endpoint = origin.replace('https:', 'wss:') + '/health';
const sender = new sdk.SecureWebSocketTransport({ endpoint, side: 'client', now: Date.now,
  createSocket(url, protocol) { rawClient = new WebSocket(url, protocol, { ca, minVersion: 'TLSv1.3', headers: { Origin: origin }, handshakeTimeout: 2000, followRedirects: false });
    sockets.add(rawClient); rawClient.once('close', () => sockets.delete(rawClient)); return rawClient; } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) { const deadline = performance.now() + 4000;
  while (!predicate()) { assert.ok(performance.now() < deadline, label); await delay(5); } }
const checks = [], samples = [];
function redacted(snapshot) {
  const serialized = JSON.stringify(snapshot);
  for (const privateText of ['private-', 'PRIVATE_', 'health-private-payload', endpoint]) assert.equal(serialized.includes(privateText), false, privateText);
  assert.ok(snapshot.retainedBytes <= sdk.OPERATOR_HEALTH_LIMITS.bytes); return snapshot;
}
try {
  await sender.connect(); await until(() => sender.state === 'connected' && receiver?.state === 'connected', 'actual bilateral WSS negotiation');
  assert.equal(rawClient._socket.authorized, true); assert.equal(rawClient._socket.getProtocol(), 'TLSv1.3');
  checks.push('actual TLSv1.3 and direct WSS session, supplied CA and hostname verified');
  assert.ok(sender.send('reliable', 'health-private-payload'));
  await until(() => observedPayload === 'health-private-payload', 'real private payload received');
  assert.ok(receiver.send('reliable', 'PRIVATE_RETURN_PAYLOAD'));
  await until(() => sender.status().received === 1, 'real return packet');
  rawServer.send(Buffer.from([0])); await until(() => sender.status().dropped === 1, 'actual malformed wire packet drop');
  example = createOwnedOperatorExample({ transport: sender });
  assert.equal(example.monitor.sample().ok, false); assert.equal((await example.monitor.start()).ok, false);
  assert.equal(example.monitor.snapshot().samples.length, 0); assert.ok((await example.approveMetadata()).ok);
  const first = example.monitor.sample(); assert.ok(first.ok); samples.push(redacted(example.monitor.snapshot()));
  assert.equal(first.value.sources[0].metrics.deniedRoutes, 1); assert.equal(first.value.sources[0].metrics.activeRoutes, 0);
  assert.deepEqual(first.value.sources[1].metrics, { kind: 'wss-transport', sentPackets: 1, receivedPackets: 1, droppedPackets: 1,
    reportedPending: 0, bufferedBytes: sender.status().bufferedBytes, connectionState: 'connected' });
  checks.push('exact metadata grant separate from denied actual resource route; real transport packet/drop counts only');
  example.startRoutes(); const reading = example.readRss(); example.queueLoad(); await delay(110);
  const loaded = example.monitor.sample(); assert.ok(loaded.ok); samples.push(redacted(example.monitor.snapshot()));
  const metrics = loaded.value.sources[0].metrics;
  assert.equal(metrics.resources, 4); assert.equal(metrics.activeRoutes, 2); assert.equal(metrics.deniedRoutes, 1);
  assert.equal(metrics.queuedOperations, 2); assert.equal(metrics.knownQueueCapacity, 4); assert.equal(metrics.rawProviderWork, null); assert.ok(metrics.faultsInTrace >= 2);
  assert.ok(reading.rss > 0 && reading.deliveries === 1); checks.push('actual Node RSS route and bounded reliable queue/capacity faults; no raw-work inference');
  example.revokeRoutes(); await delay(110); const revoked = example.monitor.sample(); assert.ok(revoked.ok);
  assert.equal(revoked.value.sources[0].metrics.activeRoutes, 0); assert.equal(revoked.value.sources[0].metrics.revokedRoutes, 2);
  assert.equal(revoked.value.sources[0].metrics.queuedOperations, 0); samples.push(redacted(example.monitor.snapshot()));
  checks.push('real runtime revocation reflected while independent metadata remains active');
  example.abortMetadata(); const terminal = redacted(example.monitor.snapshot());
  assert.equal(terminal.state, 'revoked'); assert.equal(terminal.samples.length, 0); assert.equal(terminal.timerArmed, false);
  assert.equal(example.inspector.snapshot().closed, false); assert.equal(sender.state, 'connected');
  checks.push('metadata abort clears retained history/timer and preserves borrowed runtime/transport lifecycle');
  console.log(JSON.stringify({ result: 'pass', mode, sourceTree, fingerprints, compiledSource, immutableManifest, resolutions,
    profile: sdk.OPERATOR_HEALTH_PROFILE, checks, samples, terminal,
    scope: 'Selected explicit Node operator metadata snapshots only. Packet counts are not byte rates or end-to-end application effects; raw provider work is unknown. No network relay/coordinator, physical health or credential logging.' }));
} finally {
  example?.close(); await sender.disconnect(); await receiver?.disconnect();
  for (const socket of sockets) socket.close(); await until(() => sockets.size === 0, 'owned sockets close');
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
}
