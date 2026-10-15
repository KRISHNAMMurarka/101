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
const owned = ['packages/device-web/src/application-audio.ts', 'packages/device-web/src/application-audio.test.ts', 'examples/browser-resources/application-audio.ts', 'tools/qa-application-audio.mjs', 'tools/sdk-browser-inventory.mjs'];
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
    scratch = realpathSync(mkdtempSync(join(consumer, 'application-audio-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/application-audio.ts'); copy(join(root, owned[2]), leaf);
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
    diagnose(program); serve('/application-audio-caller.mjs', join(scratch, 'compiled/application-audio.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-application-audio-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-application-audio-')));
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
    copy(join(compiled, 'examples/browser-resources/application-audio.js'), join(consumer, 'application-audio-caller.mjs')); serve('/application-audio-caller.mjs', join(consumer, 'application-audio-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserApplicationAudio!=='function'||sdk.createBrowserApplicationAudio!==web.createBrowserApplicationAudio)throw Error('Public identity');
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
  const html = `<!doctype html><meta charset="utf-8"><title>Owned private application audio</title><button type="button">Run owned private digital audio</button><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkPrivateAudioWithoutProducer,runOwnedPrivateApplicationAudioFixture} from '/application-audio-caller.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
try{if(sdk.createBrowserApplicationAudio!==web.createBrowserApplicationAudio)throw Error('Public identity');globalThis.proof={native:await checkPrivateAudioWithoutProducer()};globalThis.nativeReady=true;document.querySelector('button').onclick=async()=>{try{globalThis.proof.fixture=await runOwnedPrivateApplicationAudioFixture();globalThis.ready=true;}catch(error){globalThis.fixtureError=String(error);}};}catch(error){globalThis.bootstrapError=String(error);}</script>`;
  server = createServer((request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', 'microphone=(), camera=(), speaker-selection=()');
      if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      const file = served.get(path); if (!file) { response.writeHead(404); response.end(); return; }
      const bytes = readFileSync(file.file); assert.equal(hash(bytes), file.sha256); response.setHeader('Content-Type', 'text/javascript'); response.end(bytes);
    } catch (error) { serverFailure = error; response.writeHead(500); response.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext(), page = await context.newPage(), errors = [], remoteAttempts = [];
      try {
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { remoteAttempts.push(route.request().url()); return route.abort(); } return route.continue(); });
        await page.goto(origin + '/');
        await page.waitForFunction(() => globalThis.nativeReady === true || !!globalThis.bootstrapError);
        assert.equal(await page.evaluate(() => globalThis.bootstrapError), undefined, engine.name() + ': native bootstrap');
        await page.locator('button').click();
        try { await page.waitForFunction(() => globalThis.ready === true || !!globalThis.fixtureError); }
        catch (error) { throw new Error(engine.name() + ': owned digital producer did not settle; pageerrors=' + JSON.stringify(errors), { cause: error }); }
        assert.equal(await page.evaluate(() => globalThis.fixtureError), undefined, engine.name() + ': owned fixture');
        const proof = await page.evaluate(() => globalThis.proof), native = proof.native, fixture = proof.fixture;
        assert.equal(native.kind, 'actual-native-inert-availability'); assert.equal(native.forgedReady, false); assert.equal(native.approvals, 0);
        for (const status of [native.initial, native.final]) { assert.equal(status.sources, 0); assert.equal(status.activeOutputs, 0); assert.equal(status.rawPending, 0); assert.equal(status.listeners, 0); assert.equal(status.pollArmed, false); assert.equal(status.expiryArmed, false); }
        assert.equal(native.final.closed, true); assert.equal(native.deviceAcquisitions, 0); assert.equal(native.speakerConnections, 0); assert.equal(native.hardwareEvidence, false);
        assert.equal(fixture.kind, 'owned-native-private-application-audio'); assert.equal(fixture.hardwareEvidence, false);
        assert.ok(['pass', 'unsupported'].includes(fixture.result));
        if (fixture.result === 'pass') {
          assert.equal(fixture.deniedReady, false); assert.ok(fixture.toneA > 0.05 && fixture.toneB > 0.05); assert.ok(fixture.mutedA < 0.001 && fixture.unaffectedB > 0.05); assert.ok(fixture.halfA > 0.04 && fixture.halfA < 0.13);
          assert.equal(fixture.nativeGraphFacts.sampleRateHz, 48000); assert.equal(fixture.nativeGraphFacts.channels, 2); assert.equal(fixture.nativeGraphFacts.contextCorrelated, true);
          assert.ok(fixture.nativeSourceSettings.sampleRateHz === null || fixture.nativeSourceSettings.sampleRateHz === 48000); assert.ok(fixture.nativeSourceSettings.channels === null || fixture.nativeSourceSettings.channels === 2);
          assert.equal(fixture.routingContexts, 1); assert.equal(fixture.independentAnalyserContexts, 2); assert.equal(fixture.beforeRevoke.activeOutputs, 2);
          assert.equal(fixture.borrowedProducerStillRunning, true); assert.equal(fixture.levelsRetired.latest, undefined); assert.ok(fixture.levelsRetired.released >= 1);
          assert.ok(fixture.audioRouteApprovals >= 2 && fixture.diagnosticApprovals >= 1 && fixture.sourceApprovals >= 2 && fixture.outputApprovals >= 2);
          assert.equal(fixture.diagnostics.latest.clockDomain, 'application-audio-javascript-retrieval'); assert.equal(fixture.diagnostics.latest.provenance.captureTimeKnown, false); assert.equal(fixture.diagnostics.latest.provenance.clockMappingEstablished, false);
          const final = fixture.cleanup.provider; assert.equal(final.closed, true); assert.equal(final.sources, 0); assert.equal(final.activeOutputs, 0); assert.equal(final.openingOutputs, 0); assert.equal(final.rawPending, 0); assert.equal(final.cleanupPending, 0); assert.equal(final.cleanupFailures, 0); assert.equal(final.listeners, 0); assert.equal(final.pollArmed, false); assert.equal(final.expiryArmed, false);
        } else assert.ok(['native-api-unavailable', 'actual-native-format-unavailable'].includes(fixture.reason));
        if (fixture.cleanup) {
          assert.equal(fixture.cleanup.producerState, 'closed'); assert.ok(fixture.cleanup.readerStates.every(state => state === 'closed')); assert.ok(fixture.cleanup.routingStates.every(state => state === 'closed'));
          assert.equal(fixture.cleanup.originalTracksEndedByCaller, true); assert.equal(fixture.cleanup.clonedTracksEndedByAdapter, true);
        }
        assert.equal(fixture.deviceAcquisitions ?? 0, 0); assert.equal(fixture.speakerConnections ?? 0, 0); assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []);
        assert.equal(serverFailure, undefined);
        results.push({ engine: engine.name(), browserVersion: browser.version(), proof, pageErrors: errors, remoteAttempts });
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
  assert.ok(results.some(result => result.proof.fixture.result === 'pass'), 'At least one actual native private-audio producer must qualify: ' + JSON.stringify(results.map(item => ({ engine: item.engine, fixture: item.proof.fixture }))));
  receipt = { schemaVersion: 1, status: 'pass-selected-local-profile', sourceOnly: !installed, qualification: installed ? 'ordinary installed seven-package SDK' : 'compiled ordinary public source graph; no installed new-adapter claim',
    sourceTree, callerTree, fingerprints, dependencyPins, publicResolutions, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins,
    node: process.version, platform: process.platform, architecture: process.arch, results,
    limits: { sources: 1, privateOutputs: 2, rawContextLifecycles: 1, attempts: 64, lifetimeMs: 30000, openMs: 5000, diagnosticHz: 20, samples: 256, sampleRateHz: 48000, channels: 2, registrations: 4, internalAudioRoutes: 2, diagnosticRoutes: 'separately granted caller route' },
    scope: 'Actual owned browser application oscillator/private native graph/analyser digital effects only; no user device, speakers, encoded PCM, network transport, acoustic or hardware capture clock claims.' };
} finally {
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (!installed && consumer && consumer !== scratch) rmSync(consumer, { recursive: true, force: true });
}
assert.ok(receipt); receipt.cleanup = { ownedBrowsers: 0, ownedContexts: 0, ownedServers: 0, scratchAbsent: !existsSync(scratch), defaultDeviceAcquisitions: 0, speakerConnections: 0 };
console.log(JSON.stringify(receipt, null, 2));
