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
const owned = ['packages/device-runtime/src/media-recording.ts', 'packages/device-runtime/src/media-recording.test.ts', 'examples/browser-resources/media-recording.ts', 'tools/qa-media-recording.mjs'];
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
  assert.ok(queries.length > 0 && queries.length <= 1028); const keys = [...new Set(queries)];
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
      assert.ok(['LICENSE', 'README.md', 'package.json'].includes(file.path) || /^(?:dist\/[^/]+\.(?:js|d\.ts)|schema\/device-descriptor\.json|examples\/[^/]+\.(?:js|ts|d\.ts))$/.test(file.path));
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
    scratch = realpathSync(mkdtempSync(join(consumer, 'media-recording-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/media-recording.ts'); copy(join(root, owned[2]), leaf);
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
    diagnose(program); serve('/recording-caller.mjs', join(scratch, 'compiled/media-recording.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-media-recording-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-media-recording-')));
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
    copy(join(compiled, 'examples/browser-resources/media-recording.js'), join(consumer, 'recording-caller.mjs')); serve('/recording-caller.mjs', join(consumer, 'recording-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';
if(typeof sdk.createMediaRecording!=='function'||sdk.createMediaRecording!==runtime.createMediaRecording)throw Error('Public identity');
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
  const html = `<!doctype html><meta charset="utf-8"><title>Owned recording diagnostic</title><button type="button">Record and review owned digital frames</button><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {runOwnedMediaRecordingFixture} from '/recording-caller.mjs';import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';
globalThis.defaultCameraAttempts=0;if(navigator.mediaDevices&&typeof navigator.mediaDevices.getUserMedia==='function')navigator.mediaDevices.getUserMedia=()=>{globalThis.defaultCameraAttempts++;throw Error('User camera acquisition forbidden in this owned page');};
try{if(sdk.createMediaRecording!==runtime.createMediaRecording)throw Error('Public identity');globalThis.nativeReady=true;document.querySelector('button').onclick=async()=>{try{globalThis.proof=await runOwnedMediaRecordingFixture();globalThis.ready=true;}catch(error){globalThis.fixtureError=String(error);}};}catch(error){globalThis.bootstrapError=String(error);}</script>`;
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
          const proof = await page.evaluate(() => globalThis.proof);
          assert.equal(proof.kind, 'owned-native-canvas-local-recording'); assert.equal(proof.result, 'pass');
          assert.equal(proof.physicalCapture, false); assert.equal(await page.evaluate(() => globalThis.defaultCameraAttempts), 0);
          assert.equal(proof.nativeOpens, 1); assert.ok(proof.liveDelivered >= 34); assert.equal(proof.admitted, 34);
          assert.equal(proof.committed, 33); assert.equal(proof.quotaRefusals, 1);
          assert.equal(proof.clipQuota.ok, false); assert.equal(proof.clipQuota.reason, 'quota');
          assert.equal(proof.automaticRecords, 0); assert.equal(proof.denied.ok, false); assert.equal(proof.denied.reason, 'denied');
          assert.equal(proof.deniedPlayback.ok, false); assert.equal(proof.deniedPlayback.reason, 'denied');
          assert.equal(proof.deniedOutputStart.ok, false); assert.equal(proof.deniedOutputStart.reason, 'denied');
          assert.equal(proof.deniedOutputRoute.state, 'idle'); assert.equal(proof.deniedOutputRoute.reason, 'denied');
          assert.equal(proof.deniedOutputRoute.pending, 0); assert.equal(proof.preApprovalOutputDelivered, 0);
          assert.equal(proof.afterRestart.captures, 0); assert.equal(proof.afterRestart.players, 0); assert.equal(proof.afterRestart.pendingFrames, 0);
          assert.equal(proof.exportFrames, 32); assert.deepEqual(proof.exportPages, Array(8).fill(4)); assert.equal(proof.unmanagedReturnedCopiesRecalled, false);
          for (const [pulled, channel, index, pixels] of [[proof.first, 0, 0, proof.redPixels], [proof.middle, 1, 16, proof.greenPixels], [proof.second, 2, 31, proof.bluePixels]]) {
            const frame = pulled.frame; assert.equal(frame.bytes.length, 256); assert.match(frame.sha256, /^[0-9a-f]{64}$/);
            assert.equal(frame.index, index);
            assert.equal(hash(Buffer.from(frame.bytes)), frame.sha256); assert.deepEqual(pixels, frame.bytes);
            for (let i=0;i<256;i++) assert.ok(i%4===channel||i%4===3 ? pixels[i]>=240 : pixels[i]<=16);
            const actual = proof.admittedFacts.find(fact => fact.sequence === frame.sequence); assert.ok(actual);
            assert.equal(frame.sourceTime.at, actual.timestamp); assert.equal(frame.sourceTime.clockId, actual.clockDomain);
            assert.equal(frame.quality, actual.quality); assert.equal(frame.decodedMediaTime, actual.decodedMediaTime);
            assert.equal(pulled.playback.clockId, 'recording-host-emission'); assert.equal(pulled.playback.index, frame.index);
            assert.ok(pulled.playback.at > frame.sourceTime.at); assert.notEqual(pulled.playback.clockId, frame.sourceTime.clockId);
          }
          assert.ok(proof.middle.playback.seekEpoch > proof.first.playback.seekEpoch); assert.ok(proof.second.playback.seekEpoch > proof.middle.playback.seekEpoch);
          assert.ok(proof.outputDelivered >= 3); assert.ok(proof.outputReleased >= 1);
          assert.equal(proof.isolation.empty, 0); assert.equal(proof.isolation.foreign.reason, 'not-found');
          assert.equal(proof.isolation.ownDeletion.value.removed, 1); assert.equal(proof.isolation.incumbentFrames, 32);
          const boundaries = proof.nativeBoundaries;
          assert.equal(boundaries.storageEngine, 'actual-IndexedDB');
          assert.equal(boundaries.finalClock.clockTransitions, 1); assert.equal(boundaries.finalClock.expiredCommit.ok, false); assert.equal(boundaries.finalClock.persistedFrames, 0);
          assert.equal(boundaries.revoke.revocations, 1); assert.equal(boundaries.revoke.revokedCommit.ok, false); assert.equal(boundaries.revoke.persistedFrames, 0);
          assert.equal(boundaries.deletionEpoch.heldRaw, 1); assert.equal(boundaries.deletionEpoch.busy.reason, 'busy');
          assert.equal(boundaries.deletionEpoch.deletion.value.removed, 1); assert.equal(boundaries.deletionEpoch.lateResult.reason, 'epoch-changed'); assert.equal(boundaries.deletionEpoch.persistedClips, 0);
          assert.equal(boundaries.stop.cancelledRaw, 1); assert.equal(boundaries.stop.closeWasPending, true); assert.equal(boundaries.stop.closeSettled, true);
          assert.equal(boundaries.stop.stoppedResult.ok, false); assert.equal(boundaries.stop.persistedFrames, 0); assert.equal(boundaries.heldRequests, 0);
          assert.equal(boundaries.nativePortsClosed, 6);
          for (const item of boundaries.cleanup) for (const name of ['captures','players','pendingFrames','pendingBytes','rawPending','timers','listeners']) assert.equal(item[name], 0);
          assert.equal(proof.quiet.aborted, true); assert.equal(proof.quiet.deliveries, 1); assert.ok(proof.quiet.releases >= 1);
          assert.equal(proof.quiet.hardware, false); assert.equal(proof.quiet.frameIndex, 0);
          assert.equal(hash(Buffer.from(proof.quiet.retainedBytes)), proof.quiet.frameHash); assert.deepEqual(proof.quiet.before, proof.quiet.retainedBytes);
          assert.ok(proof.quiet.after.every(byte => byte === 0)); assert.equal(proof.ttlSweep.value.removed, 1); assert.equal(proof.ttlMissing.reason, 'not-found');
          assert.equal(proof.deletion.ok, true); assert.equal(proof.deletion.value.removed, 1);
          assert.equal(proof.allDeletion.ok, true); assert.equal(proof.allDeletion.value.removed, 2);
          for (const name of ['captures','players','pendingFrames','pendingBytes','rawPending','timers','listeners']) assert.equal(proof.cleanup.recording[name], 0);
          for (const name of ['activeSources','listeners','rawPending','framePending','cleanupFailures']) assert.equal(proof.cleanup.camera[name], 0);
          assert.equal(proof.cleanup.camera.expiryArmed, false); assert.equal(proof.cleanup.tracksEnded, true);
          assert.equal(proof.cleanup.databaseDeleted, true); assert.equal(proof.cleanup.producerTimers, 0);
          assert.equal(proof.cleanup.producerWidth, 1); assert.equal(proof.cleanup.producerHeight, 1); assert.equal(proof.cleanup.outputWidth, 1); assert.equal(proof.cleanup.outputHeight, 1);
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedCameraPolicy: path === '/denied' ? 'deny' : 'self',
            checks: ['ordinary-public-recording-identity','zero-default-camera-acquisitions','live-route-zero-auto-recording','exact-explicit-capture-and-playback-consent',
              'actual-owned-canvas-stream-decoded-frames','genuine-native-IndexedDB-restart-data-only','source-clock-sequence-quality-preserved',
              'separate-host-playback-and-live-source-sink-grants','verified-eight-four-frame-export-pages','first-middle-end-seek-real-retained-pixels',
              'real32-capture-frame-and4-clip-quotas','native-owner-isolation','native-final-clock-and-consent-guard-aborts',
              'native-delayed-append-delete-epoch-fence','raw-reservation-through-actual-native-cancel-settlement','quiet-native-retention-output-release','revoke-private-output-release',
              'durable-owner-deletion','actual-owned-native-cleanup'], proof });
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
    results, physicalCaptureQualification: false, nativeHardwarePositive: false, positiveFactoryIsExplicitOwnedCanvasFixture: true, cleanup: { browsers: 0, contexts: 0, ownedListeners: 0, timers: 0, callbacks: 0, loopbackServers: 0, ownedDirectories: 0 } };
} finally {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
assert.equal(server?.listening, false); assert.equal(existsSync(scratch), false);
if (installed) assert.equal(existsSync(consumer), true);
console.log(JSON.stringify(receipt, null, 2));
