import assert from 'node:assert/strict';
import { isSdkBrowserPublicFile } from './sdk-browser-inventory.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import ts from 'typescript';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 4 && args[0] === '--installed',
  'Use --source or --installed <manifest> <clean-consumer> <immutable-caller-tree>');
assert.equal(process.version, 'v24.14.0');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/browser-serial-switch.ts', 'packages/device-web/src/browser-serial-switch.test.ts', 'examples/browser-resources/serial-switch-output.ts', 'tools/qa-serial-switch-output.mjs', 'tools/sdk-browser-inventory.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const installed = args[0] === '--installed';
let consumer, scratch, dependencyPins, sourceTree, callerTree, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins, publicResolutions, immutableReadMeasurement;
const served = new Map(), results = [], fullResults = [], liveBrowsers = new Set(), liveContexts = new Set(), pages = new Set(), socketClosures = new Map();
let server, serverFailure, receipt, failure, inflightRequests = 0, launchPending = 0;
const proofDirectory = realpathSync(mkdtempSync('/tmp/101-serial-switch-output-proof-'));
const provenancePath = join(proofDirectory, 'provenance.json');
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
function json(path) { return JSON.parse(bytes(path)); }
function gitBlobs(inputs) {
  for (const { paths } of inputs) for (const path of paths) assert.ok(typeof path === 'string' && path.length <= 1024 &&
    ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && !isAbsolute(path) && resolve(root, path).startsWith(root + sep));
  const requests = [...new Set(inputs.flatMap(({ tree, paths }) => paths.map(path => tree + ':' + path)))];
  assert.ok(requests.length > 0 && requests.length <= 1024);
  const started = performance.now();
  const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: requests.join('\n') + '\n',
    timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const blobs = new Map(); let offset = 0;
  for (const request of requests) {
    const end = output.indexOf(10, offset); assert.ok(end >= 0, 'Missing immutable blob header');
    const fields = output.subarray(offset, end).toString().split(' ');
    assert.equal(fields.length, 3); assert.match(fields[0], /^[0-9a-f]{40}$/); assert.equal(fields[1], 'blob');
    const size = Number(fields[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    offset = end + 1; assert.ok(offset + size < output.length);
    blobs.set(request, output.subarray(offset, offset + size)); offset += size;
    assert.equal(output[offset++], 10);
  }
  assert.equal(offset, output.length);
  return { blobs, measurement: { requests: requests.length, bytes: output.length, elapsedMs: performance.now() - started, nativeGitProcesses: 1 } };
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function serve(url, file) { assert.equal(realpathSync(file), file); assert.equal(lstatSync(file).isFile(), true); assert.equal(served.has(url), false); served.set(url, { file, sha256: hash(bytes(file)) }); }
function diagnose(program) {
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
}
function checkInstalled(manifest) {
  installedBytes = {}; tarballPins = {};
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
  const output = realpathSync(manifest.outputDir); assert.ok(output.startsWith(join(realpathSync(join(root, 'release')), 'sdk-')));
  assert.ok(immutableManifest.path.startsWith(output + sep));
  for (const item of manifest.packages) {
    assert.ok(isAbsolute(item.tarball)); assert.equal(realpathSync(item.tarball), item.tarball); assert.ok(item.tarball.startsWith(output + sep));
    assert.match(item.sha256, /^[0-9a-f]{64}$/); const archive = bytes(item.tarball, 8 * 1024 * 1024);
    assert.equal(hash(archive), item.sha256); assert.equal(archive.byteLength, item.bytes); tarballPins[item.tarball] = item.sha256;
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const paths = item.files.map(file => {
      assert.ok(typeof file.path === 'string' && file.path && !isAbsolute(file.path) && !file.path.split('/').includes('..'));
      assert.ok(isSdkBrowserPublicFile(item.name, file.path));
      assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 4 * 1024 * 1024); return file.path;
    });
    assert.equal(new Set(paths).size, paths.length);
    const archivePaths = execFileSync('tar', ['-tzf', item.tarball], { timeout: 5000, maxBuffer: 1048576, encoding: 'utf8' }).trim().split('\n');
    assert.ok(archivePaths.every(path => path.startsWith('package/') && !path.split('/').includes('..')));
    assert.deepEqual(archivePaths.filter(path => !path.endsWith('/')).map(path => path.slice(8)).sort(), [...paths].sort());
    const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
    assert.deepEqual(files(prefix).map(path => relative(prefix, path)).sort(), [...paths].sort(), 'Closed installed inventory: ' + item.name);
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path);
      const actual = bytes(path); assert.equal(actual.byteLength, file.size); assert.equal(hash(actual), file.sha256);
      installedBytes[item.name + '/' + file.path] = file.sha256;
      serve(`/sdk/${item.name.slice(5)}/${file.path}`, path);
    }
  }
}
try {
  if (installed) {
    consumer = realpathSync(resolve(args[2])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const packed = json(join(consumer, 'receipt.json')); assert.equal(packed.status, 'pass');
    const manifestPath = realpathSync(resolve(args[1])); assert.equal(manifestPath, packed.manifest.path);
    const manifestBytes = bytes(manifestPath); assert.equal(hash(manifestBytes), packed.manifest.sha256);
    const manifest = JSON.parse(manifestBytes); assert.equal(manifest.schemaVersion, 1);
    sourceTree = manifest.source.tree; callerTree = args[3]; assert.match(sourceTree, /^[0-9a-f]{40}$/); assert.match(callerTree, /^[0-9a-f]{40}$/);
    assert.equal(packed.source.tree, sourceTree); assert.deepEqual(manifest.source.sha256, packed.source.sha256);
    dependencyPins = manifest.source.sha256; assert.ok(Object.keys(dependencyPins).length > 0 && Object.keys(dependencyPins).length <= 512);
    const immutable = gitBlobs([{ tree: sourceTree, paths: Object.keys(dependencyPins) },
      { tree: callerTree, paths: [...Object.keys(fingerprints), ...Object.keys(dependencyPins)] }]); immutableReadMeasurement = immutable.measurement;
    for (const [path, pin] of Object.entries(fingerprints)) assert.equal(hash(immutable.blobs.get(callerTree + ':' + path)), pin, 'Immutable caller mismatch: ' + path);
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]], 'Manifest must include the actual new provider');
    for (const [path, pin] of Object.entries(dependencyPins)) {
      assert.ok(!isAbsolute(path) && resolve(root, path).startsWith(root + sep)); assert.match(pin, /^[0-9a-f]{64}$/);
      for (const tree of new Set([sourceTree, callerTree])) assert.equal(hash(immutable.blobs.get(tree + ':' + path)), pin, 'Immutable SDK source mismatch: ' + path);
      assert.equal(hash(bytes(join(root, path))), pin, 'Current SDK source mismatch: ' + path);
    }
    immutableManifest = { path: manifestPath, sha256: packed.manifest.sha256 };
    checkInstalled(manifest);
    scratch = realpathSync(mkdtempSync(join(consumer, 'serial-switch-output-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/serial-switch-output.ts'); copy(join(root, owned[2]), leaf);
    const program = ts.createProgram([leaf], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true, types: [], skipLibCheck: false,
      noEmitOnError: true, rootDir: join(scratch, 'source'), outDir: join(scratch, 'compiled') });
    assert.deepEqual(program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => file.fileName), [leaf], 'Compile only the ordinary caller');
    const library = realpathSync(join(root, 'node_modules/typescript/lib'));
    const declarations = program.getSourceFiles().filter(file => file.isDeclarationFile); assert.ok(declarations.length > 0 && declarations.length <= 1024);
    for (const file of declarations) {
      const actual = realpathSync(file.fileName); assert.ok(actual.startsWith(join(consumer, 'node_modules') + sep) || actual.startsWith(library + sep), 'Declaration escaped installed SDK/compiler');
    }
    compilerDeclarationPins = Object.fromEntries(declarations.map(file => [realpathSync(file.fileName), hash(bytes(realpathSync(file.fileName)))]));
    diagnose(program); serve('/serial-output-caller.mjs', join(scratch, 'compiled/serial-switch-output.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-serial-switch-output-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-serial-switch-output-')));
    const compiled = join(consumer, '.compiled'), roots = [...names.map(name => join(root, `packages/${name}/src/index.ts`)), join(root, owned[2])];
    const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true, noUncheckedIndexedAccess: true, types: [], skipLibCheck: false, noEmitOnError: true,
      rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])) });
    const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    assert.ok(sources.length > 0 && sources.length <= 512 && sources.every(file => file.fileName === join(root, owned[2]) || names.some(name => file.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !file.fileName.endsWith('.test.ts')));
    diagnose(program); dependencyPins = Object.fromEntries(sources.map(file => [relative(root, file.fileName), hash(bytes(file.fileName))]));
    const declarations = program.getSourceFiles().filter(file => file.isDeclarationFile); assert.ok(declarations.length > 0 && declarations.length <= 1024);
    compilerDeclarationPins = Object.fromEntries(declarations.map(file => [realpathSync(file.fileName), hash(bytes(realpathSync(file.fileName)))]));
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]]);
    for (const name of names) {
      const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
      for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
      for (const file of files(destination)) serve(`/sdk/${name}/${relative(destination, file).split(sep).join('/')}`, file);
    }
    copy(join(compiled, 'examples/browser-resources/serial-switch-output.js'), join(consumer, 'serial-output-caller.mjs')); serve('/serial-output-caller.mjs', join(consumer, 'serial-output-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserSerialSwitchProvider!=='function'||sdk.createBrowserSerialSwitchProvider!==web.createBrowserSerialSwitchProvider)throw Error('Public identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const resolution = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, error;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 5000);
    const collect = (kind, value) => { if (kind === 'stdout') stdout += value.toString('utf8'); else stderr += value.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { error = new Error('Resolution byte bound'); child.kill('SIGTERM'); } };
    child.stdout.on('data', value => collect('stdout', value)); child.stderr.on('data', value => collect('stderr', value));
    child.on('error', value => { error = value; }); child.on('close', (status, signal) => { clearTimeout(timer);
      if (error) rejectRun(error); else if (timedOut) rejectRun(new Error('Resolution deadline5000ms: ' + signal)); else resolveRun({ status, stdout, stderr }); });
  });
  assert.equal(resolution.status, 0, resolution.stderr); assert.equal(resolution.stderr, '');
  publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
  const html = `<!doctype html><meta charset="utf-8"><title>Owned Serial output diagnostic</title><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkSerialSwitchOutputWithoutDevice,runSerialSwitchOutputWorkerFixture} from '/serial-output-caller.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
globalThis.defaultSerialChoosers=0;if(navigator.serial&&typeof navigator.serial.requestPort==='function')navigator.serial.requestPort=()=>{globalThis.defaultSerialChoosers++;throw Error('User Serial chooser forbidden');};
try{if(sdk.createBrowserSerialSwitchProvider!==web.createBrowserSerialSwitchProvider)throw Error('Public identity');globalThis.proof={negative:await checkSerialSwitchOutputWithoutDevice(),fixture:await runSerialSwitchOutputWorkerFixture()};globalThis.ready=true;}catch(error){globalThis.bootstrapError=String(error);globalThis.ready=true;}</script>`;
  server = createServer((request, response) => {
    try {
      inflightRequests++; let ended = false; const settle = () => { if (!ended) { ended = true; inflightRequests--; } };
      response.once('finish', settle); response.once('close', settle);
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', path === '/denied' ? 'serial=()' : 'serial=(self)');
      if (path === '/' || path === '/denied') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      const file = served.get(path); if (!file) { response.writeHead(404); response.end(); return; }
      const bytes = readFileSync(file.file); assert.equal(hash(bytes), file.sha256); response.setHeader('Content-Type', 'text/javascript'); response.end(bytes);
    } catch (error) { serverFailure = error; if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  server.on('connection', socket => {
    let finish; const settled = new Promise(resolveClose => { finish = resolveClose; }); socketClosures.set(socket, settled);
    socket.once('close', () => { socketClosures.delete(socket); finish(); });
    if (socketClosures.size > 64) { serverFailure = new Error('Owned HTTP socket quota'); socket.destroy(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const engine of [chromium, webkit]) {
    launchPending++; let browser; try { browser = await engine.launch({ headless: true }); liveBrowsers.add(browser); } finally { launchPending--; }
    try {
      for (const path of ['/', '/denied']) {
        const context = await browser.newContext(); liveContexts.add(context); const page = await context.newPage(); pages.add(page);
        const errors = [], remoteAttempts = [];
        try {
          page.on('pageerror', error => errors.push(error.message));
          await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { remoteAttempts.push(route.request().url()); return route.abort(); } return route.continue(); });
          await page.goto(origin + path); await page.waitForFunction(() => globalThis.ready === true, undefined, { timeout: 10000 });
          const observed = await page.evaluate(() => ({ proof: globalThis.proof, error: globalThis.bootstrapError, defaultSerialChoosers: globalThis.defaultSerialChoosers }));
          fullResults.push({ browser: engine.name(), version: browser.version(), requestedSerialPolicy: path === '/denied' ? 'deny' : 'self', observed });
          assert.equal(observed.error, undefined); assert.equal(observed.defaultSerialChoosers, 0);
          const negative = observed.proof.negative, fixture = observed.proof.fixture;
          assert.equal(negative.kind, 'inert-default-serial-output-negative'); assert.equal(negative.physicalSerialQualification, false);
          assert.equal(negative.captureApprovals, 0); assert.equal(negative.outputApprovals, 0);
          assert.equal(negative.report.ok, false); assert.equal(negative.bound.ok, false);
          assert.equal(negative.nativeChoosers, 0); assert.equal(negative.nativeOpens, 0); assert.equal(negative.nativeWrites, 0);
          assert.equal(negative.initial.provider.nativePending, 0); assert.equal(negative.initial.provider.activeSources, 0); assert.equal(negative.initial.provider.listeners, 0);
          assert.equal(negative.final.provider.phase, 'closed'); assert.equal(negative.final.provider.nativePending, 0); assert.equal(negative.final.provider.nativePending, 0);
          assert.equal(negative.final.output.rawPending, 0); assert.equal(negative.final.output.activeSinks, 0); assert.equal(negative.final.output.listeners, 0);
          assert.equal(fixture.kind, 'owned-native-worker-streams-serial-output-software-profile'); assert.equal(fixture.physicalSerialQualification, false);
          assert.equal(fixture.syntheticSerialProtocol, true); assert.equal(fixture.trustedSoftwareSerial, true);
          assert.equal(fixture.deniedOwner.ok, false); assert.equal(fixture.deniedRoute.ok, false); assert.equal(fixture.retained.provider.activeSources, 1);
          assert.equal(fixture.apiReturn.output.records.at(-1).outcome, 'api-returned'); assert.equal(fixture.apiReturn.delivered, fixture.retained.delivered);
          assert.equal(fixture.reportedTrue.held, true); assert.equal(fixture.reportedFalse.held, false);
          assert.equal(fixture.reportedTrue.delivered, fixture.retained.delivered + 1); assert.equal(fixture.reportedFalse.delivered, fixture.retained.delivered + 4);
          assert.equal(fixture.reportedTrue.lastObservation.value.channel, 'switch-0'); assert.equal(fixture.reportedTrue.lastObservation.clockDomain, 'serial-output-host-receipt');
          assert.equal(fixture.reportedTrue.lastObservation.provenance.captureTimeKnown, false); assert.equal(fixture.reportedTrue.lastObservation.provenance.clockMappingEstablished, false);
          assert.equal(fixture.nativeWrites, 3); assert.equal(fixture.workerReplies, 11); assert.equal(fixture.heldIssued, 1); assert.equal(fixture.producerEmissions.length, 7);
          assert.ok(fixture.producerEmissions.every(item => item.sourceTime.clockId.startsWith('owned-worker-performance:') && Number.isFinite(item.sourceTime.at)));
          assert.ok(new Set(fixture.producerEmissions.map(item => item.sourceTime.clockId)).size === 1);
          assert.equal(fixture.afterStop.held, false); assert.equal(fixture.afterStop.provider.activeSources, 0); assert.equal(fixture.afterStop.output.activeSinks, 0);
          assert.equal(fixture.afterStop.output.records.at(-1).outcome, 'uncertain'); assert.ok(fixture.afterStop.provider.nativePending > 0 && fixture.afterStop.provider.nativePending <= 3);
          assert.equal(fixture.beforeNativeReturn.closed, false); assert.equal(fixture.beforeNativeReturn.pendingRequests, 1);
          assert.equal(fixture.final.provider.phase, 'closed'); assert.equal(fixture.final.provider.nativePending, 0);
          assert.equal(fixture.final.provider.cleanupPending, 0); assert.equal(fixture.final.provider.cleanupFailed, false); assert.equal(fixture.final.provider.listeners, 0);
          assert.equal(fixture.final.provider.timerArmed, false); assert.equal(fixture.final.provider.waitTimerArmed, false);
          assert.equal(fixture.final.output.activeSinks, 0); assert.equal(fixture.final.output.rawPending, 0); assert.equal(fixture.final.output.listeners, 0);
          assert.equal(fixture.final.output.cleanupFailed, false); assert.equal(fixture.final.output.writerLocks, 0); assert.equal(fixture.final.output.writePending, 0);
          assert.equal(fixture.final.provider.readerLocks, 0); assert.equal(fixture.final.provider.readPending, 0); assert.equal(fixture.final.provider.cancelPending, 0); assert.equal(fixture.final.provider.closePending, 0); assert.equal(fixture.final.provider.readTimerArmed, false);
          assert.equal(fixture.port.readable, false); assert.equal(fixture.port.writable, false); assert.equal(fixture.port.closes, 2); assert.ok(fixture.recoveredGeneration > 1);
          assert.ok(fixture.final.output.records.every(item => item.physical === 'unverified'));
          assert.equal(fixture.cleanup.workerTerminateReturned, true); assert.equal(fixture.cleanup.nativeWorkerExitObserved, false);
          assert.equal(fixture.cleanup.workerListeners, 0); assert.equal(fixture.cleanup.pendingRequests, 0); assert.equal(fixture.cleanup.timers, 0); assert.equal(fixture.cleanup.actualProviderRaw, 0);
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedSerialPolicy: path === '/denied' ? 'deny' : 'self',
            checks: ['ordinary-public-facade-identity', 'inert-default-no-native-chooser', 'capture-and-output-denial-separate', 'invoke-route-denial',
              'notification-incumbent-retained', 'actual-owned-worker-software-setting', 'one-byte-native-stream-writer-only', 'api-return-not-notification',
              'independent-typed-true-false-notifications', 'worker-emission-versus-host-receipt', 'fresh-capture-output-generation', 'held-issued-native-response',
              'stop-releases-local-authority-no-reset', 'close-waits-actual-write-response', 'owned-read-write-lock-reservation-and-cleanup'],
            native: { chooserCalls: observed.defaultSerialChoosers, availability: negative.availability, physicalSerialQualification: false },
            software: { nativeWrites: fixture.nativeWrites, workerReplies: fixture.workerReplies, heldIssued: fixture.heldIssued,
              delivered: [fixture.apiReturn.delivered, fixture.reportedTrue.delivered, fixture.reportedFalse.delivered], sourceClocks: fixture.producerEmissions.map(item => item.sourceTime.clockId),
              final: { provider: fixture.final.provider, output: fixture.final.output }, cleanup: fixture.cleanup } });
        } finally { await context.close(); liveContexts.delete(context); }
      }
    } finally { await browser.close(); liveBrowsers.delete(browser); }
  }
  for (const [path, sha] of Object.entries(dependencyPins)) assert.equal(hash(readFileSync(join(root, path))), sha);
  assert.deepEqual(Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))])), fingerprints);
  if (installed) {
    for (const [path, pin] of Object.entries(installedBytes)) assert.equal(hash(bytes(join(consumer, 'node_modules', path))), pin);
    for (const [path, pin] of Object.entries(tarballPins)) assert.equal(hash(bytes(path, 8 * 1024 * 1024)), pin);
    for (const [path, pin] of Object.entries(compilerDeclarationPins)) assert.equal(hash(bytes(path)), pin);
    assert.equal(hash(bytes(immutableManifest.path)), immutableManifest.sha256);
  }
  receipt = { result: 'pass', mode: installed ? 'ordinary-installed-immutable-sdk-browser' : 'ordinary-public-source-browser',
    ...(installed ? { sourceTree, callerTree, immutableManifest, installedConsumerRetained: consumer } : {}),
    sourcePins: fingerprints, node: process.version, typescript: ts.version, results,
    physicalSerialQualification: false, nativeSerialPositiveClaimed: false, writeResponseIsDeviceState: false, trustedSoftwareSerialPorts: true, browserInternalQuiescenceMeasured: false };
} catch (error) {
  failure = error;
  receipt = { result: 'fail', mode: installed ? 'ordinary-installed-immutable-sdk-browser' : 'ordinary-public-source-browser',
    sourcePins: fingerprints, node: process.version, typescript: ts.version, results,
    failure: { name: error instanceof Error ? error.name : 'unknown', message: String(error instanceof Error ? error.message : error).slice(0, 768) },
    physicalSerialQualification: false, nativeSerialPositiveClaimed: false, browserInternalQuiescenceMeasured: false };
} finally {
  const cleanupErrors = [];
  for (const context of liveContexts) { try { await context.close(); liveContexts.delete(context); } catch (error) { cleanupErrors.push(String(error).slice(0, 256)); } }
  for (const browser of liveBrowsers) { try { await browser.close(); liveBrowsers.delete(browser); } catch (error) { cleanupErrors.push(String(error).slice(0, 256)); } }
  if (server?.listening) { const closed = new Promise(resolveClose => server.close(resolveClose)); server.closeAllConnections(); await closed; }
  if (socketClosures.size) await Promise.all([...socketClosures.values()]);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  const cleanup = { browsers: [...liveBrowsers].filter(browser => browser.isConnected()).length, contexts: liveContexts.size,
    pages: [...pages].filter(page => !page.isClosed()).length, launchPending, loopbackServerListening: server?.listening === true,
    nativeHttpSockets: socketClosures.size, inflightRequests, callerDirectoryRemoved: !scratch || !existsSync(scratch),
    installedConsumerRetained: !installed || existsSync(consumer), errors: cleanupErrors };
  if (!receipt) receipt = { result: 'fail', mode: installed ? 'ordinary-installed-immutable-sdk-browser' : 'ordinary-public-source-browser', sourcePins: fingerprints };
  receipt.cleanup = cleanup;
  if (cleanup.browsers || cleanup.contexts || cleanup.pages || cleanup.launchPending || cleanup.loopbackServerListening || cleanup.nativeHttpSockets ||
    cleanup.inflightRequests || !cleanup.callerDirectoryRemoved || !cleanup.installedConsumerRetained || cleanupErrors.length) {
    receipt.result = 'fail'; failure ??= new Error('Actual owned cleanup incomplete');
  }
  const provenance = { schemaVersion: 1, sourcePins: fingerprints, dependencyPins, sourceTree, callerTree, immutableManifest, installedBytes,
    tarballPins, compilerDeclarationPins, publicResolutions, immutableReadMeasurement, fullResults, cleanup, failure: failure instanceof Error ? failure.stack?.slice(0, 8192) : undefined };
  const serialized = JSON.stringify(provenance, null, 2) + '\n'; assert.ok(Buffer.byteLength(serialized) <= 1048576); writeFileSync(provenancePath, serialized);
  receipt.provenance = { path: provenancePath, sha256: hash(Buffer.from(serialized)), dependencyCount: Object.keys(dependencyPins ?? {}).length,
    installedFileCount: Object.keys(installedBytes ?? {}).length, compilerDeclarationCount: Object.keys(compilerDeclarationPins ?? {}).length };
}
const output = JSON.stringify(receipt) + '\n'; assert.ok(Buffer.byteLength(output) <= 16384, 'Bounded redacted receipt including newline');
process.stdout.write(output);
if (failure) { process.exitCode = 1; process.stderr.write((failure instanceof Error ? failure.stack : String(failure)).slice(0, 8192) + '\n'); }

