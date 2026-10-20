import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import ts from 'typescript';

// Source-level composition of the actual player controller. UI/focus acceptance
// and the already-covered persistent developer-lab store are separate evidence.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? resolve(root, 'outputs/controllers/2026-10-18-identity-loss'));
assert.ok(output.startsWith(resolve(root, 'outputs/controllers/2026-10-18-identity-loss')));
mkdirSync(output, { recursive: true });
const modules = new Map(), sources = {};
const paths = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8')).compilerOptions.paths;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function collect(path) {
  assert.ok(path.startsWith(root + '/packages/') || path.startsWith(root + '/app/sharing/'));
  const name = relative(root, path), route = '/modules/' + name;
  if (modules.has(route)) return route;
  const source = readFileSync(path, 'utf8'); sources[name] = sha256(source);
  const custody = resolve(output, 'source-context', name + '.txt');
  mkdirSync(dirname(custody), { recursive: true }); writeFileSync(custody, source);
  modules.set(route, '');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const parsed = ts.createSourceFile(name + '.js', javascript, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), replacements = [];
  function visit(node) {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier :
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (literal) {
      assert.ok(ts.isStringLiteral(literal), 'Only literal source imports are supported');
      const specifier = literal.text;
    const dependency = specifier.startsWith('.') ? resolve(dirname(path), specifier) : paths[specifier] ? resolve(root, paths[specifier][0]) : undefined;
    assert.ok(dependency, `Unexpected source import ${specifier}`);
      replacements.push({ start: literal.getStart(parsed), end: literal.getEnd(), value: JSON.stringify(collect(dependency)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  let rewritten = javascript;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
  modules.set(route, rewritten);
  return route;
}
const entry = collect(resolve(root, 'app/sharing/connected-sharing-task.ts'));
const identities = collect(resolve(root, 'packages/device-web/src/web-identity.ts'));
sources['tools/qa-lost-identity.mjs'] = sha256(readFileSync(fileURLToPath(import.meta.url)));
writeFileSync(resolve(output, 'qa-lost-identity.mjs.txt'), readFileSync(fileURLToPath(import.meta.url)));
const checks = [], observations = [], errors = [], contexts = [], pages = [], foreign = [];
const report = { scope: 'Local actual ConnectedSharing controller with native browser WebCrypto and RTCPeerConnection; abrupt destruction of original ephemeral-client context before owner removal; independent replacement. No account, physical device, UI/focus/AT or whole S06 claim.',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: sources, dependencies: { node: process.version, playwright: JSON.parse(readFileSync(resolve(root, 'node_modules/playwright/package.json'))).version, typescript: ts.version },
  command: process.argv, checks, observations, errors, foreign };
let requests = 0, browserServer, browser, child, childClosed = false, childExit, browserClosed = false;
let phase = 'setup', failure;
const server = createServer((request, response) => {
  if (++requests > 1024) { response.writeHead(429); response.end(); return; }
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (modules.has(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(modules.get(path)); }
  else if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Owned lost-client proof</title>'); }
  else { response.writeHead(404); response.end(); }
});
function check(value, name) { assert.ok(value, name); checks.push(name); }
async function state(page) { return page.evaluate(() => globalThis.fixture.task.snapshot()); }
async function until(page, predicate, label) {
  try { await page.waitForFunction(predicate, undefined, { timeout: 5000, polling: 10 }); }
  catch (error) { observations.push({ label: 'failed: ' + label, state: await state(page) }); throw error; }
}
async function call(page, operation, ...args) { return page.evaluate(({ operation, args }) => globalThis.fixture.task[operation](...args), { operation, args }); }
async function newClient(role, origin) {
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { foreign.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { foreign.push('unexpected-websocket'); socket.close(); });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin);
  await page.evaluate(async ({ entry, identities, role }) => {
    const { createConnectedSharingTask } = await import(entry);
    const { createEphemeralWebIdentity } = await import(identities);
    const keyIds = [];
    // This factory only observes the public identifier. Keys remain native,
    // nonextractable and confined to this context; no identity escapes it.
    const task = createConnectedSharingTask({ role, now: () => performance.now(), wallNow: () => Date.now(),
      createIdentity: async () => { const identity = await createEphemeralWebIdentity(); keyIds.push(identity.keyId); return identity; } });
    const violations = []; let baseline, samples = 0;
    const timer = setInterval(() => {
      task.tick();
      if (baseline) {
        samples++;
        const slot = task.snapshot().slots.find(slot => slot.id === 'right');
        if (!slot || JSON.stringify(slot.owner) !== JSON.stringify(baseline.owner) || slot.epoch !== baseline.epoch || !slot.held) {
          if (violations.length < 8) violations.push({ at: performance.now(), slot });
        }
      }
    }, 10);
    globalThis.fixture = { task, keyIds, violations, timer, monitor() { baseline = task.snapshot().slots.find(slot => slot.id === 'right'); },
      monitoring() { return { samples, violations, baseline }; }, async close() { baseline = undefined; clearInterval(timer); await task.close(); return task.snapshot().rawPending; } };
  }, { entry, identities, role });
  return { context, page };
}
async function connect(owner, source, index, replacement = false, oldOffer) {
  const id = `participant-${index + 1}`;
  check(await call(owner, replacement ? 'inviteReplacement' : 'invite', ...(replacement ? [id] : [])), 'owner explicitly issues ' + (replacement ? 'replacement' : id) + ' invitation');
  const invitation = (await state(owner)).peers[index].connection.code;
  if (oldOffer) check(!await call(owner, 'accept', id, oldOffer), 'original offer cannot enroll into replacement invitation');
  check(await call(source, 'review', invitation), 'source reviews ' + id + ' invitation');
  check(await call(source, 'offer'), 'source generates real native offer for ' + id);
  const offer = (await state(source)).peers[0].connection.code;
  check(await call(owner, 'accept', id, offer), 'owner accepts current ' + id + ' offer');
  const answer = (await state(owner)).peers[index].connection.code;
  check(await call(source, 'accept', 'participant-1', answer), 'source accepts current ' + id + ' answer');
  await until(owner, () => globalThis.fixture.task.snapshot().peers.every(peer => peer.connection.comparison), 'owner comparison');
  await until(source, () => !!globalThis.fixture.task.snapshot().peers[0]?.connection.comparison, 'source comparison');
  const comparison = (await state(owner)).peers[index].connection.comparison;
  check(comparison === (await state(source)).peers[0].connection.comparison, 'actual signed comparison agrees for ' + id);
  check(!await call(source, 'input', 'press'), 'native connection alone cannot share controls for ' + id);
  check(await call(owner, 'confirm', id), 'owner separately confirms ' + id);
  check(!await call(source, 'input', 'press'), 'one-sided confirmation cannot share controls for ' + id);
  check(await call(source, 'confirm', 'participant-1'), 'source separately confirms ' + id);
  await until(source, () => globalThis.fixture.task.snapshot().peers[0]?.connection.phase === 'connected', 'source connected');
  await until(owner, () => globalThis.fixture.task.snapshot().peers.every(peer => peer.connection.phase === 'connected'), 'owner connected');
  const packet = JSON.parse(Buffer.from(invitation.slice('101-sharing-1.'.length), 'base64url'));
  return { invitationEpoch: packet.invitation.epoch, offer, comparison, sourceKeyId: await source.evaluate(() => globalThis.fixture.keyIds[0]) };
}
async function grant(owner, source, area) {
  check(!await call(source, 'request', area, 60, false), 'fresh source consent required on ' + area);
  check(await call(source, 'request', area, 60, true), 'fresh source requests ' + area);
  await until(owner, () => globalThis.fixture.task.snapshot().slots.some(slot => slot.request), 'owner receives request');
  check(!await call(source, 'input', 'press'), 'source consent alone cannot publish ' + area);
  check(await call(owner, 'approve', area), 'fresh owner grant on ' + area);
  await until(source, () => globalThis.fixture.task.snapshot().participant.active, 'grant active');
  check(await call(source, 'input', 'press'), 'granted source presses ' + area);
  await until(owner, () => globalThis.fixture.task.snapshot().slots.filter(slot => slot.owner).every(slot => slot.held), 'actual held effect');
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browserServer = await chromium.launchServer({ headless: true }); child = browserServer.process();
  child.once('close', (code, signal) => { childClosed = true; childExit = { code, signal }; });
  browser = await chromium.connect(browserServer.wsEndpoint()); browser.on('disconnected', () => { browserClosed = true; });
  report.browser = { engine: 'chromium', version: browser.version(), pid: child.pid };
  const owner = await newClient('owner', origin), original = await newClient('participant', origin), incumbent = await newClient('participant', origin);
  phase = 'original-enrollment';
  const old = await connect(owner.page, original.page, 0); await connect(owner.page, incumbent.page, 1);
  check(await call(owner.page, 'finishRoster'), 'owner explicitly finishes roster');
  for (const source of [original.page, incumbent.page]) await until(source, () => globalThis.fixture.task.snapshot().participant.layoutReady, 'layout ready');
  await grant(owner.page, original.page, 'left'); await grant(owner.page, incumbent.page, 'right');
  observations.push({ label: 'both-original-grants-held', owner: await state(owner.page), old: { invitationEpoch: old.invitationEpoch, sourceKeyId: old.sourceKeyId, comparison: old.comparison } });
  await owner.page.evaluate(() => globalThis.fixture.monitor());
  phase = 'abrupt-original-loss';
  // No task.close/interrupt/removal happens in the original page. Destroy its
  // entire context while it holds the original key and active resource grant.
  await original.context.close();
  check(original.page.isClosed() && original.context.pages().length === 0, 'original client and its only ephemeral key context destroyed before removal');
  await until(owner.page, () => !globalThis.fixture.task.snapshot().slots.find(slot => slot.id === 'left')?.held, 'lost client effect releases naturally');
  check(!(await state(owner.page)).slots[0].held, 'original held output is unusable after actual client loss');
  check(await call(owner.page, 'previewRemoveParticipant', 'participant-1'), 'owner reviews removal after original became unavailable');
  check(await owner.page.evaluate(() => globalThis.fixture.task.confirmRemoval(globalThis.fixture.task.snapshot().preview)), 'reviewed removal joins original peer retirement');
  const retired = await state(owner.page);
  check(retired.peers[0].membership === 'removed' && !retired.slots[0].owner && !retired.slots[0].held && retired.rawPending === 0, 'old authority and pending original work absent after retirement');
  observations.push({ label: 'original-unavailable-before-replacement', owner: retired, originalClosed: original.page.isClosed() });
  phase = 'independent-replacement';
  const replacement = await newClient('participant', origin);
  check(!await call(replacement.page, 'input', 'press'), 'fresh independent context starts without authority');
  const fresh = await connect(owner.page, replacement.page, 0, true, old.offer);
  check(fresh.sourceKeyId !== old.sourceKeyId && fresh.invitationEpoch !== old.invitationEpoch && fresh.comparison !== old.comparison, 'replacement has independent native identity and fresh invitation and signed comparison');
  await until(replacement.page, () => globalThis.fixture.task.snapshot().participant.layoutReady, 'replacement layout');
  check(!await call(replacement.page, 'input', 'press') && !(await state(owner.page)).slots[0].owner, 'fresh enrollment restores no old resource grant');
  await grant(owner.page, replacement.page, 'left');
  check(!await call(owner.page, 'accept', 'participant-1', old.offer), 'original offer remains unusable after new grant');
  check(await call(incumbent.page, 'input', 'right'), 'incumbent can still deliver new actual input');
  await until(owner.page, () => globalThis.fixture.task.snapshot().slots[1].position?.x > .5, 'incumbent input reaches effect');
  const monitoring = await owner.page.evaluate(() => globalThis.fixture.monitoring());
  check(monitoring.samples > 0 && monitoring.violations.length === 0, 'incumbent owner epoch and held output survive original loss removal and replacement');
  observations.push({ label: 'fresh-grant-and-incumbent-continuity', owner: await state(owner.page), fresh: { sourceKeyId: fresh.sourceKeyId, invitationEpoch: fresh.invitationEpoch, comparison: fresh.comparison }, monitoring });
  check(errors.length === 0 && foreign.length === 0, 'no browser errors or foreign requests');
} catch (error) { failure = String(error.stack ?? error); }
finally {
  const cleanup = { phase, contexts: [], joinedTaskPending: [], errors: [] };
  for (const page of pages) if (!page.isClosed()) {
    try { cleanup.joinedTaskPending.push(await page.evaluate(() => globalThis.fixture?.close())); } catch (error) { cleanup.errors.push(String(error)); }
  }
  for (const context of contexts) { try { await context.close(); cleanup.contexts.push(context.pages().length); } catch (error) { cleanup.errors.push(String(error)); } }
  try { await browser?.close(); await browserServer?.close(); } catch (error) { cleanup.errors.push(String(error)); }
  await new Promise(resolve => server.close(resolve));
  Object.assign(cleanup, { allPagesClosed: pages.every(page => page.isClosed()), browserClosed, childClosed, childExit, loopbackClosed: !server.listening, requests });
  report.cleanup = cleanup; report.status = failure || cleanup.errors.length || !cleanup.allPagesClosed || !childClosed ? 'fail' : 'pass';
  report.failure = failure;
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, phase, checks: checks.length, output, failure, cleanup }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
