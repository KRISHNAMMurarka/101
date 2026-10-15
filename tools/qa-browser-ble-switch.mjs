import assert from 'node:assert/strict';
import { isSdkBrowserPublicFile } from './sdk-browser-inventory.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
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
const owned = ['packages/device-web/src/browser-ble-switch.ts', 'packages/device-web/src/browser-ble-switch.test.ts', 'examples/browser-resources/ble-switch.ts', 'tools/qa-browser-ble-switch.mjs', 'tools/sdk-browser-inventory.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const installed = args[0] === '--installed';
let consumer, scratch, dependencyPins, sourceTree, callerTree, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins, publicResolutions, immutableReadMeasurement;
const served = new Map(), results = [], fullResults = [], liveBrowsers = new Set(), liveContexts = new Set(), pages = new Set(), socketClosures = new Map();
let server, serverFailure, receipt, failure, inflightRequests = 0, launchPending = 0;
const proofDirectory = realpathSync(mkdtempSync('/tmp/101-browser-ble-switch-proof-'));
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
    scratch = realpathSync(mkdtempSync(join(consumer, 'browser-ble-switch-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/ble-switch.ts'); copy(join(root, owned[2]), leaf);
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
    diagnose(program); serve('/ble-switch-caller.mjs', join(scratch, 'compiled/ble-switch.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-browser-ble-switch-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-browser-ble-switch-')));
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
    copy(join(compiled, 'examples/browser-resources/ble-switch.js'), join(consumer, 'ble-switch-caller.mjs')); serve('/ble-switch-caller.mjs', join(consumer, 'ble-switch-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserBleSwitchProvider!=='function'||sdk.createBrowserBleSwitchProvider!==web.createBrowserBleSwitchProvider)throw Error('Public identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const resolution = spawnSync(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: scratch, env, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' });
  assert.equal(resolution.status, 0, resolution.stderr); assert.equal(resolution.stderr, '');
  publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
  const html = `<!doctype html><meta charset="utf-8"><title>Owned BLE switch diagnostic</title><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkBrowserBleSwitchWithoutDevice,runBrowserBleSwitchWorkerFixture} from '/ble-switch-caller.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(sdk.createBrowserBleSwitchProvider!==web.createBrowserBleSwitchProvider)throw Error('Public identity');try{globalThis.proof={native:await checkBrowserBleSwitchWithoutDevice(),fixture:await runBrowserBleSwitchWorkerFixture()};globalThis.ready=true;}catch(error){globalThis.bootstrapError=String(error);globalThis.ready=true;}</script>`;
  server = createServer((request, response) => {
    try {
      inflightRequests++; let ended = false; const settle = () => { if (!ended) { ended = true; inflightRequests--; } };
      response.once('finish', settle); response.once('close', settle);
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', path === '/denied' ? 'bluetooth=()' : 'bluetooth=(self)');
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
          const observed = await page.evaluate(() => ({ proof: globalThis.proof, error: globalThis.bootstrapError }));
          fullResults.push({ browser: engine.name(), version: browser.version(), requestedBluetoothPolicy: path === '/denied' ? 'deny' : 'self', observed });
          assert.equal(observed.error, undefined); const proof = observed.proof, native = proof.native, fixture = proof.fixture;
          assert.equal(native.kind, 'actual-browser-native-availability-negative'); assert.equal(native.physicalBleQualification, false);
          assert.equal(native.nativeChooserOpened, false); assert.equal(native.captureApprovals, 0); assert.equal(native.selection.ok, false);
          assert.equal(native.initial.listeners, 0); assert.equal(native.initial.activeSources, 0); assert.equal(native.initial.nativePending, 0);
          assert.equal(native.initial.timerArmed, false); assert.equal(native.initial.waitTimerArmed, false);
          assert.equal(native.final.rawPending, 0); assert.equal(native.final.phase, 'closed'); assert.equal(native.final.listeners, 0); assert.equal(native.final.nativePending, 0);
          assert.equal(native.final.cleanupPending, 0); assert.equal(native.final.cleanupFailed, false);
          assert.equal(native.final.activeSources, 0); assert.equal(native.final.timerArmed, false); assert.equal(native.final.waitTimerArmed, false);
          assert.equal(fixture.kind, 'owned-native-worker-through-trusted-software-gatt-port'); assert.equal(fixture.physicalBleQualification, false);
          assert.equal(fixture.softwareUuidFixture, true); assert.equal(fixture.softwareClock, true); assert.equal(fixture.workerReplies, 5);
          assert.equal(fixture.press.held, true); assert.equal(fixture.release.held, false); assert.equal(fixture.pressAgain.held, true);
          assert.equal(fixture.press.delivered, 1); assert.equal(fixture.release.delivered, 2); assert.equal(fixture.pressAgain.delivered, 3);
          assert.equal(fixture.press.lastObservation.value.channel, 'switch-0'); assert.equal(fixture.press.lastObservation.clockDomain, 'ble-javascript-receipt');
          assert.equal(fixture.press.lastObservation.provenance.captureTimeKnown, false); assert.equal(fixture.press.lastObservation.provenance.clockMappingEstablished, false);
          assert.equal(fixture.revoked.held, false); assert.ok(fixture.revoked.releases > 0); assert.equal(fixture.late.delivered, 3);
          assert.equal(fixture.late.held, false); assert.equal(fixture.retried.ok, false); assert.equal(fixture.retried.reason, 'denied');
          assert.equal(fixture.recovered.held, true); assert.equal(fixture.recovered.delivered, 4);
          assert.ok(fixture.generations.recovered > fixture.generations.first); assert.equal(fixture.final.rawPending, 0);
          assert.equal(fixture.final.activeSources, 0); assert.equal(fixture.final.listeners, 0); assert.equal(fixture.final.nativePending, 0);
          assert.equal(fixture.final.cleanupPending, 0); assert.equal(fixture.final.cleanupFailed, false);
          assert.equal(fixture.final.timerArmed, false); assert.equal(fixture.final.waitTimerArmed, false);
          assert.deepEqual(fixture.softwarePort, { requestDeviceCalls: 3, connects: 2, disconnects: 2, connected: false, starts: 2, stops: 2, notifying: false });
          assert.deepEqual(fixture.cleanup, { workerTerminated: true, urlRevoked: true, timerCleared: true, callbacksCleared: true, pendingReplies: 0 });
          assert.deepEqual(fixture.bounds, { callerReliableQueue: 8, callerPendingDeliveries: 1, notificationBytes: 1, workerPending: 1, workerReplies: 5 });
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedBluetoothPolicy: path === '/denied' ? 'deny' : 'self',
            checks: ['ordinary-public-facade-identity', 'actual-native-api-policy-activation-no-chooser', 'inert-default-no-grants-sources-listeners',
              'native-negative-clean-close', 'actual-owned-worker-through-trusted-software-gatt', 'one-byte-notification-real-EventTarget-DataView',
              'existing-switch-schema-independent-runtime-route', 'press-release-press-transitions', 'js-receipt-not-hardware-capture',
              'intrinsic-capture-revoke-neutral-release', 'late-worker-byte-no-effect', 'fresh-choice-revoked-grant-refused',
              'fresh-current-consent-and-generation-recovery', 'eight-reliable-one-pending-route', 'owned-worker-gatt-cleanup'],
            native: { ...native.native, availability: native.availability, selection: native.selection, captureApprovals: native.captureApprovals, nativeChooserOpened: false },
            software: { workerReplies: fixture.workerReplies, values: [fixture.press.held, fixture.release.held, fixture.pressAgain.held, fixture.late.held, fixture.recovered.held],
              deliveries: [fixture.press.delivered, fixture.release.delivered, fixture.pressAgain.delivered, fixture.late.delivered, fixture.recovered.delivered],
              generations: fixture.generations, port: fixture.softwarePort, final: fixture.final, cleanup: fixture.cleanup, bounds: fixture.bounds } });
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
    physicalBleQualification: false, nativeBlePositiveClaimed: false, trustedSoftwareGattPorts: true, browserInternalQuiescenceMeasured: false };
} catch (error) {
  failure = error;
  receipt = { result: 'fail', mode: installed ? 'ordinary-installed-immutable-sdk-browser' : 'ordinary-public-source-browser',
    sourcePins: fingerprints, node: process.version, typescript: ts.version, results,
    failure: { name: error instanceof Error ? error.name : 'unknown', message: String(error instanceof Error ? error.message : error).slice(0, 768) },
    physicalBleQualification: false, nativeBlePositiveClaimed: false, browserInternalQuiescenceMeasured: false };
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
