import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = value => createHash('sha256').update(value).digest('hex');
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--sdk-root' && args[1]);
const sdkNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const sourceNames = ['hub-server', 'pairing', 'protocol', 'input'];
const entries = Object.fromEntries(sourceNames.map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href]));
let producer, consumer;
function boundedJson(path, limit) { const bytes = readFileSync(path); assert.ok(bytes.byteLength <= limit); return JSON.parse(bytes.toString('utf8')); }
function inventory(directory) {
  const found = []; let visited = 0;
  function walk(current) { assert.equal(realpathSync(current), current); assert.equal(lstatSync(current).isSymbolicLink(), false);
    for (const name of readdirSync(current).sort()) { assert.ok(++visited <= 2048); const path = join(current, name), state = lstatSync(path);
      assert.equal(realpathSync(path), path); assert.equal(state.isSymbolicLink(), false);
      if (state.isDirectory()) walk(path); else { assert.ok(state.isFile()); assert.ok(found.length < 1024); found.push(relative(directory, path)); }
    }
  } walk(directory); return found.sort();
}
if (args[0] === '--sdk-root') {
  consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
  const receipt = boundedJson(join(consumer, 'receipt.json'), 512 * 1024); assert.equal(receipt.status, 'pass');
  const bytes = readFileSync(receipt.manifest.path); assert.ok(bytes.byteLength <= 2 * 1024 * 1024); assert.equal(hash(bytes), receipt.manifest.sha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
  assert.match(manifest.source.tree, /^[0-9a-f]{40}$/); assert.equal(manifest.packages.length, 7);
  const sourcePins = Object.entries(manifest.source.sha256); assert.ok(sourcePins.length > 0 && sourcePins.length <= 256);
  // New leaf/hub source uses an older isolated base. The whole SDK source claim
  // is bound to its exact immutable producer Git tree, never to that old base.
  for (const [path, pin] of sourcePins) {
    assert.match(path, /^(LICENSE|schemas\/device-descriptor\.schema\.json|(packages|examples)\/[A-Za-z0-9_./-]+)$/); assert.equal(path.includes('..'), false);
    const data = execFileSync('git', ['show', manifest.source.tree + ':' + path], { cwd: root, maxBuffer: 2 * 1024 * 1024 }); assert.equal(hash(data), pin);
  }
  let packedFiles = 0;
  for (const name of sdkNames) {
    const item = manifest.packages.find(value => value.name === '@101/' + name); assert.ok(item && item.files.length && item.files.length <= 1024);
    const directory = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(directory), directory); assert.equal(lstatSync(directory).isSymbolicLink(), false);
    assert.deepEqual(inventory(directory), item.files.map(file => file.path).sort());
    for (const file of item.files) { const path = resolve(directory, file.path); assert.ok(path.startsWith(directory + '/')); assert.equal(realpathSync(path), path);
      assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), file.sha256); packedFiles++; }
  }
  // This owned fresh consumer leaf resolves and IMPORTS all public ESM exports
  // before any source-workspace hook exists. Existing packages/receipt stay intact.
  const external = mkdtempSync(join(consumer, 'runtime-recovery-')), resolver = join(external, 'resolve.mjs');
  const specifiers = [...sdkNames.map(name => '@101/' + name), '@101/connect/examples/secure-websocket'];
  const resolverSource = 'const entries={};\nfor(const name of ' + JSON.stringify(specifiers) + '){entries[name]=import.meta.resolve(name);await import(name);}\nexport default entries;\n';
  writeFileSync(resolver, resolverSource);
  const resolved = (await import(pathToFileURL(resolver).href)).default;
  for (const specifier of specifiers) { const path = fileURLToPath(resolved[specifier]), name = specifier.slice(5).split('/')[0];
    const directory = join(consumer, 'node_modules/@101', name); assert.ok(path.startsWith(directory + '/')); assert.equal(realpathSync(path), path);
    const item = manifest.packages.find(value => value.name === '@101/' + name); assert.ok(item.files.some(file => file.path === relative(directory,path)));
    entries[specifier] = resolved[specifier];
  }
  const resolutionReceipt = join(external,'resolution.json');
  writeFileSync(resolutionReceipt, JSON.stringify({ result:'pass', specifiers:resolved, resolverSha256:hash(resolverSource), node:process.version, noSourceHooks:true },null,2));
  producer = { manifest: receipt.manifest, tree: manifest.source.tree, sourcePins: sourcePins.length, packedFiles, packages: 7,
    ordinaryPublicEsmResolution: { receipt:resolutionReceipt, sha256:hash(readFileSync(resolutionReceipt)), imports:specifiers.length } };
} else {
  for (const name of sdkNames) entries['@101/' + name] = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
  entries['@101/connect/examples/secure-websocket'] = pathToFileURL(join(root, 'examples/device-pipelines/secure-websocket.ts')).href;
}
const actualSource = new Map();
const hooks = registerHooks({ resolve(specifier, context, next) {
  const value = next(entries[specifier] ?? specifier, context);
  if (value.url.startsWith(pathToFileURL(root + '/').href) && /\.(ts|mjs)$/.test(value.url) && !value.url.includes('/node_modules/')) {
    const path = new URL(value.url); assert.ok(actualSource.size < 256 || actualSource.has(path.href)); actualSource.set(path.href, hash(readFileSync(path)));
  } return value;
} });

/** Actual native RTC endpoints and identities in ONE owned trusted page realm.
 * No copied peer metadata, fake RTC ports, STUN/TURN or modified signed SDP. */
async function nativeRtcPage({ sdkUrl, runnerUrl }) {
  const sdk = await import(sdkUrl), { runRuntimeRecoveryQualification } = await import(runnerUrl);
  const now = () => performance.now(), owner = new AbortController(), trials = [], connections = new Set(), channels = new Set(), opened = new Set();
  let previous, currentPacket, generation = 0, peakNativeBufferedBytes = 0;
  const deadline = now() + 15000, lifetime = setTimeout(() => owner.abort(), 15000);
  async function until(condition) { const stop = Math.min(deadline, now() + 3000);
    while (!condition()) { if (owner.signal.aborted || now() >= stop) throw Error('Owned native RTC wait retired.'); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  function nativePeer(configuration) {
    const peer = new RTCPeerConnection({ ...configuration, iceServers: [] }); connections.add(peer);
    const create = peer.createDataChannel.bind(peer);
    const track = channel => { channels.add(channel); channel.addEventListener('close', () => channels.delete(channel), { once: true }); return channel; };
    peer.createDataChannel = (label, options) => track(create(label, options)); peer.addEventListener('datachannel', event => track(event.channel)); return peer;
  }
  async function pair() {
    if (++generation > 4) throw Error('Owned RTC generation quota.');
    const epoch = crypto.randomUUID().replaceAll('-', ''), applicationId = 'runtime-recovery', sessionId = 'recovery-native-webrtc-' + generation;
    const identities = await Promise.all([sdk.createEphemeralWebIdentity(), sdk.createEphemeralWebIdentity()]);
    if (owner.signal.aborted) throw Error('Owned RTC retired.');
    const raw = [new sdk.PeerDataTransport({ initiator: true, createPeer: nativePeer, iceServers: [], reliableBufferLimit: 16384, disposableBufferLimit: 8192, maxMessageBytes: 8192 }),
      new sdk.PeerDataTransport({ initiator: false, createPeer: nativePeer, iceServers: [], reliableBufferLimit: 16384, disposableBufferLimit: 8192, maxMessageBytes: 8192 })];
    const peers = [new sdk.AuthenticatedResourcePeer({ transport: raw[0], identity: identities[0], crypto: sdk.webEndpointCrypto, epoch, applicationId, sessionId,
      role: 'source', expectedRemoteKeyId: identities[1].keyId, now }), new sdk.AuthenticatedResourcePeer({ transport: raw[1], identity: identities[1], crypto: sdk.webEndpointCrypto,
      epoch, applicationId, sessionId, role: 'receiver', expectedRemoteKeyId: identities[0].keyId, now })];
    let timer, retiring;
    const value = { sourcePeer: peers[0], receiverPeer: peers[1], epoch,
      async disconnect() { peers.forEach(peer => peer.stop()); await Promise.all(raw.map(peer => peer.disconnect())); },
      close() { if (retiring) return retiring; clearInterval(timer); peers.forEach(peer => peer.stop());
        retiring = (async () => { await Promise.all(raw.map(peer => peer.disconnect()));
          await until(() => [...connections].every(peer => peer.connectionState === 'closed') && [...channels].every(channel => channel.readyState === 'closed'));
          for (const peer of connections) { if (peer.connectionState !== 'closed') throw Error('Owned RTC peer remains open.'); connections.delete(peer); }
          for (const channel of channels) { if (channel.readyState !== 'closed') throw Error('Owned RTC channel remains open.'); channels.delete(channel); }
          opened.delete(value);
        })(); void retiring.catch(() => {}); return retiring; } };
    opened.add(value);
    try {
      await raw[0].connect(); await raw[1].connect();
      // These exact applied native descriptions feed the existing transcript.
      const offer = await raw[0].createOffer(), answer = await raw[1].acceptOffer(offer); await raw[0].acceptAnswer(answer);
      timer = setInterval(() => { peers.forEach(peer => peer.tick()); for (const channel of channels) peakNativeBufferedBytes = Math.max(peakNativeBufferedBytes, channel.bufferedAmount); }, 5);
      await until(() => peers.every(peer => !!sdk.authenticatedPeerScope(peer))); return value;
    } catch (error) { await value.close(); throw error; }
  }
  try {
    for (const mode of ['owner-revoke','lease-expiry','native-loss','recovery']) {
      const value = await pair(), sourceOwner = new AbortController(), sinkOwner = new AbortController(); currentPacket = undefined;
      try {
        const proof = await runRuntimeRecoveryQualification({ sourcePeer: value.sourcePeer, receiverPeer: value.receiverPeer, epoch: value.epoch,
          sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now, mode,
          impairment: { path: 'native-webrtc', disconnect: () => value.disconnect(), close: () => value.close(), revokeOwner: () => sinkOwner.abort(),
            remember(data) { currentPacket = data; }, replayPrevious(peer) { return previous !== undefined && peer.send('disposable', previous); } } });
        if (mode === 'native-loss') previous = currentPacket; trials.push(proof);
      } finally { sourceOwner.abort(); sinkOwner.abort(); await value.close(); }
    }
  } finally { clearTimeout(lifetime); for (const value of opened) await value.close(); }
  if (connections.size || channels.size || opened.size) throw Error('Owned native RTC cleanup remains.');
  return { result: 'pass', path: 'native-webrtc', trials, actualGenerations: generation, peakNativeBufferedBytes, iceServers: 0, actualNativePeerConnections: generation * 2,
    oneTrustedHostRealm: true, independentEndpointIdentities: true, unchangedActualSdpTranscript: true, copiedProvenanceAccepted: false,
    cleanup: { peerConnections: 0, dataChannels: 0, pendingPairs: 0, ownedTimer: false }, physicalInput: false, actualIpLoss: false, twoPageOrSandboxQualification: false };
}

async function browserProof() {
  const modules = new Map(), sourcePins = {}, sdkMap = {};
  function collect(path) {
    const route = '/source/' + relative(root, path); if (modules.has(route)) return route; assert.ok(modules.size < 256);
    const source = readFileSync(path, 'utf8'); sourcePins[relative(root, path)] = hash(source); modules.set(route, '');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const file = ts.createSourceFile(path, js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), imports = [];
    function visit(node) { if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier); ts.forEachChild(node, visit); }
    visit(file); let value = js;
    for (const item of imports.sort((a,b) => b.getStart(file) - a.getStart(file))) {
      let dependency;
      if (item.text.startsWith('@101/')) { if (producer) continue; const name = item.text.slice(5); assert.ok(sdkNames.includes(name)); dependency = join(root, 'packages', name, 'src/index.ts'); }
      else { assert.ok(item.text.startsWith('.')); dependency = resolve(dirname(path), item.text); }
      assert.ok(dependency.startsWith(root + '/packages/') || dependency === join(root, 'examples/runtime-recovery/runtime-recovery.ts'));
      value = value.slice(0,item.getStart(file)+1) + collect(dependency) + value.slice(item.getEnd()-1);
    }
    modules.set(route,value); return route;
  }
  const runnerUrl = collect(join(root, 'examples/runtime-recovery/runtime-recovery.ts'));
  let sdkUrl;
  if (producer) { for (const name of sdkNames) sdkMap['@101/' + name] = '/sdk/' + relative(join(consumer,'node_modules/@101'),fileURLToPath(entries['@101/' + name])); sdkUrl = sdkMap['@101/connect']; }
  else sdkUrl = collect(join(root, 'packages/connect/src/index.ts'));
  const sockets = new Map(); let browser, context, server, closed = false, origin, requests = 0; const errors = [], foreign = [];
  server = createServer((request,response) => {
    if (++requests > 1024 || request.method !== 'GET' || !request.url || request.url.length > 1024) { response.writeHead(404); response.end(); return; }
    const path = new URL(request.url,'http://127.0.0.1').pathname;
    if (path === '/') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>Owned native software recovery</title><script type="importmap">' + JSON.stringify({ imports: sdkMap }) + '</script>'); return; }
    if (modules.has(path)) { response.setHeader('Content-Type','text/javascript'); response.end(modules.get(path)); return; }
    if (producer && path.startsWith('/sdk/')) {
      try { const file = resolve(consumer,'node_modules/@101',decodeURIComponent(path.slice(5))); assert.ok(file.startsWith(join(consumer,'node_modules/@101') + '/'));
        assert.equal(realpathSync(file),file); assert.ok(file.endsWith('.js')); response.setHeader('Content-Type','text/javascript'); response.end(readFileSync(file)); return;
      } catch { /* No arbitrary path or remote resource. */ }
    } response.writeHead(404); response.end();
  });
  server.maxConnections = 16;
  server.on('connection',socket => { const done = new Promise(resolve => socket.once('close',() => { sockets.delete(socket); resolve(); })); sockets.set(socket,done); });
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true }); context = await browser.newContext();
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== origin) { if (foreign.length < 16) foreign.push('blocked-foreign-origin'); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on('pageerror',error => { if (errors.length < 16) errors.push(error.message.slice(0,256)); }); await page.goto(origin);
    const proof = await page.evaluate(nativeRtcPage,{ sdkUrl,runnerUrl }); assert.equal(proof.result,'pass'); assert.deepEqual(errors,[]); assert.deepEqual(foreign,[]);
    return { ...proof, browser: { name:'chromium',version:browser.version() }, sourceSha256:sourcePins, compilerVersion:ts.version, pageErrors:0, foreignRequests:0 };
  } finally {
    await context?.close(); await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]); closed = sockets.size === 0; assert.equal(closed,true);
    for (const [path,pin] of Object.entries(sourcePins)) assert.equal(hash(readFileSync(join(root,path))),pin);
  }
}
try {
  const { runMissingFeatureProducerPrefix } = await import('../examples/runtime-recovery/consumer.mjs');
  const prefix = await runMissingFeatureProducerPrefix(new AbortController().signal);
  let runner; try { runner = await import('../examples/runtime-recovery/runtime-recovery.ts'); } catch { /* Missing runner is an actual feature RED after the native effect. */ }
  assert.equal(typeof runner?.runRuntimeRecoveryQualification, 'function', 'native public producer passes; selected software recovery harness is missing');
  const { runNodeRuntimeRecoveryQualification } = await import('../examples/runtime-recovery/consumer.mjs');
  const trials = [];
  for (const path of ['direct-wss','authenticated-loopback-relay']) {
    const proof = await runNodeRuntimeRecoveryQualification(path, new AbortController().signal);
    assert.equal(proof.sourceClock, 'recovery-source-monotonic'); assert.equal(proof.receiverClock, 'recovery-target-monotonic');
    assert.equal(proof.originClock, 'node-performance.now'); trials.push(proof);
  }
  trials.push(await browserProof());
  const receipt = JSON.stringify({ result: 'pass', profile: runner.RUNTIME_RECOVERY_PROFILE, resolution: producer ? 'new-harness-and-hub-source-with-ordinary-installed-seven-sdk-producer' : 'owned-public-source-barrels',
    producer, nativePrefix:prefix, trials, sourceClosure: Object.fromEntries(actualSource), ownedNativeContexts: 0, physicalInput: false, actualIpLoss: false, installedHubClaim: false }, null, 2);
  assert.ok(Buffer.byteLength(receipt) <= 256 * 1024); console.log(receipt);
} finally { hooks.deregister(); }
