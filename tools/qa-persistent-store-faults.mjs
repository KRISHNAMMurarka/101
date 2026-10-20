import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import ts from 'typescript';

// Actual source Settings task, fixed signed provision, native Storage and native
// Web Locks on one new owned origin. No app UI/profile-restart qualification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), prepare = args.includes('--prepare-only');
const engine = args.find(value => value.startsWith('--engine='))?.slice(9) ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const output = resolve(root, 'outputs/controllers/2026-10-18-persistent-store-faults', engine);
mkdirSync(output, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const modules = new Map(), sourcePins = {}, emittedPins = {};
const paths = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8')).compilerOptions.paths;
function collect(path) {
  assert.ok(path.startsWith(root + '/packages/') || path.startsWith(root + '/app/settings/processors/') ||
    path === resolve(root, 'examples/external-processor/processor.mjs') ||
    path === resolve(root, 'examples/extension-installation/temperature-band-v2.mjs'));
  const name = relative(root, path), route = '/modules/' + name;
  if (modules.has(route)) return route;
  const source = readFileSync(path, 'utf8'); sourcePins[name] = sha256(source);
  const custody = resolve(output, 'source-context', name + '.txt');
  mkdirSync(dirname(custody), { recursive: true }); writeFileSync(custody, source);
  modules.set(route, '');
  const javascript = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  } }).outputText;
  const parsed = ts.createSourceFile(name + '.js', javascript, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS), replacements = [];
  function visit(node) {
    const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier :
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (literal) {
      assert.ok(ts.isStringLiteral(literal), 'Only literal source imports are supported');
      const specifier = literal.text;
      const dependency = specifier.startsWith('.') ? resolve(dirname(path), specifier) :
        paths[specifier] ? resolve(root, paths[specifier][0]) : undefined;
      assert.ok(dependency, `Unexpected source import ${specifier}`);
      replacements.push({ start: literal.getStart(parsed), end: literal.getEnd(), value: JSON.stringify(collect(dependency)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  let rewritten = javascript;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
  }
  modules.set(route, rewritten); emittedPins[route] = sha256(rewritten);
  return route;
}
const entry = collect(resolve(root, 'app/settings/processors/processor-management.ts'));
sourcePins['tsconfig.json'] = sha256(readFileSync(resolve(root, 'tsconfig.json')));
sourcePins['tools/qa-persistent-store-faults.mjs'] = sha256(readFileSync(fileURLToPath(import.meta.url)));
writeFileSync(resolve(output, 'qa-persistent-store-faults.mjs.txt'), readFileSync(fileURLToPath(import.meta.url)));
const checks = [], observations = [], pageErrors = [], foreignRequests = [], served = new Set();
const report = { schemaVersion: 1, scope: 'Actual source Settings reviewed-processor task using its default browser storage adapter with transparent native-return observers; selected native quota refusal and queued Stop/close. No built UI, browser restart, account, hardware, forensic deletion or whole B06/U12 claim.',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  command: process.argv, sourcePins, emittedPins,
  toolchain: { node: process.version, typescript: ts.version, playwright: JSON.parse(readFileSync(resolve(root, 'node_modules/playwright/package.json'))).version },
  checks, observations, pageErrors, foreignRequests };
writeFileSync(resolve(output, 'preparation.json'), JSON.stringify({ ...report, status: 'prepared-not-executed', modules: modules.size }, null, 2) + '\n');
if (prepare) { console.log(JSON.stringify({ status: 'prepared-not-executed', modules: modules.size, output })); process.exit(0); }

const ownerKey = '101:processor-installation:page%3Aprocessor-owner', lockName = `${ownerKey}:storage-lock`;
let browserServer, browser, context, page, blocker, child, childClosed = false, childExit, failure, phase = 'setup', requests = 0;
const childReturn = new Promise(resolve => { report.joinChild = resolve; });
const joinChild = report.joinChild; delete report.joinChild;
const sockets = new Set();
const server = createServer((request, response) => {
  if (++requests > 1024) { response.writeHead(429); response.end(); return; }
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (modules.has(path)) { served.add(path); response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(modules.get(path)); }
  else if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Owned persistent processor faults</title>'); }
  else { response.writeHead(404); response.end(); }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
function check(value, name) { assert.ok(value, name); checks.push(name); }
async function snapshot() { return page.evaluate(() => globalThis.fixture.task.snapshot()); }
async function call(method, ...values) { return page.evaluate(({ method, values }) => globalThis.fixture.task[method](...values), { method, values }); }
async function accept(version) {
  const review = await call('review', 'install', version); check(review.ok, `actual signed ${version} install review issued`);
  const result = await page.evaluate(async () => {
    const review = globalThis.fixture.task.snapshot().review;
    return globalThis.fixture.task.confirm(review);
  });
  check(result.ok, `actual signed ${version} native installation committed`);
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  report.origin = `http://127.0.0.1:${server.address().port}`;
  browserServer = await ({ chromium, webkit }[engine]).launchServer({ headless: true }); child = browserServer.process();
  child.once('close', (code, signal) => { childClosed = true; childExit = { code, signal }; joinChild(); });
  browser = await ({ chromium, webkit }[engine]).connect(browserServer.wsEndpoint());
  report.browser = { engine, version: browser.version(), pid: child.pid,
    executable: child.spawnfile, executableSha256: sha256(readFileSync(child.spawnfile)) };
  context = await browser.newContext();
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== report.origin) { foreignRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => { foreignRequests.push('unexpected-websocket'); socket.close(); });
  await context.addInitScript(({ ownerKey, lockName }) => {
    const nativeSet = Storage.prototype.setItem, nativeGet = Storage.prototype.getItem;
    const nativeRequest = LockManager.prototype.request;
    const observed = { reads: 0, writeAttempts: 0, writes: 0, quotaRefusals: 0, lockIssued: 0, lockPending: 0, lockGranted: 0, lockReturned: 0, lockRejected: 0 };
    globalThis.nativeStorageFaultObserver = observed;
    Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, writable: true, value(key) {
      if (key === ownerKey) observed.reads++; return Reflect.apply(nativeGet, this, [key]);
    } });
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, writable: true, value(key, value) {
      if (key === ownerKey) observed.writeAttempts++;
      try { const result = Reflect.apply(nativeSet, this, [key, value]); if (key === ownerKey) observed.writes++; return result; }
      catch (error) { if (key === ownerKey && error instanceof DOMException && error.name === 'QuotaExceededError') observed.quotaRefusals++; throw error; }
    } });
    Object.defineProperty(LockManager.prototype, 'request', { configurable: true, writable: true, value(...args) {
      if (args[0] !== lockName) return Reflect.apply(nativeRequest, this, args);
      observed.lockIssued++; observed.lockPending++;
      const at = args.length - 1, callback = args[at];
      args[at] = function(lock) { observed.lockGranted++; return Reflect.apply(callback, this, [lock]); };
      let issued;
      try { issued = Reflect.apply(nativeRequest, this, args); }
      catch (error) { observed.lockPending--; throw error; }
      void Promise.prototype.then.call(issued, () => { observed.lockPending--; observed.lockReturned++; },
        () => { observed.lockPending--; observed.lockReturned++; observed.lockRejected++; });
      return issued;
    } });
  }, { ownerKey, lockName });
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(report.origin);
  await page.evaluate(async entry => {
    const { createProcessorManagementTask } = await import(entry);
    const effects = [], tasks = [];
    const make = () => { const task = createProcessorManagementTask({ onEffect: value => { effects.push(value); } }); tasks.push(task); return task; };
    globalThis.fixture = { task: make(), effects, tasks, make, fillers: [], confirming: undefined, closing: undefined };
  }, entry);
  check((await snapshot()).phase === 'idle' && (await page.evaluate(() => globalThis.nativeStorageFaultObserver.reads)) === 0,
    'arrival constructs actual task without reading persistent storage');
  check((await call('manage', 'browser')).ok, 'fresh explicit browser management opens actual Settings storage');
  await accept('1.0.0');
  const prior = await page.evaluate(ownerKey => localStorage.getItem(ownerKey), ownerKey);
  check(typeof prior === 'string' && JSON.parse(prior).packages.length === 1, 'real signed saved v1 document exists before fault');
  check((await snapshot()).activeVersion === undefined && (await snapshot()).routes === 0, 'saving does not activate live authority');

  phase = 'native-quota';
  const quota = await page.evaluate(() => {
    const prefix = '101-owned-storage-fault-fill:', fillers = globalThis.fixture.fillers;
    let totalCharacters = 0, refusals = 0;
    for (const size of [65536, 512, 16]) {
      for (let attempt = 0; attempt < 4096; attempt++) {
        const key = prefix + fillers.length;
        try { const value = 'x'.repeat(size); localStorage.setItem(key, value); fillers.push(key); totalCharacters += size; }
        catch (error) { if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error; refusals++; break; }
      }
    }
    return { keys: fillers.length, totalCharacters, genuineQuotaRefusals: refusals };
  });
  check(quota.genuineQuotaRefusals === 3 && quota.keys < 4096, 'owned origin reaches actual native localStorage quota at bounded writes');
  const quotaReview = await call('review', 'install', '2.0.0'); check(quotaReview.ok, 'signed v2 is reviewed after native storage is full');
  const quotaResult = await page.evaluate(() => globalThis.fixture.task.confirm(globalThis.fixture.task.snapshot().review));
  const afterQuota = await snapshot(), observerAfterQuota = await page.evaluate(() => globalThis.nativeStorageFaultObserver);
  check(!quotaResult.ok && observerAfterQuota.quotaRefusals === 1, 'actual Settings commit encounters and refuses genuine native QuotaExceededError');
  check(await page.evaluate(({ ownerKey, prior }) => localStorage.getItem(ownerKey) === prior, { ownerKey, prior }), 'native quota refusal preserves exact incumbent signed document bytes');
  check(afterQuota.installed.length === 1 && afterQuota.installed[0].version === '1.0.0' && !afterQuota.activeVersion && !afterQuota.routes && !afterQuota.registrations,
    'native quota refusal creates no RAM-only installation or active grants');
  check(!JSON.stringify(quotaResult).includes('QuotaExceededError') && !JSON.stringify(quotaResult).includes(report.origin), 'Settings result exposes fixed failure reason without native error text');
  observations.push({ phase, quota, result: quotaResult, state: afterQuota, observer: observerAfterQuota, incumbentSha256: sha256(prior) });
  await page.evaluate(async () => {
    for (const key of globalThis.fixture.fillers.splice(0)) localStorage.removeItem(key);
    await globalThis.fixture.task.close(); globalThis.fixture.task = globalThis.fixture.make();
  });
  check((await call('manage', 'browser')).ok && (await snapshot()).installed[0]?.version === '1.0.0', 'explicit fresh management reads unchanged incumbent after quota is removed');

  phase = 'native-queued-close';
  blocker = await context.newPage(); blocker.on('pageerror', error => pageErrors.push(String(error))); await blocker.goto(report.origin);
  await blocker.evaluate(lockName => {
    globalThis.held = false;
    globalThis.heldRequest = navigator.locks.request(lockName, { mode: 'exclusive' }, () => {
      globalThis.held = true; return new Promise(resolve => { globalThis.releaseHeld = resolve; });
    });
  }, lockName);
  await blocker.waitForFunction(() => globalThis.held, undefined, { timeout: 5000 });
  const beforeQueue = await page.evaluate(() => ({ ...globalThis.nativeStorageFaultObserver }));
  check((await call('review', 'install', '2.0.0')).ok, 'new signed update review is issued before queued native write');
  await page.evaluate(() => { globalThis.fixture.confirming = globalThis.fixture.task.confirm(globalThis.fixture.task.snapshot().review); });
  await page.waitForFunction(async lockName => (await navigator.locks.query()).pending.some(lock => lock.name === lockName), lockName, { timeout: 5000, polling: 10 });
  const queued = await page.evaluate(async () => ({ state: globalThis.fixture.task.snapshot(), observed: { ...globalThis.nativeStorageFaultObserver }, locks: await navigator.locks.query() }));
  check(queued.observed.lockPending === 1 && queued.observed.lockGranted === beforeQueue.lockGranted && queued.state.storagePending === 1,
    'genuine Settings issued request is pending in actual native exclusive lock queue');
  const immediate = await page.evaluate(() => {
    const f = globalThis.fixture; f.task.stopManagement(); f.closing = f.task.close();
    return { sameBarrier: f.task.close() === f.closing, state: f.task.snapshot(), observed: { ...globalThis.nativeStorageFaultObserver } };
  });
  check(immediate.sameBarrier && immediate.state.closurePending && immediate.state.rawPending > 0 && immediate.state.storagePending === 1,
    'Stop retires approval immediately and one close barrier retains actual issued queued request');
  const joined = await page.evaluate(async () => {
    const result = await globalThis.fixture.confirming; await globalThis.fixture.closing;
    return { result, state: globalThis.fixture.task.snapshot(), observed: { ...globalThis.nativeStorageFaultObserver }, locks: await navigator.locks.query(), effects: [...globalThis.fixture.effects] };
  });
  check(!joined.result.ok && joined.observed.lockReturned === beforeQueue.lockReturned + 1 && joined.observed.lockRejected === beforeQueue.lockRejected + 1 && joined.observed.lockPending === 0,
    'close joins actual native aborted request rejection before resolving');
  check(joined.observed.lockGranted === beforeQueue.lockGranted && joined.observed.writes === beforeQueue.writes,
    'queued request never enters native granted callback or writes after Stop');
  check(joined.state.phase === 'closed' && !joined.state.rawPending && !joined.state.storagePending && !joined.state.closurePending && !joined.state.routes && !joined.state.registrations && !joined.effects.length,
    'closed Settings owns no raw work, storage reservation, live route, registration or effect');
  check(joined.locks.held.some(lock => lock.name === lockName) && !joined.locks.pending.some(lock => lock.name === lockName), 'unrelated owned blocker remains held while retired Settings request is absent');
  check(await page.evaluate(({ ownerKey, prior }) => localStorage.getItem(ownerKey) === prior, { ownerKey, prior }), 'queued Stop/close preserves exact incumbent bytes');
  observations.push({ phase, beforeQueue, queued, immediate, joined });
  await blocker.evaluate(async () => { globalThis.releaseHeld(); await globalThis.heldRequest; globalThis.held = false; });
  check(!(await page.evaluate(() => navigator.locks.query())).held.some(lock => lock.name === lockName), 'held independent native lock release is joined');
  check(pageErrors.length === 0 && foreignRequests.length === 0, 'selected native proof has no page errors or foreign requests');
} catch (error) { failure = String(error.stack ?? error); }
finally {
  const cleanup = { phase, errors: [], taskStates: [], ownedStorageEmpty: false };
  try { if (blocker && !blocker.isClosed()) await blocker.evaluate(async () => { globalThis.releaseHeld?.(); await globalThis.heldRequest; }); } catch (error) { cleanup.errors.push(String(error)); }
  try { if (page && !page.isClosed()) {
    cleanup.taskStates = await page.evaluate(async ownerKey => {
      const f = globalThis.fixture;
      if (f) { await Promise.all(f.tasks.map(task => task.close())); await f.confirming; }
      for (const key of f?.fillers ?? []) localStorage.removeItem(key);
      localStorage.removeItem(ownerKey); return f?.tasks.map(task => task.snapshot()) ?? [];
    }, ownerKey);
    cleanup.ownedStorageEmpty = await page.evaluate(() => localStorage.length === 0);
  } } catch (error) { cleanup.errors.push(String(error)); }
  try { await context?.close(); } catch (error) { cleanup.errors.push(String(error)); }
  try { await browser?.close(); await browserServer?.close(); if (child) await childReturn; } catch (error) { cleanup.errors.push(String(error)); }
  await new Promise(resolve => server.close(resolve));
  Object.assign(cleanup, { pagesClosed: (!page || page.isClosed()) && (!blocker || blocker.isClosed()), childClosed, childExit,
    contextPages: context?.pages().length ?? 0, loopbackClosed: !server.listening, ownedSockets: sockets.size, requests });
  report.cleanup = cleanup; report.status = failure || cleanup.errors.length || !cleanup.ownedStorageEmpty || !cleanup.pagesClosed || !childClosed || childExit?.code !== 0 || childExit?.signal !== null ? 'fail' : 'pass';
  report.failure = failure; report.servedModules = [...served];
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, phase, checks: checks.length, modules: modules.size, output, failure, cleanup }, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
