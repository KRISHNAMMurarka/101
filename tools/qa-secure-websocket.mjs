import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Independent application-owned concrete sink. Its grant authorizes these two
// registrations only; TLS, invitation and endpoint enrollment do not grant routes.
function application(sdk, peer, epoch, now, applicationId, sessionId) {
  let position, contact = false, releases = 0, consent = false;
  const descriptor = sdk.pointerSourceDescriptor('independent-wss-application');
  descriptor.id = 'owned-wss-surface';
  for (const capability of descriptor.capabilities) { capability.kind = 'property'; capability.permissions = ['write']; capability.ownership = { mode: 'exclusive' }; }
  let receiver;
  const runtime = sdk.createDeviceRuntime({ now, clockDomain: 'application-clock', authorize(request) {
    if (consent && request.principalId === 'application-owner' && request.applicationId === applicationId && request.sessionId === sessionId &&
      request.source.deviceId === receiver.description()?.id && request.sink.deviceId === descriptor.id && ['position', 'contact'].includes(request.sink.capabilityId))
      return { expiresAt: now() + 60000, maxHz: 60, maxAgeMs: 100 };
  } });
  const sinks = descriptor.capabilities.map(capability => {
    const handle = runtime.registerSink({ device: descriptor, capability: capability.id, apply(observation, context) {
      if (!context.isCurrent()) return;
      if (capability.id === 'position') position = observation.value; else contact = observation.value;
    }, release() { if (capability.id === 'position') position = undefined; else contact = false; releases++; } });
    runtime.setReadiness(handle, 'available'); return { capability, handle };
  });
  receiver = new sdk.RemoteResourceReceiver({ peer, epoch, runtime, now, clockId: 'application-clock', principalId: 'application-owner', applicationId, sessionId });
  return { receiver, select() {
    if (!receiver.description()) return false; consent = true;
    return sinks.every(({ capability, handle }) => receiver.approve({ capability: capability.id, sink: handle, sinkDevice: descriptor, sinkCapability: capability.id,
      codec: capability.id === 'position' ? 'normalized-pointer/1' : 'json/1', grant: { expiresAt: now() + 60000, maxHz: 60, maxAgeMs: 100 } }) !== undefined);
  }, tick() { receiver.tick(); }, state() { return { position, contact, releases, described: !!receiver.description(), receiver: receiver.status() }; },
  stop() { receiver.stop(); runtime.close(); } };
}

export async function runSecureWebSocketBrowserChecks({ consumerDirectory }) {
  const consumer = realpathSync(consumerDirectory), work = mkdtempSync(join(tmpdir(), '101-wss-browser-'));
  const receiptPath = join(work, 'receipt.json');
  const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
  const sourceSha256 = Object.fromEntries(['packages/transport-websocket/src/ports.ts', 'packages/transport-websocket/src/peer.ts',
    'packages/device-web/src/authenticated-peer.ts', 'examples/device-pipelines/secure-websocket.ts', 'tools/qa-secure-websocket.mjs'].map(path => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', path); return [path, existsSync(file) ? digest(readFileSync(file)) : null];
  }));
  const artifactSha256 = {};
  for (const name of names) {
    const directory = join(consumer, 'node_modules', '@101', name), manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.exports['.'].import, './dist/index.js');
    artifactSha256[`@101/${name}`] = digest(readFileSync(join(directory, 'dist/index.js')));
  }
  const key = join(work, 'leaf.key'), cert = join(work, 'leaf.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=101 disposable localhost WSS', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, 'owned disposable TLS certificate generation');
  symlinkSync(join(consumer, 'node_modules'), join(work, 'node_modules'), 'dir');
  const wsEntry = pathToFileURL(join(dirname(require.resolve('ws')), 'wrapper.mjs')).href;
  const hostFile = join(work, 'independent-application.mjs');
  writeFileSync(hostFile, `
import * as sdk from '@101/connect';
import { createSecureWebSocketPeer } from '@101/connect/examples/secure-websocket';
import WebSocket, { WebSocketServer } from ${JSON.stringify(wsEntry)};
import { createServer } from 'node:https';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const application = ${application.toString()};
const consumer = ${JSON.stringify(consumer)}, key = ${JSON.stringify(key)}, cert = ${JSON.stringify(cert)};
const identity = await sdk.createEphemeralWebIdentity();
const now = () => performance.now(); let config, active, endpoint, origin, provider, surface, socket, timer, observedMaxBuffer = 0;
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
  const path = new URL(request.url, origin).pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Independent local WSS app</title><main><button id="stop">Stop</button><div id="surface" style="width:400px;height:200px;position:relative;border:1px solid"><i id="pointer" style="position:absolute;width:8px;height:8px;background:black"></i></div><output id="status"></output></main>'); return; }
  if (!path.startsWith('/sdk/')) { response.writeHead(404); response.end(); return; }
  const file = resolve(consumer, 'node_modules/@101', decodeURIComponent(path.slice(5)));
  try {
    const actual = realpathSync(file), within = relative(resolve(consumer, 'node_modules/@101'), actual);
    if (within.startsWith('..') || !actual.endsWith('.js')) throw new Error();
    response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(actual));
  } catch { response.writeHead(404); response.end(); }
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 + 39,
  handleProtocols(protocols) { return protocols.has(sdk.WSS_SUBPROTOCOL) ? sdk.WSS_SUBPROTOCOL : false; } });
server.on('upgrade', (request, rawSocket, head) => {
  if (request.socket.encrypted !== true || request.headers.origin !== origin || !['/connect', '/tls-probe'].includes(request.url) ||
    request.headers['sec-websocket-protocol'] !== sdk.WSS_SUBPROTOCOL) { rawSocket.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n'); return; }
  wss.handleUpgrade(request, rawSocket, head, connection => wss.emit('connection', connection, request));
});
function retire() { if (timer) clearInterval(timer); timer = undefined; provider?.stop(); surface?.stop(); active?.stop(); provider = surface = active = socket = undefined; }
wss.on('connection', (connection, request) => {
  if (request.url === '/tls-probe') { connection.close(); return; }
  if (!config || active) { connection.close(); return; }
  socket = connection;
  const port = { get readyState() { return connection.readyState; }, get protocol() { return connection.protocol; }, get bufferedAmount() { return connection.bufferedAmount; },
    get binaryType() { return connection.binaryType; }, set binaryType(value) { connection.binaryType = value; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(value) { connection.send(value); observedMaxBuffer = Math.max(observedMaxBuffer, connection.bufferedAmount); }, close() { connection.close(); } };
  connection.on('message', (data, binary) => port.onmessage?.({ data: binary ? (data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer) : data.toString() }));
  connection.on('close', () => port.onclose?.({})); connection.on('error', () => port.onerror?.({}));
  active = createSecureWebSocketPeer({ transport: { side: 'server', socket: port, endpoint, now }, identity, epoch: config.epoch,
    applicationId: config.applicationId, sessionId: config.sessionId, role: config.role, now, timeoutMs: 10000 });
  if (config.role === 'receiver') surface = application(sdk, active.peer, config.epoch, now, config.applicationId, config.sessionId);
  else provider = new sdk.PointerResourceProvider({ peer: active.peer, epoch: config.epoch, clockId: 'node-source-clock', now, platform: 'local-node-generated-input', available: () => true });
  void active.start(); timer = setInterval(() => { active?.tick(); provider?.tick(); surface?.tick(); }, 5);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = 'https://127.0.0.1:' + server.address().port; endpoint = origin.replace('https:', 'wss:') + '/connect';
process.send({ ready: true, origin, endpoint, keyId: identity.keyId });
process.on('message', async ({ id, action, payload }) => {
  try {
    let result;
    if (action === 'prepare') { retire(); config = payload; result = true; }
    else if (action === 'summary') result = { auth: active?.peer.status(), scope: !!sdk.authenticatedPeerScope(active?.peer), transport: active?.transport.status(),
      surface: surface?.state(), provider: provider?.status(), binding: active?.transport.sessionBinding() ? { endpoint: active.transport.sessionBinding().endpoint, limits: active.transport.sessionBinding().limits } : undefined, observedMaxBuffer };
    else if (action === 'enroll') result = active?.peer.confirmEnrollment(payload);
    else if (action === 'select') result = surface?.select();
    else if (action === 'nudge') result = provider?.driver()?.nudge(payload.x, payload.y);
    else if (action === 'contact') result = provider?.driver()?.setContact(payload);
    else if (action === 'pause') { socket.pause(); result = true; }
    else if (action === 'resume') { socket.resume(); result = true; }
    else if (action === 'loss') { socket.terminate(); result = true; }
    else if (action === 'tls') {
      result = await new Promise(resolve => {
        const client = new WebSocket(origin.replace('https:', 'wss:') + '/tls-probe', sdk.WSS_SUBPROTOCOL,
          { headers: { Origin: origin }, ...(payload.ca ? { ca: readFileSync(cert) } : {}), ...(payload.wrongHost ? { servername: 'wrong.invalid' } : {}), handshakeTimeout: 2000, followRedirects: false });
        client.on('open', () => { client.close(); resolve({ open: true }); }); client.on('error', error => resolve({ open: false, code: error.code }));
      });
    } else if (action === 'shutdown') { retire(); for (const client of wss.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); result = true; }
    else throw new Error('unknown action');
    process.send({ id, result }); if (action === 'shutdown') process.exit(0);
  } catch { process.send({ id, failure: 'local-runtime-check-failed' }); }
});
`);
  const host = spawn(process.execPath, [hostFile], { cwd: work, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let hostErrors = '', requestId = 0, browser, context;
  host.stderr.on('data', chunk => { hostErrors += String(chunk); });
  const pending = new Map();
  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('local WSS runtime startup timeout')), 10000);
    host.on('message', message => { if (message.ready) { clearTimeout(timeout); resolve(message); }
      else { const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); if (message.failure) waiter.reject(new Error(message.failure)); else waiter.resolve(message.result); } } });
    host.once('exit', () => { clearTimeout(timeout); reject(new Error('local WSS runtime exited during startup')); });
  });
  function rpc(action, payload) { return new Promise((resolve, reject) => {
    const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`local ${action} timeout`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); host.send({ id, action, payload });
  }); }
  const receipt = { scope: 'direct disposable localhost TLS; actual Node SDK application/provider and native Chromium WebSocket SDK caller; generated input, no phones/relay/global compatibility',
    browserCertificateTrust: 'isolated Playwright localhost certificate exception; separate Node CA and hostname validation checks', consumer, work, node: process.version,
    sourceSha256, artifactSha256, checks: [], trials: [] };
  const errors = [];
  let stage = 'startup';
  try {
    const info = await started;
    stage = 'real TLS validation';
    assert.deepEqual(await rpc('tls', { ca: true }), { open: true }); receipt.checks.push('owned CA validated WSS succeeds');
    const untrusted = await rpc('tls', {}); assert.equal(untrusted.open, false); assert.equal(untrusted.code, 'DEPTH_ZERO_SELF_SIGNED_CERT'); receipt.checks.push('untrusted TLS fails before SDK negotiation');
    const wrongHost = await rpc('tls', { ca: true, wrongHost: true }); assert.equal(wrongHost.open, false); assert.equal(wrongHost.code, 'ERR_TLS_CERT_ALTNAME_INVALID'); receipt.checks.push('trusted CA with wrong hostname fails');
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(info.origin);
    const importMap = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
    importMap['@101/connect/examples/secure-websocket'] = '/sdk/connect/examples/secure-websocket.js';
    await page.addScriptTag({ type: 'importmap', content: JSON.stringify({ imports: importMap }) });
    async function begin(role, wrongKey = false) {
      const scope = { epoch: crypto.randomUUID().replaceAll('-', ''), applicationId: 'independent-wss-pointer', sessionId: crypto.randomUUID() };
      await rpc('prepare', { ...scope, role: role === 'source' ? 'receiver' : 'source' });
      await page.evaluate(async ({ endpoint, scope, role, wrongKey, applicationSource }) => {
        globalThis.trial?.stop();
        const sdk = await import('@101/connect'), { createSecureWebSocketPeer } = await import('@101/connect/examples/secure-websocket');
        const identity = await sdk.createEphemeralWebIdentity(), now = () => performance.now();
        const owned = createSecureWebSocketPeer({ transport: { endpoint, side: 'client', now },
          identity, ...scope, role, now, timeoutMs: 10000, expectedRemoteKeyId: wrongKey ? '0'.repeat(64) : undefined });
        const makeApplication = (0, eval)(`(${applicationSource})`);
        const app = role === 'receiver' ? makeApplication(sdk, owned.peer, scope.epoch, now, scope.applicationId, scope.sessionId) : undefined;
        const provider = role === 'source' ? new sdk.PointerResourceProvider({ peer: owned.peer, epoch: scope.epoch, clockId: 'browser-source-clock', now,
          platform: 'local-browser-generated-input', available: () => true }) : undefined;
        const timer = setInterval(() => { owned.tick(); provider?.tick(); app?.tick(); if (app?.state().position) {
          const position = app.state().position, surface = document.querySelector('#surface').getBoundingClientRect(), pointer = document.querySelector('#pointer');
          pointer.style.left = position.x * surface.width + 'px'; pointer.style.top = position.y * surface.height + 'px';
        } }, 5);
        let width = 400, height = 200;
        globalThis.trial = { owned, app, provider, scope, sdk, role,
          summary() { return { auth: owned.peer.status(), scope: !!sdk.authenticatedPeerScope(owned.peer), app: app?.state(), provider: provider?.status(),
            bytes: owned.transport.status().bufferedBytes, transport: owned.transport.status(), geometry: { width, height } }; },
          resize(w, h) { width = w; height = h; const surface = document.querySelector('#surface'); surface.style.width = w + 'px'; surface.style.height = h + 'px'; },
          stop() { clearInterval(timer); provider?.stop(); app?.stop(); owned.stop(); },
        };
        document.querySelector('#stop').onclick = () => globalThis.trial.stop();
        await owned.start();
      }, { endpoint: info.endpoint, scope, role, wrongKey, applicationSource: application.toString() });
    }
    async function summary() { return { node: await rpc('summary'), browser: await page.evaluate(() => globalThis.trial.summary()) }; }
    async function until(predicate, label) {
      const start = performance.now(); let current;
      while (performance.now() - start < 10000) { current = await summary(); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error(`${label}: ${JSON.stringify(current)}`);
    }
    stage = 'wrong endpoint key'; await begin('source', true);
    await until(value => value.browser.auth.phase === 'stopped', 'wrong pin rejection');
    assert.equal((await summary()).browser.scope, false); receipt.checks.push('wrong pinned endpoint has zero resource authority');
    stage = 'Node application receiver'; await begin('source');
    const waiting = await until(value => value.node.auth?.phase === 'awaiting-enrollment' && value.browser.auth.phase === 'awaiting-enrollment', 'bilateral proof');
    assert.equal(waiting.node.auth.comparisonDigest, waiting.browser.auth.comparisonDigest);
    assert.equal(waiting.node.surface.described, false); assert.equal(waiting.browser.provider.ready, false);
    await rpc('enroll', waiting.node.auth.comparisonDigest);
    assert.equal((await summary()).browser.scope, false); receipt.checks.push('unilateral enrollment leaves resources closed');
    await page.evaluate(digest => globalThis.trial.owned.peer.confirmEnrollment(digest), waiting.browser.auth.comparisonDigest);
    await until(value => value.node.surface.described, 'description'); assert.equal(await rpc('select'), true);
    await until(value => value.browser.provider.ready && !!value.node.surface.position, 'explicit grant and mapped clock');
    await page.evaluate(() => { globalThis.trial.provider.driver().nudge(0.2, -0.3); globalThis.trial.provider.driver().setContact(true); });
    const first = await until(value => value.node.surface.contact && Math.abs(value.node.surface.position.x - 0.7) < 0.001, 'forward pointer');
    assert.ok(Math.abs(first.node.surface.position.y - 0.2) < 0.001); receipt.checks.push('browser provider reaches independently authorized Node application over real TLS');
    stage = 'actual browser socket backpressure';
    const saturation = await page.evaluate(() => {
      const trial = globalThis.trial, data = new Uint8Array(1024); let accepted = 0;
      while (accepted < 1000 && trial.owned.transport.send('disposable', data)) accepted++;
      const latestBytes = trial.owned.transport.status().bufferedBytes, reliable = trial.owned.transport.send('reliable', 'release-headroom');
      return { accepted, latestBytes, reliable, finalBytes: trial.owned.transport.status().bufferedBytes, pending: trial.owned.transport.status().pending, limits: trial.owned.transport.sessionBinding().limits };
    });
    assert.ok(saturation.accepted > 0 && saturation.accepted < 1000); assert.ok(saturation.latestBytes <= saturation.limits.latestBufferLimit);
    assert.equal(saturation.reliable, true); assert.ok(saturation.finalBytes <= saturation.limits.reliableBufferLimit); assert.equal(saturation.pending, 0);
    receipt.trials.push({ name: 'native browser bufferedAmount admission', ...saturation });
    stage = 'paused actual WSS receiver'; await rpc('pause');
    await page.evaluate(() => { globalThis.trial.provider.driver().nudge(-0.3, 0.2); globalThis.trial.provider.driver().setContact(true); });
    await new Promise(resolve => setTimeout(resolve, 700));
    const silent = await summary(); assert.equal(silent.node.surface.contact, false); assert.equal(silent.node.surface.position, undefined);
    await rpc('resume'); await new Promise(resolve => setTimeout(resolve, 100));
    const late = await summary(); assert.equal(late.node.surface.contact, false); assert.equal(late.node.surface.position, undefined);
    receipt.checks.push('real paused WSS receive releases held state; delayed interactive bytes cannot restore retired routes');
    receipt.trials.push({ name: 'deadline and silence release', contact: late.node.surface.contact, releases: late.node.surface.releases });
    stage = 'replacement and reverse independent application'; await begin('receiver');
    const replacement = await until(value => value.node.auth?.phase === 'awaiting-enrollment' && value.browser.auth.phase === 'awaiting-enrollment', 'replacement proof');
    assert.equal(replacement.browser.scope, false); assert.equal(replacement.browser.app.described, false);
    await rpc('enroll', replacement.node.auth.comparisonDigest);
    await page.evaluate(digest => globalThis.trial.owned.peer.confirmEnrollment(digest), replacement.browser.auth.comparisonDigest);
    await until(value => value.browser.app.described, 'browser receiver description');
    assert.equal(await page.evaluate(() => globalThis.trial.app.select()), true);
    await until(value => value.node.provider.ready && !!value.browser.app.position, 'reverse resource grant');
    await rpc('nudge', { x: -0.2, y: 0.3 }); await rpc('contact', true);
    const reverse = await until(value => value.browser.app.contact && Math.abs(value.browser.app.position.x - 0.3) < 0.001, 'reverse pointer');
    assert.ok(Math.abs(reverse.browser.app.position.y - 0.8) < 0.001);
    await page.evaluate(() => globalThis.trial.resize(200, 400));
    await page.waitForFunction(() => parseFloat(document.querySelector('#pointer').style.left) < 62 && parseFloat(document.querySelector('#pointer').style.top) > 318);
    receipt.checks.push('fresh replacement re-enrolls and re-grants; independent browser app renders opposite diagonal and current geometry');
    await rpc('contact', false); await until(value => !value.browser.app.contact, 'reliable contact release');
    await rpc('contact', true); await until(value => value.browser.app.contact, 'held state before loss'); await rpc('loss');
    const lost = await until(value => !value.browser.scope && !value.browser.app.contact && value.browser.app.position === undefined, 'loss releases routes');
    receipt.trials.push({ name: 'loss releases and revokes', releases: lost.browser.app.releases, scope: lost.browser.scope });
    assert.deepEqual(errors, []); receipt.checks.push('zero browser page errors');
    receipt.browser = { name: 'chromium', version: browser.version() }; receipt.status = 'pass';
  } catch (error) { receipt.status = 'fail'; receipt.stage = stage; receipt.failure = String(error.message).replace(/[0-9a-f]{32,}/g, '[redacted]'); receipt.pageErrors = errors; throw error; }
  finally {
    if (context) await context.close(); if (browser) await browser.close();
    if (host.connected) { try { await rpc('shutdown'); } catch { host.kill('SIGTERM'); } }
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('owned harness stopped')); } pending.clear();
    if (hostErrors) receipt.hostErrors = hostErrors.replace(/[0-9a-f]{32,}/g, '[redacted]');
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  }
  return { status: receipt.status, receiptPath, checks: receipt.checks, trials: receipt.trials };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass an installed external SDK consumer directory');
  console.log(JSON.stringify(await runSecureWebSocketBrowserChecks({ consumerDirectory: process.argv[2] }), null, 2));
}
