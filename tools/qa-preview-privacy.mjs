import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import ts from 'typescript';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--source', 'This bounded S15 observer accepts --source only');
assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/browser-screen-preview.ts', 'packages/device-web/src/browser-screen-preview.test.ts', 'examples/browser-resources/screen-preview.ts', 'tools/qa-browser-screen-preview.mjs', 'tools/sdk-browser-inventory.mjs', 'tools/qa-preview-privacy.mjs', 'tools/qa-preview-privacy-page.mjs', 'tools/qa-preview-privacy-observer.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
let consumer, scratch, dependencyPins;
const served = new Map(), results = [], pageErrors = [], blockedRequests = []; let server, serverFailure, receipt, runFailure, resolutionEvidence, resolutionFailureEvidence, privacyModuleSha256;
const controllerDirectory = join(root, 'outputs/controllers/2026-10-18-privacy-followthrough');
mkdirSync(controllerDirectory, { recursive: true });
mkdirSync(join(root, 'release'), { recursive: true });
const runId = 'browser-' + Date.now().toString(36) + '-' + process.pid.toString(36), custodyPath = join(controllerDirectory, runId + '.json'), cleanupPath = join(controllerDirectory, runId + '.cleanup.json');
assert.equal(existsSync(custodyPath), false); assert.equal(existsSync(cleanupPath), false);
let browserHandlesClosed = 0, contextsClosed = 0;
function files(directory, budget = { left: 1024 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0); const path = join(directory, name), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) return files(path, budget);
    assert.equal(stat.isFile(), true); return [path];
  });
}
function bytes(path, limit = 4 * 1024 * 1024) {
  const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.ok(stat.size <= limit);
  const value = readFileSync(path); assert.ok(value.byteLength <= limit); return value;
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function serve(url, file) { assert.equal(realpathSync(file), file); assert.equal(lstatSync(file).isFile(), true); assert.equal(served.has(url), false); served.set(url, { file, sha256: hash(bytes(file)) }); }
function diagnose(program) {
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
}
try {
  {
    consumer = realpathSync(mkdtempSync(join(root, 'release/s15-preview-browser-'))); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync(join(root, 'release')), 's15-preview-browser-')));
    const compiled = join(consumer, '.compiled'), roots = [...names.map(name => join(root, `packages/${name}/src/index.ts`)), join(root, owned[2])];
    const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true, noUncheckedIndexedAccess: true, types: [], skipLibCheck: false, noEmitOnError: true,
      rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])) });
    const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    assert.ok(sources.length > 0 && sources.length <= 512 && sources.every(file => file.fileName === join(root, owned[2]) || names.some(name => file.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !file.fileName.endsWith('.test.ts')));
    diagnose(program); dependencyPins = Object.fromEntries(sources.map(file => [relative(root, file.fileName), hash(bytes(file.fileName))]));
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]]);
    for (const name of names) {
      const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
      for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
      for (const file of files(destination)) serve(`/sdk/${name}/${relative(destination, file).split(sep).join('/')}`, file);
    }
    copy(join(compiled, 'examples/browser-resources/screen-preview.js'), join(consumer, 'screen-preview-caller.mjs')); serve('/screen-preview-caller.mjs', join(consumer, 'screen-preview-caller.mjs'));
  }
  const privacyModuleBytes = readFileSync(join(root, 'tools/qa-preview-privacy-page.mjs'));
  const privacyModulePath = join(scratch, 's15-screen-preview-privacy.mjs'); writeFileSync(privacyModulePath, privacyModuleBytes);
  privacyModuleSha256 = hash(privacyModuleBytes); serve('/s15-screen-preview-privacy.mjs', privacyModulePath);
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserScreenPreviewProvider!=='function'||sdk.createBrowserScreenPreviewProvider!==web.createBrowserScreenPreviewProvider)throw Error('Public identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const resolution = await new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now(), events = [];
    const record = (event, detail = {}) => { if (events.length < 6) events.push({ event, elapsedMs: performance.now() - startedAt, ...detail }); };
    const child = spawn(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, failure;
    child.once('spawn', () => record('spawn')); child.once('exit', (status, signal) => record('exit', { status, signal }));
    const timer = setTimeout(() => { timedOut = true; record('deadline'); child.kill('SIGTERM'); }, 5000);
    function collect(kind, value) { if (kind === 'stdout') stdout += value.toString('utf8'); else stderr += value.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { failure = new Error('Resolution output bound'); child.kill('SIGTERM'); } }
    child.stdout.on('data', value => collect('stdout', value)); child.stderr.on('data', value => collect('stderr', value));
    child.on('error', error => { failure = error; record('error', { code: error.code }); }); child.on('close', (status, signal) => { clearTimeout(timer); record('close', { status, signal });
      const diagnostic = { pid: child.pid ?? null, events, status, signal, timedOut, deadlineMs: 5000,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: hash(Buffer.from(stdout)), stderrSha256: hash(Buffer.from(stderr)) };
      if (failure) rejectRun(Object.assign(failure, { resolutionDiagnostic: diagnostic, resolutionRaw: { stdout, stderr } }));
      else if (timedOut) rejectRun(Object.assign(new Error('Resolution deadline5000ms: ' + signal), { resolutionDiagnostic: diagnostic, resolutionRaw: { stdout, stderr } }));
      else resolveRun({ status, stdout, stderr, diagnostic }); });
  });
  resolutionEvidence = { status: resolution.status, stdout: resolution.stdout, stderr: resolution.stderr, diagnostic: resolution.diagnostic };
  assert.equal(resolution.status, 0, resolution.stderr + '\n' + JSON.stringify(resolution.diagnostic)); assert.equal(resolution.stderr, '');
  const publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
  const html = `<!doctype html><meta charset="utf-8"><title>Owned preview privacy diagnostic</title><button id="privacy" type="button">Run private-preview sink observation</button><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkBrowserScreenPreviewWithoutCapture} from '/screen-preview-caller.mjs';import {prepareS15PreviewPrivacyObservation,runS15PreviewPrivacyObservation} from '/s15-screen-preview-privacy.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
globalThis.defaultDisplayAttempts=0;if(navigator.mediaDevices&&typeof navigator.mediaDevices.getDisplayMedia==='function')navigator.mediaDevices.getDisplayMedia=()=>{globalThis.defaultDisplayAttempts++;throw Error('OS display chooser forbidden in this owned page');};
try{if(sdk.createBrowserScreenPreviewProvider!==web.createBrowserScreenPreviewProvider)throw Error('Public identity');globalThis.proof={native:await checkBrowserScreenPreviewWithoutCapture()};globalThis.proof.privacyBaseline=await prepareS15PreviewPrivacyObservation();globalThis.nativeReady=true;document.querySelector('#privacy').onclick=async()=>{try{globalThis.proof.privacy=await runS15PreviewPrivacyObservation(globalThis.proof.privacyBaseline);globalThis.privacyReady=true;}catch(error){globalThis.privacyError=String(error);}};}catch(error){globalThis.bootstrapError=String(error);}</script>`;
  server = createServer((request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', path === '/denied' ? 'display-capture=()' : 'display-capture=(self)');
      if (path === '/' || path === '/denied') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      const file = served.get(path); if (!file) { response.writeHead(404); response.end(); return; }
      const bytes = readFileSync(file.file); assert.equal(hash(bytes), file.sha256); response.setHeader('Content-Type', 'text/javascript'); response.end(bytes);
    } catch (error) { serverFailure = error; response.writeHead(500); response.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const path of ['/']) {
        const context = await browser.newContext(), page = await context.newPage(), errors = [], remoteAttempts = [], consoleJobs = [];
        try {
          page.on('pageerror', error => { errors.push(error.message); pageErrors.push({ browser: engine.name(), path, message: error.message }); });
          const consoleMessages = [], consoleRecords = [];
          let absenceWindowClosed = false;
          page.on('console', message => {
            if (consoleMessages.length >= 64) { errors.push('console event bound'); return; }
            const text = message.text(); if (text.length > 4096) { errors.push('console message bound'); return; }
            consoleMessages.push(text);
            if (text === 'S15-PRIVACY-ABSENCE-WINDOW-CLOSED') absenceWindowClosed = true;
            const record = { positive: absenceWindowClosed, text, values: [] }; consoleRecords.push(record);
            const args = message.args();
            if (args.length > 16) { errors.push('console argument count bound'); return; }
            consoleJobs.push((async () => {
              for (const argument of args) record.values.push(...await argument.evaluate(async value => {
                const { inspectPrivacyValue } = await import('/s15-screen-preview-privacy.mjs');
                return inspectPrivacyValue(value);
              }));
            })().catch(error => { errors.push('console argument inspection failed: ' + String(error)); }));
          });
          await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { remoteAttempts.push(route.request().url()); blockedRequests.push({ browser: engine.name(), path, url: route.request().url() }); return route.abort(); } return route.continue(); });
          await page.goto(origin + path);
          try { await page.waitForFunction(() => globalThis.nativeReady === true || !!globalThis.bootstrapError); }
          catch (error) { throw new Error(engine.name() + ' ' + path + ': pre-nativeReady bootstrap failed; pageerrors=' + JSON.stringify(errors), { cause: error }); }
          assert.equal(await page.evaluate(() => globalThis.bootstrapError), undefined, engine.name() + ' ' + path + ': bootstrapError');
          let proof = await page.evaluate(() => globalThis.proof);
          if (path === '/') {
            await page.locator('#privacy').click();
            try { await page.waitForFunction(() => globalThis.privacyReady === true || !!globalThis.privacyError); }
            catch (error) { throw new Error(engine.name() + ': privacy observation did not settle; pageerrors=' + JSON.stringify(errors), { cause: error }); }
            assert.equal(await page.evaluate(() => globalThis.privacyError), undefined, engine.name() + ': privacyError');
            const privacy = await page.evaluate(() => globalThis.proof.privacy); assert.equal(privacy.result, 'pass'); assert.equal(privacy.nativeScreenCaptureQualified, false);
            const audit = privacy.consoleAuditForHost; assert.ok(audit && audit.rasterVariants.length === 3);
            assert.ok(consoleMessages.length <= 64 && consoleMessages.every(text => text.length <= 4096));
            await Promise.all(consoleJobs);
            for (const signature of audit.rasterVariants) assert.equal(consoleRecords.filter(item => !item.positive).some(item => item.text.includes(signature) || item.values.some(value => value.includes(signature))), false, 'Exact sampled raster representation must not appear in console absence window');
            for (const signature of audit.rasterVariants.slice(0, 2)) assert.equal(consoleRecords.filter(item => item.positive).some(item => item.values.includes(signature)), true, 'Structured console control must be detected');
            for (const label of ['S15-ARRAY-OWN-PROPERTY', 'S15-HETEROGENEOUS-ARRAY']) assert.equal(consoleRecords.some(item => item.positive && item.values.includes(label) && item.values.includes(audit.rasterVariants[1])), true, 'Array console control must be detected: ' + label);
            assert.deepEqual(errors, []);
            assert.equal(consoleMessages.includes(audit.positiveControlText), true, 'Playwright console observer must detect the positive sentinel');
            delete privacy.consoleAuditForHost; delete privacy.positiveControl.consoleControlText; proof.privacy = privacy;
            assert.equal(privacy.positiveControl.ownedStorageArtifactsRemoved, true);
          }
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedDisplayPolicy: path === '/denied' ? 'deny' : 'self', consoleObservation: { events: consoleMessages.length, structuredJobsJoined: consoleJobs.length, beforeControlEvents: consoleRecords.filter(item => !item.positive).length, positiveControlEvents: consoleRecords.filter(item => item.positive).length },
            checks: ['actual-public-preview-storage-cache-and-structured-console-through-revoke-close', 'structured-positive-controls-and-owned-container-deletion-success-readback'], proof });
        } finally { await Promise.allSettled(consoleJobs); await context.close(); assert.equal(context.pages().length, 0, engine.name() + ' ' + path + ': owned context pages must be closed'); contextsClosed++; }
      }
    } finally { await browser.close(); assert.equal(browser.isConnected(), false, engine.name() + ': owned browser must be closed'); browserHandlesClosed++; }
  }
  for (const [path, sha] of Object.entries(dependencyPins)) assert.equal(hash(readFileSync(join(root, path))), sha);
  assert.deepEqual(Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))])), fingerprints);
  receipt = { result: 'pass', mode: 'ordinary-public-source-browser',
    sourcePins: fingerprints, dependencyPins, privacyModuleSha256, hostProcessPid: process.pid, loopbackOrigin: origin, publicResolutions, resolutionProcess: resolution.diagnostic, node: process.version, typescript: ts.version,
    results, nativeScreenCaptureQualified: false, nativeHardwarePositive: false, positiveFactoryIsExplicitOwnedCanvasFixture: true, cleanup: { browsers: 0, contexts: 0, ownedListeners: 0, timers: 0, callbacks: 0, loopbackServers: 0, ownedDirectories: 0 } };
} catch (error) {
  runFailure = { name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: typeof error?.stack === 'string' ? error.stack : undefined };
  resolutionFailureEvidence = error?.resolutionRaw ? { raw: error.resolutionRaw, diagnostic: error.resolutionDiagnostic } : undefined;
  throw error;
} finally {
  try {
    writeFileSync(custodyPath, JSON.stringify({ schemaVersion: 1, mode: 'selected-source-browser-only', status: runFailure ? 'failed' : receipt?.result ?? 'incomplete',
      runId, argv: process.argv, cwd: process.cwd(), hostProcessPid: process.pid, node: process.version, typescript: ts.version,
      sourcePins: fingerprints, dependencyPins, privacyModuleSha256, resolutionEvidence,
      loopbackOrigin: server?.address() && typeof server.address() === 'object' ? `http://127.0.0.1:${server.address().port}` : undefined,
      results, pageErrors, blockedRequests, serverFailure: serverFailure ? { name: String(serverFailure?.name ?? 'Error'), message: String(serverFailure?.message ?? serverFailure), stack: typeof serverFailure?.stack === 'string' ? serverFailure.stack : undefined } : null, runFailure, resolutionFailureEvidence,
      ownedClosureAtCustody: { browserHandlesClosed, contextsClosed, serverListening: !!server?.listening, scratchExists: !!scratch && existsSync(scratch),
        browserChildPidCaptured: false, note: 'Playwright browser handles were awaited closed; driver does not expose stable browser subprocess PIDs.' }, receipt }, null, 2) + '\n');
  } finally {
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    assert.equal(server?.listening, false); assert.equal(existsSync(scratch), false);
    const custodySha256 = hash(readFileSync(custodyPath));
    writeFileSync(cleanupPath, JSON.stringify({ schemaVersion: 1, runId, custodyPath, custodySha256, hostProcessPid: process.pid,
      browserHandlesClosed, contextsClosed, loopbackServerListeningAfterClose: !!server?.listening,
      scratchRemoved: !existsSync(scratch), browserChildPidCaptured: false,
      sourceAndRawCustodyWrittenBeforeScratchRemoval: true }, null, 2) + '\n');
  }
}
assert.equal(server?.listening, false); assert.equal(existsSync(scratch), false);
console.log(JSON.stringify(receipt, null, 2));
