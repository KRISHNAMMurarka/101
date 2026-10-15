import { isSdkBrowserPublicFile } from './sdk-browser-inventory.mjs';
import assert from 'node:assert/strict';
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
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/browser-camera.ts', 'packages/device-web/src/browser-camera.test.ts', 'examples/browser-resources/camera-controls.ts', 'tools/qa-camera-controls.mjs', 'tools/sdk-browser-inventory.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const installed = args[0] === '--installed';
let consumer, scratch, dependencyPins, sourceTree, callerTree, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins;
const served = new Map(), results = []; let server, serverFailure, receipt;
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
function gitBlobs(queries) {
  const keys = [...new Set(queries)]; assert.ok(keys.length > 0 && keys.length <= 1028);
  for (const key of keys) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
  const response = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: keys.join('\n') + '\n', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  const values = new Map(); let cursor = 0;
  for (const key of keys) {
    const end = response.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128);
    const header = response.subarray(cursor, end).toString('ascii').match(/^([0-9a-f]{40}) blob ([0-9]+)$/); assert.ok(header, 'Closed Git batch blob header');
    const size = Number(header[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    const first = end + 1, last = first + size; assert.ok(last < response.byteLength); assert.equal(response[last], 10);
    values.set(key, hash(response.subarray(first, last))); cursor = last + 1;
  }
  assert.equal(cursor, response.byteLength); assert.equal(values.size, keys.length); return values;
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
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]], 'Manifest must include the actual new provider');
    const queries = Object.keys(fingerprints).map(path => callerTree + ':' + path);
    for (const [path, pin] of Object.entries(dependencyPins)) {
      assert.ok(!isAbsolute(path) && resolve(root, path).startsWith(root + sep) && !path.split('/').includes('..')); assert.match(pin, /^[0-9a-f]{64}$/);
      for (const tree of new Set([sourceTree, callerTree])) queries.push(tree + ':' + path);
      assert.equal(hash(bytes(join(root, path))), pin, 'Current SDK source mismatch: ' + path);
    }
    const blobs = gitBlobs(queries);
    for (const [path, pin] of Object.entries(fingerprints)) assert.equal(blobs.get(callerTree + ':' + path), pin, 'Immutable caller mismatch: ' + path);
    for (const [path, pin] of Object.entries(dependencyPins)) for (const tree of new Set([sourceTree, callerTree])) assert.equal(blobs.get(tree + ':' + path), pin, 'Immutable SDK source mismatch: ' + path);
    immutableManifest = { path: manifestPath, sha256: packed.manifest.sha256 };
    checkInstalled(manifest);
    scratch = realpathSync(mkdtempSync(join(consumer, 'camera-controls-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/camera-controls.ts'); copy(join(root, owned[2]), leaf);
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
    diagnose(program); serve('/camera-caller.mjs', join(scratch, 'compiled/camera-controls.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-camera-controls-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-camera-controls-')));
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
    copy(join(compiled, 'examples/browser-resources/camera-controls.js'), join(consumer, 'camera-caller.mjs')); serve('/camera-caller.mjs', join(consumer, 'camera-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserCameraProvider!=='function'||sdk.createBrowserCameraProvider!==web.createBrowserCameraProvider)throw Error('Public identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const resolution = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, failure;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 5000);
    function collect(kind, value) { if (kind === 'stdout') stdout += value.toString('utf8'); else stderr += value.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { failure = new Error('Resolution output bound'); child.kill('SIGTERM'); } }
    child.stdout.on('data', value => collect('stdout', value)); child.stderr.on('data', value => collect('stderr', value));
    child.on('error', error => { failure = error; }); child.on('close', (status, signal) => { clearTimeout(timer);
      if (failure) rejectRun(failure); else if (timedOut) rejectRun(new Error('Resolution deadline5000ms: ' + signal)); else resolveRun({ status, stdout, stderr }); });
  });
  assert.equal(resolution.status, 0, resolution.stderr); assert.equal(resolution.stderr, '');
  const publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
  const html = `<!doctype html><meta charset="utf-8"><title>Owned camera controls diagnostic</title><button type="button">Run owned native canvas fixture</button><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkCameraControlsWithoutDevice,runOwnedCameraControlsCanvas,runSoftwareCameraZoom} from '/camera-caller.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
globalThis.defaultCameraAttempts=0;globalThis.defaultCameraInspections=0;if(navigator.mediaDevices&&typeof navigator.mediaDevices.enumerateDevices==='function')navigator.mediaDevices.enumerateDevices=()=>{globalThis.defaultCameraInspections++;throw Error('User device enumeration forbidden');};if(navigator.mediaDevices&&typeof navigator.mediaDevices.getUserMedia==='function')navigator.mediaDevices.getUserMedia=()=>{globalThis.defaultCameraAttempts++;throw Error('User camera acquisition forbidden in this owned page');};
try{if(sdk.createBrowserCameraProvider!==web.createBrowserCameraProvider)throw Error('Public identity');globalThis.proof={negative:await checkCameraControlsWithoutDevice()};globalThis.nativeReady=true;document.querySelector('button').onclick=async()=>{try{globalThis.proof.canvas=await runOwnedCameraControlsCanvas();globalThis.proof.software=await runSoftwareCameraZoom();globalThis.ready=true;}catch(error){globalThis.fixtureError=String(error);}};}catch(error){globalThis.bootstrapError=String(error);}</script>`;
  server = createServer((request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', path === '/denied' ? 'camera=()' : 'camera=(self)');
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
      for (const path of ['/', '/denied']) {
        const context = await browser.newContext(), page = await context.newPage(), errors = [], remoteAttempts = [];
        try {
          page.on('pageerror', error => errors.push(error.message));
          await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { remoteAttempts.push(route.request().url()); return route.abort(); } return route.continue(); });
          await page.goto(origin + path);
          try { await page.waitForFunction(() => globalThis.nativeReady === true || !!globalThis.bootstrapError); }
          catch (error) { throw new Error(engine.name() + ' ' + path + ': pre-nativeReady bootstrap failed; pageerrors=' + JSON.stringify(errors), { cause: error }); }
          assert.equal(await page.evaluate(() => globalThis.bootstrapError), undefined, engine.name() + ' ' + path + ': bootstrapError');
          await page.locator('button').click();
          try { await page.waitForFunction(() => globalThis.ready === true || !!globalThis.fixtureError); }
          catch (error) { throw new Error(engine.name() + ' ' + path + ': owned producer did not settle after gesture; pageerrors=' + JSON.stringify(errors), { cause: error }); }
          assert.equal(await page.evaluate(() => globalThis.fixtureError), undefined, engine.name() + ' ' + path);
          const proof = await page.evaluate(() => globalThis.proof), negative = proof.negative, fixture = proof.canvas, software = proof.software;
          assert.equal(negative.kind, 'inert-camera-controls-negative'); assert.equal(negative.positiveHardwareEvidence, false);
          assert.equal(await page.evaluate(() => globalThis.defaultCameraInspections), 0); assert.equal(negative.nativeAcquisitions, 0); assert.equal(negative.nativeConstraintCalls, 0);
          assert.equal(negative.captureApprovals, 0); assert.equal(negative.controlApprovals, 0);
          assert.equal(negative.initial.listeners, 0); assert.equal(negative.initial.rawPending, 0); assert.equal(negative.initial.activeSources, 0);
          assert.equal(negative.report.ok, false); assert.equal(negative.binding.ok, false); assert.equal(await page.evaluate(() => globalThis.defaultCameraAttempts), 0);
          assert.equal(negative.final.phase, 'closed'); assert.equal(negative.final.listeners, 0); assert.equal(negative.final.rawPending, 0); assert.equal(negative.control.rawPending, 0);
          assert.equal(fixture.kind, 'owned-native-canvas-no-zoom'); assert.equal(fixture.result, 'pass'); assert.equal(fixture.positiveHardwareEvidence, false);
          assert.equal(fixture.captureApprovals, 1); assert.equal(fixture.controlApprovals, 0); assert.equal(fixture.constraints, 0);
          assert.equal(fixture.report.ok, true); assert.equal(fixture.report.value.zoom.state, 'unsupported'); assert.equal(fixture.report.value.opticalVerification, false);
          assert.equal(fixture.binding.ok, false); assert.equal(fixture.binding.reason, 'unsupported'); assert.ok(fixture.frames >= 2 && fixture.frames <= 80);
          const red = fixture.red.latest, changed = fixture.changed.latest;
          for (const [observation, channel] of [[red, 0], [changed, 2]]) {
            assert.equal(observation.value.format, 'rgba8'); assert.equal(observation.value.width, 8); assert.equal(observation.value.height, 8); assert.equal(observation.value.rows.length, 8);
            for (const row of observation.value.rows) { assert.equal(row.length, 32); for (let index = 0; index < row.length; index++) { assert.ok(Number.isInteger(row[index]) && row[index] >= 0 && row[index] <= 255); assert.ok(index % 4 === channel || index % 4 === 3 ? row[index] >= 240 : row[index] <= 16); } }
            assert.equal(observation.clockDomain, 'camera-controls-js-retrieval'); assert.equal(observation.provenance.factoryKind, 'owned-canvas-fixture');
            assert.equal(observation.provenance.captureTimeKnown, false); assert.equal(observation.provenance.clockMappingEstablished, false);
            assert.equal(observation.provenance.nativeWidthPx, 64); assert.equal(observation.provenance.nativeHeightPx, 48); assert.equal(typeof observation.provenance.mediaTimeSeconds, 'number');
          }
          assert.equal(fixture.retired.latest, undefined); assert.ok(fixture.retired.released > 0); assert.equal(fixture.cleanup.tracksEnded, true);
          assert.equal(fixture.cleanup.videoDetached, true); assert.equal(fixture.cleanup.videoConnected, false); assert.equal(fixture.cleanup.sampledWidth, 1); assert.equal(fixture.cleanup.sampledHeight, 1);
          assert.equal(fixture.cleanup.producerWidth, 1); assert.equal(fixture.cleanup.producerHeight, 1);
          assert.equal(software.kind, 'cooperative-software-camera-zoom'); assert.equal(software.result, 'pass'); assert.equal(software.positiveHardwareEvidence, false); assert.equal(software.nativeZoomQualification, false);
          assert.equal(software.denied.ok, false); assert.equal(software.denied.reason, 'denied'); assert.equal(software.returned.control.state, 'api-returned'); assert.equal(software.returned.control.reportedSetting, 2.5);
          assert.deepEqual(software.payloads, [{ advanced: [{ zoom: 2.5 }] }, { advanced: [{ zoom: 3 }] }]); assert.equal(software.apiSetting, 3);
          assert.equal(software.pending.state, 'uncertain'); assert.equal(software.pending.rawPending, 1); assert.equal(software.pending.activeSinks, 0);
          for (const cleanup of [fixture.cleanup, software.cleanup]) {
            assert.equal(cleanup.provider.activeSources, 0); assert.equal(cleanup.provider.listeners, 0); assert.equal(cleanup.provider.rawPending, 0); assert.equal(cleanup.provider.framePending, 0);
            assert.equal(cleanup.provider.cleanupFailures, 0); assert.equal(cleanup.provider.expiryArmed, false); assert.equal(cleanup.control.rawPending, 0); assert.equal(cleanup.control.bindingPending, 0);
            assert.equal(cleanup.control.activeSinks, 0); assert.equal(cleanup.control.expiryArmed, false); assert.ok(cleanup.control.records.length <= 16);
          }
          assert.equal(software.cleanup.trackEnded, true); assert.equal(software.cleanup.frameCallbacks, 0); assert.equal(software.cleanup.producerTimers, 0);
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedCameraPolicy: path === '/denied' ? 'deny' : 'self',
            checks: ['ordinary-public-facade-identity', 'inert-native-default-no-issued-selection-or-grants', 'no-default-enumeration-acquisition-chooser-or-constraints', 'actual-owned-canvas-stream-decoded-RGBA8', 'native-red-to-blue-change-through-typed-SDK-route', 'canvas-zoom-unsupported-zero-constraints', 'separate-capture-control-and-resource-invoke-grants', 'exact-real-route-and-running-operation-numeric-caps', 'software-only-setting-return-not-optical-evidence', 'issued-revoke-retires-capture-and-retains-actual-promise', 'unmapped-decoded-media-and-JS-provenance', 'revoke-releases-held-sink-and-owned-native-cleanup'], proof });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
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
    ...(installed ? { sourceTree, callerTree, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins, installedConsumerRetained: consumer } : {}),
    sourcePins: fingerprints, dependencyPins, publicResolutions, node: process.version, typescript: ts.version,
    results, physicalCameraQualification: false, nativeHardwarePositive: false, nativeZoomPositive: false, positiveCanvasIsOwnedDigitalProducer: true, positiveZoomIsCooperativeSoftwarePort: true, cleanup: { browsers: 0, contexts: 0, ownedListeners: 0, timers: 0, callbacks: 0, loopbackServers: 0, ownedDirectories: 0 } };
} finally {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
assert.equal(server?.listening, false); assert.equal(existsSync(scratch), false);
if (installed) assert.equal(existsSync(consumer), true);
console.log(JSON.stringify(receipt, null, 2));
