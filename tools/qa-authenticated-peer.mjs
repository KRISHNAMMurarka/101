import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.argv[2] ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
if (!browserType) throw new Error('Expected chromium, firefox or webkit');
const aliases = Object.fromEntries(['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc']
  .map(name => [`@101/${name}`, resolve(root, `packages/${name}/src/index.ts`)]));
const modules = new Map(), sourceSha256 = {};
function collect(path) {
  const route = `/modules/${relative(root, path).replaceAll('\\', '/')}`;
  if (modules.has(route)) return route;
  const source = readFileSync(path, 'utf8');
  sourceSha256[relative(root, path)] = createHash('sha256').update(source).digest('hex');
  modules.set(route, '');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const file = ts.createSourceFile(path, javascript, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const imports = [];
  function visit(node) {
    const staticModule = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    const dynamicModule = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0];
    const specifier = staticModule || dynamicModule;
    if (specifier && ts.isStringLiteral(specifier)) imports.push({ start: specifier.getStart(file) + 1,
      end: specifier.getEnd() - 1, value: specifier.text });
    ts.forEachChild(node, visit);
  }
  visit(file);
  let rewritten = javascript;
  for (const specifier of imports.sort((a, b) => b.start - a.start)) {
    const dependency = aliases[specifier.value] ?? (specifier.value.startsWith('.') ? resolve(dirname(path), specifier.value) : undefined);
    if (!dependency || !dependency.startsWith(`${root}/packages/`) && !dependency.startsWith(`${root}/examples/`)) {
      throw new Error(`Unexpected authenticated QA import ${path}: ${specifier.value}`);
    }
    rewritten = rewritten.slice(0, specifier.start) + collect(dependency) + rewritten.slice(specifier.end);
  }
  modules.set(route, rewritten);
  return route;
}
const entries = {
  transport: collect(resolve(root, 'packages/transport-webrtc/src/index.ts')),
  auth: collect(resolve(root, 'packages/device-web/src/authenticated-peer.ts')),
  identity: collect(resolve(root, 'packages/device-web/src/web-identity.ts')),
  provider: collect(resolve(root, 'packages/device-web/src/pointer-provider.ts')),
  surface: collect(resolve(root, 'examples/device-pipelines/remote-pointer.ts')),
  wire: collect(resolve(root, 'packages/device-web/src/wire.ts')),
};
for (const [path, hash] of Object.entries(sourceSha256)) {
  if (createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex') !== hash) throw new Error('QA sources changed while collecting; wait for a coherent candidate');
}
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (modules.has(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(modules.get(path)); }
  else if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Local authenticated endpoint qualification</title>'); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let stage = 'browser startup', currentTrial;
const checks = [], trials = [];
const qualificationScope = 'local real-browser two-page independent persisted endpoint keys; actual WebRTC transcript proof, bilateral owner comparison, application owner pointer selection, generated pointer/contact delivery and loss release; no UI, physical input, native signature or account identity qualification';
function receipt(result) {
  sourceSha256['tools/qa-authenticated-peer.mjs'] = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  console.log(JSON.stringify({ scope: qualificationScope, browser: engine, version: browser?.version(), node: process.versions.node,
    playwright: '1.61.1', sourceSha256, checks, trials, ...result }, null, 2));
}
try {
  browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all(pages.map(page => page.goto(origin)));
  const databaseBase = `101-authenticated-qa-${crypto.randomUUID()}`;
  const databases = [`${databaseBase}-receiver`, `${databaseBase}-source`];
  stage = 'independent identity creation and reload';
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], databaseName = databases[index];
    const expectedId = await page.evaluate(async ({ entry, databaseName }) => {
      const { createWebCryptoIdentityStore } = await import(entry), store = createWebCryptoIdentityStore({ databaseName });
      try {
        if (await store.load() !== undefined) throw new Error('Endpoint load unexpectedly created a key');
        return (await store.create()).keyId;
      } finally { store.close(); }
    }, { entry: entries.identity, databaseName });
    await page.reload();
    const reloaded = await page.evaluate(async ({ entry, databaseName, expectedId }) => {
      const { createWebCryptoIdentityStore, webEndpointCrypto } = await import(entry), store = createWebCryptoIdentityStore({ databaseName });
      try {
        const identity = await store.load();
        if (!identity || identity.keyId !== expectedId) return false;
        const message = new TextEncoder().encode('reloaded endpoint browser proof');
        return await webEndpointCrypto.verify(identity.publicKey, message, await identity.sign(message));
      } finally { store.close(); }
    }, { entry: entries.identity, databaseName, expectedId });
    assert.equal(reloaded, true, 'independent page reload preserves an actual signing key');
    checks.push(`${index === 0 ? 'receiver' : 'source'} persisted identity survives page reload`);
  }

  async function begin(name, { wrongApplication = false, wrongSession = false, tamperedAnswer = false } = {}) {
    currentTrial = name; stage = 'pending scoped peer and resource constructors';
    const epoch = crypto.randomUUID().replaceAll('-', '');
    await Promise.all(pages.map((page, index) => page.evaluate(async ({ entries, databaseName, role, epoch, applicationId, sessionId }) => {
      const [{ PeerDataTransport }, { AuthenticatedResourcePeer, authenticatedPeerScope, authenticatedPeerExpectedScope }, { createWebCryptoIdentityStore, webEndpointCrypto },
        { PointerResourceProvider, pointerSourceDescriptor }, { createRemotePointerSurface }, { encodePacket, decodePacket }] = await Promise.all([
        import(entries.transport), import(entries.auth), import(entries.identity), import(entries.provider), import(entries.surface), import(entries.wire),
      ]);
      const store = createWebCryptoIdentityStore({ databaseName }), identity = await store.load();
      if (!identity) throw new Error('Explicitly created endpoint identity was lost');
      const now = () => performance.now(), raw = new PeerDataTransport({ initiator: role === 'receiver' });
      const auth = new AuthenticatedResourcePeer({ transport: raw, identity, crypto: webEndpointCrypto, epoch, applicationId, sessionId, role, now, timeoutMs: 10000 });
      const expected = authenticatedPeerExpectedScope(auth);
      if (!expected || expected.epoch !== epoch || expected.applicationId !== applicationId || expected.sessionId !== sessionId || expected.role !== role) throw new Error('Issued pending peer did not retain locally expected scope');
      let surface, provider;
      if (role === 'receiver') surface = createRemotePointerSurface({ peer: auth, epoch, principalId: 'qa:surface-owner', applicationId, sessionId,
        clockId: 'qa:receiver-clock', now, width: 400, height: 200 });
      else provider = new PointerResourceProvider({ peer: auth, epoch, clockId: 'qa:source-clock', now, platform: 'local-browser-generated-input', available: () => true });
      const packetShapes = [];
      let rawApplications = 0, deliveredApplications = 0, timer;
      raw.onData((lane, data) => {
        const decoded = decodePacket(data, lane);
        if (decoded) { rawApplications++; packetShapes.push({ lane, type: decoded.packet.type, encoding: typeof data === 'string' ? 'JSON' : 'binary',
          bytes: typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength }); }
      });
      auth.onData((lane, data) => { if (decodePacket(data, lane)) deliveredApplications++; });
      function scopeCurrent() {
        const scope = authenticatedPeerScope(auth);
        return !!scope && scope.epoch === epoch && scope.applicationId === applicationId && scope.sessionId === sessionId
          && scope.role === role && scope.localKeyId !== scope.remoteKeyId;
      }
      function summary() { const status = auth.status(); return { phase: status.phase, reason: status.reason, rawState: raw.state,
        reliable: raw.isOpen('reliable'), disposable: raw.isOpen('disposable'), rawApplications, deliveredApplications,
        described: !!surface?.receiver.description(), receiver: surface?.receiver.status(), provider: provider?.status(), scopeCurrent: scopeCurrent() }; }
      async function waitFor(condition, label) {
        const start = performance.now();
        while (!condition()) {
          if (performance.now() - start >= 10000) throw new Error(`${label}: ${JSON.stringify(summary())}`);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      const descriptor = encodePacket({ protocol: 'connect', version: 1, epoch, type: 'describe', clockId: 'qa:source-clock',
        device: pointerSourceDescriptor('local-browser-generated-input'), codecs: ['json/1', 'normalized-pointer/1'] });
      const sample = encodePacket({ protocol: 'connect', version: 1, epoch, type: 'sample', slot: 1, sequence: 1,
        capturedAt: now(), value: { x: 0.9, y: 0.1 } }, 'normalized-pointer/1');
      globalThis.authenticatedQa = { raw, auth, store, identity, surface, provider, descriptor, sample, waitFor, summary, scopeCurrent, packetShapes,
        start() { timer = setInterval(() => { auth.tick(); surface?.tick(); provider?.tick(); }, 5); },
        async close() { clearInterval(timer); provider?.stop(); surface?.stop(); auth.stop(); await raw.disconnect(); store.close(); },
      };
      if (authenticatedPeerScope({ epoch, applicationId, sessionId, role }) !== undefined) throw new Error('Copied scope minted authenticated provenance');
    }, { entries, databaseName: databases[index], role: index === 0 ? 'receiver' : 'source', epoch,
      applicationId: index === 1 && wrongApplication ? 'qa:other-application' : 'qa:pointer-application',
      sessionId: index === 1 && wrongSession ? 'qa:other-session' : 'qa:owner-session' })));
    // SDP remains in local controller memory and is deliberately omitted from every receipt.
    stage = 'offer gathering';
    const offer = await pages[0].evaluate(() => globalThis.authenticatedQa.raw.createOffer());
    stage = 'answer gathering';
    const answer = await pages[1].evaluate(offer => globalThis.authenticatedQa.raw.acceptOffer(offer), offer);
    const acceptedAnswer = tamperedAnswer ? { ...answer, sdp: answer.sdp.replace('m=application', 'a=x-101-qa:changed-transcript\r\nm=application') } : answer;
    stage = 'remote answer application';
    await pages[0].evaluate(answer => globalThis.authenticatedQa.raw.acceptAnswer(answer), acceptedAnswer);
    stage = 'raw two-page data channel readiness';
    await Promise.all(pages.map(page => page.evaluate(async () => { const qa = globalThis.authenticatedQa;
      await qa.waitFor(() => qa.raw.isOpen('reliable') && qa.raw.isOpen('disposable'), 'Raw two-page transport did not open'); })));
    stage = 'pre-auth application packet rejection';
    const preAuth = await pages[1].evaluate(() => { const qa = globalThis.authenticatedQa;
      return { descriptor: qa.auth.send('reliable', qa.descriptor), sample: qa.auth.send('disposable', qa.sample),
        rawDescriptor: qa.raw.send('reliable', qa.descriptor), rawSample: qa.raw.send('disposable', qa.sample), driverAbsent: qa.provider.driver() === undefined }; });
    assert.deepEqual(preAuth, { descriptor: false, sample: false, rawDescriptor: true, rawSample: true, driverAbsent: true });
    const premature = await pages[0].evaluate(async () => { const qa = globalThis.authenticatedQa;
      await qa.waitFor(() => qa.summary().rawApplications >= 2, 'Premature raw packets did not reach receiver');
      return { dropped: qa.summary().deliveredApplications === 0, described: !!qa.surface.receiver.description(), state: qa.surface.state(), scope: qa.scopeCurrent() }; });
    assert.equal(premature.dropped, true); assert.equal(premature.described, false); assert.equal(premature.scope, false);
    assert.deepEqual(premature.state, { contact: false, releases: 0, position: undefined });
    checks.push(`${name}: pre-auth descriptor/sample admission blocked and raw premature packets dropped`);
    stage = 'endpoint authentication handshake';
    await Promise.all(pages.map(page => page.evaluate(() => globalThis.authenticatedQa.start())));
  }

  async function closeTrial() { await Promise.all(pages.map(page => page.evaluate(() => globalThis.authenticatedQa?.close()))); }
  async function negative(name, options) {
    try {
      await begin(name, options);
      stage = 'reject invalid endpoint scope or proof';
      const result = await Promise.all(pages.map(page => page.evaluate(async () => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => qa.auth.status().phase === 'stopped', 'Invalid authentication was not rejected');
        const status = qa.summary(); return { phase: status.phase, reason: status.reason, scopeAbsent: !status.scopeCurrent,
          appAdmission: qa.auth.send('reliable', qa.descriptor), samplesAbsent: qa.surface ? qa.surface.state().position === undefined && !qa.surface.state().contact : qa.provider.driver() === undefined,
          deliveredApplications: status.deliveredApplications }; })));
      for (const value of result) { assert.equal(value.phase, 'stopped'); assert.equal(value.scopeAbsent, true); assert.equal(value.appAdmission, false);
        assert.equal(value.samplesAbsent, true); assert.equal(value.deliveredApplications, 0); }
      trials.push({ name, expected: 'RED authentication', result });
    } finally { await closeTrial(); }
  }
  await negative('wrong expected application', { wrongApplication: true });
  await negative('wrong expected session', { wrongSession: true });
  await negative('tampered accepted answer SDP', { tamperedAnswer: true });

  async function positive(loss) {
    const name = `valid owner enrollment, ${loss}`;
    try {
      await begin(name);
      stage = 'mutual endpoint proof';
      const digests = await Promise.all(pages.map(page => page.evaluate(async () => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => qa.auth.status().phase === 'awaiting-enrollment', 'Actual endpoint proof did not verify');
        if (qa.auth.confirmEnrollment('0'.repeat(64))) throw new Error('Incorrect comparison digest enrolled endpoint');
        return qa.auth.status().comparisonDigest; })));
      assert.equal(typeof digests[0] === 'string' && digests[0].length === 64 && digests[0] === digests[1], true, 'both pages compare the same authenticated transcript');
      stage = 'bilateral owner comparison';
      assert.equal(await pages[0].evaluate(digest => globalThis.authenticatedQa.auth.confirmEnrollment(digest), digests[0]), true);
      const unilateral = await pages[1].evaluate(() => { const qa = globalThis.authenticatedQa; return { phase: qa.auth.status().phase,
        sample: qa.auth.send('disposable', qa.sample), scopeAbsent: !qa.scopeCurrent(), driverAbsent: qa.provider.driver() === undefined }; });
      assert.deepEqual(unilateral, { phase: 'awaiting-enrollment', sample: false, scopeAbsent: true, driverAbsent: true });
      assert.equal(await pages[1].evaluate(digest => globalThis.authenticatedQa.auth.confirmEnrollment(digest), digests[1]), true);
      await Promise.all(pages.map(page => page.evaluate(async () => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => qa.auth.status().phase === 'active' && qa.scopeCurrent(), 'Bilateral owner confirmation did not open resource scope'); })));
      stage = 'application owner pointer route selection';
      await pages[0].evaluate(async () => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => qa.surface.receiver.description() && qa.surface.receiver.status().clockReady, 'Authenticated provider description and clock did not arrive');
        if (!qa.surface.select()) throw new Error('Application owner pointer selection failed'); });
      await Promise.all(pages.map((page, index) => page.evaluate(async receiver => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => receiver ? qa.surface.receiver.status().active === 2 : !!qa.provider.driver(), 'Two selected pointer routes did not become ready'); }, index === 0)));
      const states = [];
      stage = 'generated pointer and contact delivery';
      for (const movement of [{ dx: -0.3, dy: 0.3, contact: true, x: 80, y: 160 }, { dx: 0.6, dy: -0.6, contact: false, x: 320, y: 40 }]) {
        await pages[1].evaluate(async ({ dx, dy, contact }) => { const qa = globalThis.authenticatedQa;
          await new Promise(resolve => setTimeout(resolve, 20));
          const driver = qa.provider.driver(); if (!driver) throw new Error('Actual selected pointer driver disappeared');
          driver.nudge(dx, dy); driver.setContact(contact);
        }, movement);
        states.push(await pages[0].evaluate(async ({ x, y, contact }) => { const qa = globalThis.authenticatedQa;
          await qa.waitFor(() => { const state = qa.surface.state(); return state.position && Math.abs(state.position.x - x) < 0.001 && Math.abs(state.position.y - y) < 0.001 && state.contact === contact; }, 'Authenticated pointer sample/contact did not reach owned surface');
          return qa.surface.state();
        }, movement));
      }
      const resized = await pages[0].evaluate(() => { const qa = globalThis.authenticatedQa; qa.surface.resize(1000, 500); return qa.surface.state(); });
      assert.ok(Math.abs(resized.position.x - 800) < 0.001 && Math.abs(resized.position.y - 100) < 0.001);
      await pages[1].evaluate(() => { const driver = globalThis.authenticatedQa.provider.driver(); if (!driver) throw new Error('Selected driver lost before held-contact check'); driver.setContact(true); });
      await pages[0].evaluate(async () => { const qa = globalThis.authenticatedQa; await qa.waitFor(() => qa.surface.state().contact, 'Held contact did not reach surface before loss'); });
      if (loss === 'transport disconnect') await pages[1].evaluate(() => globalThis.authenticatedQa.raw.disconnect());
      else await pages[1].evaluate(() => { const qa = globalThis.authenticatedQa; return qa.store.remove(qa.identity.keyId); });
      stage = 'held resource release after loss';
      const ended = await Promise.all(pages.map((page, index) => page.evaluate(async receiver => { const qa = globalThis.authenticatedQa;
        await qa.waitFor(() => qa.auth.status().phase === 'stopped' && (receiver ? qa.surface.receiver.status().active === 0 : qa.provider.status().stopped), 'Owned resources did not retire after loss');
        const state = qa.surface?.state(); return { phase: qa.auth.status().phase, reason: qa.auth.status().reason, scopeAbsent: !qa.scopeCurrent(),
          lateAdmission: qa.auth.send('reliable', qa.descriptor), receiver: qa.surface?.receiver.status(), provider: qa.provider?.status(),
          state: state ? { positionAbsent: state.position === undefined, contact: state.contact, releases: state.releases } : undefined,
          packetShapes: qa.packetShapes }; }, index === 0)));
      for (const value of ended) { assert.equal(value.scopeAbsent, true); assert.equal(value.lateAdmission, false); }
      assert.deepEqual(ended[0].state, { positionAbsent: true, contact: false, releases: 2 });
      assert.ok(ended[0].packetShapes.some(packet => packet.type === 'sample' && packet.lane === 'disposable' && packet.bytes === 48));
      trials.push({ name, expected: 'GREEN authentication and application routes', matchingOwnerDigest: true,
        unilateralEnrollmentBlocked: true, states, resized, ended });
    } finally { await closeTrial(); }
  }
  await positive('transport disconnect');
  await positive('endpoint key removal');
  receipt({ status: 'passed' });
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const failure = message.includes('ICE gathering did not complete before timeout') ? 'incomplete ICE gathering at strict deadline'
    : message.includes('Raw two-page transport did not open') ? 'raw data channels stayed closed at bounded deadline'
      : 'qualification failed at recorded checkpoint';
  receipt({ status: 'failed', currentTrial, stage, failure });
  process.exitCode = 1;
} finally { await browser?.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
