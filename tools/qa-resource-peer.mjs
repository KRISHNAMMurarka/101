import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'chromium';
const browserType = { chromium, firefox, webkit }[name];
if (!browserType) throw new Error('Expected chromium, firefox or webkit');
const aliases = Object.fromEntries(['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc']
  .map(value => [`@101/${value}`, resolve(root, `packages/${value}/src/index.ts`)]));
const modules = new Map(), fingerprints = {};
function modulePath(path) { return `/modules/${relative(root, path).replaceAll('\\', '/')}`; }
function collect(path) {
  const key = modulePath(path); if (modules.has(key)) return key;
  const source = readFileSync(path, 'utf8'); modules.set(key, '');
  fingerprints[relative(root, path)] = createHash('sha256').update(source).digest('hex');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const transformed = code.replace(/((?:from\s*|import\s*)['"])([^'"]+)(['"])/g, (_match, before, specifier, after) => {
    const dependency = aliases[specifier] ?? (specifier.startsWith('.') ? resolve(dirname(path), specifier) : undefined);
    if (!dependency || !dependency.startsWith(`${root}/packages/`) && !dependency.startsWith(`${root}/examples/`)) throw new Error(`Unexpected QA dependency ${specifier}`);
    return before + collect(dependency) + after;
  });
  modules.set(key, transformed); return key;
}
const entry = collect(resolve(root, 'examples/device-pipelines/remote-pointer.ts'));
const facade = collect(resolve(root, 'packages/connect/src/index.ts'));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (modules.has(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(modules.get(path)); }
  else if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Local typed resource qualification</title>'); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserType.launch({ headless: true });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ entry, facade }) => {
    const { createRemotePointerSurface, pointerSourceDescriptor } = await import(entry);
    const { PeerDataTransport, RemoteResourcePublisher } = await import(facade);
    const host = new PeerDataTransport({ initiator: true }), phone = new PeerDataTransport({ initiator: false });
    const epoch = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
    let surface, publisher;
    const states = [], packetShapes = [];
    host.onData((lane, data) => packetShapes.push({ lane, encoding: typeof data === 'string' ? 'JSON' : 'binary', bytes: typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength }));
    const waitFor = async condition => {
      const started = performance.now();
      while (!condition()) {
        if (performance.now() - started > 10000) throw new Error(`Typed loopback timed out: ${JSON.stringify({ peers: [host.state, phone.state], receiver: surface?.receiver.status(), publisher: publisher?.status() })}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    let timer;
    try {
      await host.acceptAnswer(await phone.acceptOffer(await host.createOffer()));
      await waitFor(() => [host, phone].every(peer => peer.isOpen('reliable') && peer.isOpen('disposable')));
      surface = createRemotePointerSurface({ authentication: 'local-diagnostic', peer: host, epoch, principalId: 'loopback-owner', applicationId: 'independent-pointer', sessionId: 'local-runtime-harness',
        clockId: 'surface-clock', now: () => performance.now(), width: 400, height: 200 });
      publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: phone, epoch, device: pointerSourceDescriptor(), clockId: 'source-clock', now: () => performance.now(), available: () => true });
      timer = setInterval(() => { publisher.tick(); surface.tick(); }, 5);
      if (!publisher.start()) throw new Error('Provider description was not admitted');
      await waitFor(() => surface.receiver.description() && surface.receiver.status().clockReady);
      if (!surface.select()) throw new Error('Owner-approved pointer profiles rejected');
      await waitFor(() => surface.receiver.status().active === 2);
      const sample = async (position, contact) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (!publisher.publish('position', position) || !publisher.publish('contact', contact)) throw new Error('Typed state admission failed');
        await waitFor(() => surface.state().position && Math.abs(surface.state().position.x - position.x * 400) < 0.0001 && surface.state().contact === contact);
        states.push(surface.state());
      };
      await sample({ x: 0.2, y: 0.8 }, true); await sample({ x: 0.8, y: 0.2 }, false);
      surface.resize(1000, 500); const resized = surface.state();
      await host.disconnect(); await phone.disconnect();
      const afterLoss = surface.state(), receiver = surface.receiver.status(), provider = publisher.status();
      return { states, resized, afterLoss, receiver, provider, packetShapes,
        supportedSemantics: pointerSourceDescriptor().capabilities.map(capability => capability.semantic), userAgent: navigator.userAgent };
    } finally { clearInterval(timer); surface?.stop(); publisher?.stop(); await host.disconnect(); await phone.disconnect(); }
  }, { entry, facade });
  assert.deepEqual(result.states.map(value => value.contact), [true, false]);
  assert.ok(Math.abs(result.resized.position.x - 800) < 0.0001 && Math.abs(result.resized.position.y - 100) < 0.0001);
  assert.equal(result.afterLoss.position, undefined); assert.equal(result.afterLoss.contact, false); assert.equal(result.afterLoss.releases, 2);
  assert.equal(result.receiver.active, 0); assert.equal(result.provider.active, 0);
  assert.ok(result.packetShapes.some(packet => packet.lane === 'disposable' && packet.encoding === 'binary' && packet.bytes === 48));
  console.log(JSON.stringify({ scope: 'local real-browser WebRTC typed application pointer/contact, owner-approved embedded sinks, clock exchange, resize and loss; synthetic provider values, no physical/native/global identity proof',
    browser: name, version: browser.version(), sourceSha256: fingerprints, environment: { node: process.versions.node, playwright: '1.61.1' }, result }, null, 2));
} finally { await browser?.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
