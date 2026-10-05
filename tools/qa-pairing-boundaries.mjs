import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';

const sha = value => createHash('sha256').update(value).digest('hex');
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
}

/** Actual local HTTP and Chromium callers of source-bound public package entries. */
export async function runPairingBoundaryChecks({ sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const work = mkdtempSync(join(tmpdir(), '101-pairing-boundaries-'));
  const files = ['packages/protocol/src/index.ts', 'packages/pairing/src/index.ts', 'packages/pairing/src/http-signaling.ts', 'packages/pairing/src/intake.ts', 'tools/qa-pairing-boundaries.mjs'];
  const sourceSha256 = Object.fromEntries(files.map(file => [file, sha(readFileSync(join(sourceRoot, file)))]));
  const compiled = join(work, 'compiled'), outputs = new Map();
  function compile(file) {
    if (outputs.has(file)) return outputs.get(file);
    const output = join(compiled, relative(sourceRoot, file).replace(/\.ts$/, '.js')); outputs.set(file, output);
    const source = readFileSync(file, 'utf8'); sourceSha256[relative(sourceRoot, file)] = sha(source);
    let emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const parsed = ts.createSourceFile(file, emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    for (const statement of parsed.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('node:')) continue;
      let target;
      if (/^@101\/[a-z][a-z0-9-]*$/.test(specifier)) target = join(sourceRoot, 'packages', specifier.slice(5), 'src/index.ts');
      else if (specifier.startsWith('.')) target = resolve(dirname(file), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`);
      else throw new Error('QA compile requires a bounded local package graph');
      const dependency = compile(target); let path = relative(dirname(output), dependency).replaceAll('\\', '/');
      if (!path.startsWith('.')) path = `./${path}`;
      emitted = emitted.replaceAll(`"${specifier}"`, JSON.stringify(path)).replaceAll(`'${specifier}'`, JSON.stringify(path));
    }
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, emitted); return output;
  }
  const nodePairing = compile(join(sourceRoot, 'packages/pairing/src/index.ts'));
  compile(join(sourceRoot, 'packages/protocol/src/index.ts'));
  const hubFile = compile(join(sourceRoot, 'packages/hub-server/src/index.ts'));
  const pairing = await import(pathToFileURL(nodePairing).href), { LocalHubServer } = await import(pathToFileURL(hubFile).href);
  const hub = new LocalHubServer({ host: '127.0.0.1', port: 0 });
  const servers = []; const requests = []; const recipients = []; let browser;
  const start = async server => { servers.push(server); return listen(server); };
  try {
    await hub.start();
    const proxy = createServer(async (request, response) => {
      cors(response);
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      requests.push({ authorization: !!request.headers.authorization, cookie: !!request.headers.cookie });
      try {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 1_048_576) throw new Error('Owned QA request bound'); chunks.push(chunk); }
        const body = length ? Buffer.concat(chunks) : undefined;
        const incoming = await fetch(`${hub.url}${request.url}`, { method: request.method, redirect: 'manual', headers: {
          ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
        }, ...(body ? { body } : {}) });
        response.writeHead(incoming.status, { 'Content-Type': incoming.headers.get('content-type') ?? 'application/json' });
        response.end(Buffer.from(await incoming.arrayBuffer()));
      } catch { response.writeHead(500); response.end(); }
    });
    const endpoint = await start(proxy);
    const created = await pairing.createHttpSignalingSession(endpoint, 'BOUNDARY101', { ttlMs: 60_000, hostName: 'Independent local application' });
    const nodeHost = new pairing.HttpHostSignalingClient(endpoint, created.ticket.sessionId, created.hostToken);
    const nodeClient = new pairing.HttpControllerSignalingClient(created.ticket);
    const nodeLease = await nodeClient.join({ deviceId: 'independent-node', label: 'Node caller', capabilities: { touch: true } });
    assert.ok(Object.isFrozen(nodeLease));
    assert.equal((await nodeHost.listPeers())[0].deviceId, 'independent-node');
    const next = await nodeClient.requestReconnect(nodeLease);
    assert.equal(next.generation, nodeLease.generation + 1);
    assert.equal((await nodeClient.getOffer(next)).generation, next.generation);
    await nodeClient.leave(next); assert.deepEqual(await nodeHost.listPeers(), []);

    const recipient = createServer(async (request, response) => {
      cors(response);
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      let bytes = 0; for await (const chunk of request) bytes += chunk.length;
      recipients.push({ authorization: !!request.headers.authorization, cookie: !!request.headers.cookie, bytes });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(nodeLease));
    });
    const recipientEndpoint = await start(recipient);
    const makeCase = async kind => start(createServer((request, response) => {
      cors(response);
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (request.url === '/recipient') {
        recipients.push({ authorization: !!request.headers.authorization, cookie: !!request.headers.cookie, bytes: 0 });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(nodeLease)); return;
      }
      if (kind === 'same' || kind === 'cross') { response.writeHead(307, { Location: kind === 'same' ? '/recipient' : `${recipientEndpoint}/recipient` }); response.end(); return; }
      response.setHeader('Content-Type', 'application/json');
      if (kind === 'oversize') { response.write(' '.repeat(1_048_577)); response.end('[]'); return; }
      if (kind === 'substitute') { response.end(JSON.stringify({ ...created, ticket: { ...created.ticket, sessionId: 'OTHER101' } })); return; }
      if (kind === 'peers') { response.end(JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ peerId: `peer-${i}`, deviceId: 'phone', generation: 1, lastSeenAt: Date.now() })))); return; }
      response.write('['); // Intentionally stalled until the owner closes this disposable server.
    }));
    const cases = {};
    for (const kind of ['same', 'cross', 'oversize', 'substitute', 'peers', 'stall']) cases[kind] = await makeCase(kind);
    for (const kind of ['same', 'cross']) {
      const client = new pairing.HttpControllerSignalingClient({ ...created.ticket, endpoint: cases[kind] });
      await assert.rejects(() => client.join({ deviceId: `node-${kind}`, label: 'Node caller', capabilities: { touch: true } })); client.close();
    }
    for (const kind of ['oversize', 'peers']) {
      const host = new pairing.HttpHostSignalingClient(cases[kind], created.ticket.sessionId, created.hostToken);
      await assert.rejects(() => host.listPeers()); host.close();
    }
    await assert.rejects(() => pairing.createHttpSignalingSession(cases.substitute, created.ticket.sessionId));
    const stalled = new pairing.HttpHostSignalingClient(cases.stall, created.ticket.sessionId, created.hostToken);
    const nodeStarted = performance.now(); await assert.rejects(() => stalled.listPeers());
    const nodeDeadlineMs = performance.now() - nodeStarted; assert.ok(nodeDeadlineMs >= 2400 && nodeDeadlineMs < 3500); stalled.close();

    const application = createServer((request, response) => {
      const match = [...outputs.values()].find(file => request.url === `/modules/${relative(compiled, file).replaceAll('\\', '/')}`);
      if (match) {
        response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(match)); return;
      }
      response.setHeader('Set-Cookie', '101_ambient_sentinel=local-qa-only; Path=/; SameSite=Lax');
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Independent pairing boundary caller</title><main>Disposable local caller</main>');
    });
    const origin = await start(application);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message)); await page.goto(origin);
    const observed = await page.evaluate(async ({ endpoint, created, cases }) => {
      const pairing = await import('/modules/packages/pairing/src/index.js'), protocol = await import('/modules/packages/protocol/src/index.js');
      const code = protocol.encodePairingTicket(created.ticket), link = `http://127.0.0.1/controller?pair=${code}&session=${created.ticket.sessionId}`;
      const intake = pairing.createPairingIntake({ parse: protocol.parsePairingInput });
      const reviewed = intake.receive(link, 'link');
      if (reviewed.status !== 'review' || !intake.approve(reviewed.candidate)) throw new Error('Explicit inert intake approval failed');
      const client = new pairing.HttpControllerSignalingClient(reviewed.candidate.ticket);
      const host = new pairing.HttpHostSignalingClient(endpoint, created.ticket.sessionId, created.hostToken);
      const lease = await client.join({ deviceId: 'independent-browser', label: 'Browser caller', capabilities: { touch: true } });
      const peers = await host.listPeers(); const node = peers.find(peer => peer.deviceId === 'independent-browser');
      if (!node || !Object.isFrozen(lease)) throw new Error('Actual Hub roundtrip failed');
      await client.leave(lease); client.close(); host.close();
      const blocked = {};
      for (const kind of ['same', 'cross']) {
        const peer = new pairing.HttpControllerSignalingClient({ ...created.ticket, endpoint: cases[kind] });
        try { await peer.join({ deviceId: `browser-${kind}`, label: 'Browser caller', capabilities: { touch: true } }); blocked[kind] = false; } catch { blocked[kind] = true; } finally { peer.close(); }
      }
      for (const kind of ['oversize', 'peers']) {
        const peer = new pairing.HttpHostSignalingClient(cases[kind], created.ticket.sessionId, created.hostToken);
        try { await peer.listPeers(); blocked[kind] = false; } catch { blocked[kind] = true; } finally { peer.close(); }
      }
      try { await pairing.createHttpSignalingSession(cases.substitute, created.ticket.sessionId); blocked.substitute = false; } catch { blocked.substitute = true; }
      const stalled = new pairing.HttpHostSignalingClient(cases.stall, created.ticket.sessionId, created.hostToken), started = performance.now();
      try { await stalled.listPeers(); blocked.stall = false; } catch { blocked.stall = true; } finally { stalled.close(); }
      return { blocked, deadlineMs: performance.now() - started, healthy: true, ambientCookiePresent: document.cookie.includes('101_ambient_sentinel=') };
    }, { endpoint, created, cases });
    assert.equal(observed.healthy, true); assert.equal(observed.ambientCookiePresent, true);
    for (const kind of Object.keys(cases)) assert.equal(observed.blocked[kind], true, `Native Chromium rejects ${kind}`);
    assert.ok(observed.deadlineMs >= 2400 && observed.deadlineMs < 3500);
    assert.deepEqual(pageErrors, []); assert.deepEqual(recipients, []);
    assert.ok(requests.length > 8); assert.equal(requests.some(request => request.cookie), false);
    nodeClient.close(); nodeHost.close();
    const receipt = { sourceSha256, artifactKind: 'source-bound compiled public package entries; not packed or native qualification', artifactSha256: Object.fromEntries([...outputs.values()].map(file => [relative(compiled, file), sha(readFileSync(file))])),
      node: { healthy: true, redirectRecipients: recipients.length, stalledDeadlineMs: nodeDeadlineMs }, browser: observed, requestCount: requests.length, ambientCookiesForwarded: false, pageErrors,
      limits: pairing.HTTP_SIGNALING_LIMITS, claims: { endpointAuthentication: false, resourceOperationGrant: false, nativeRuntime: false, fullD09: false } };
    const serialized = JSON.stringify(receipt, null, 2);
    for (const secret of [created.hostToken, created.ticket.joinToken, nodeLease.peerToken]) assert.equal(serialized.includes(secret), false);
    const receiptPath = join(work, 'receipt.json'); writeFileSync(receiptPath, serialized); return { receiptPath, receipt };
  } finally {
    await browser?.close();
    for (const server of servers.reverse()) await close(server);
    await hub.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPairingBoundaryChecks(); process.stdout.write(`${JSON.stringify({ receiptPath: result.receiptPath, node: result.receipt.node, browser: result.receipt.browser })}\n`);
}
