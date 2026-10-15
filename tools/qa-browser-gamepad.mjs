import { isSdkBrowserPublicFile } from './sdk-browser-inventory.mjs';
import assert from 'node:assert/strict';
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
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/browser-gamepad.ts', 'packages/device-web/src/browser-gamepad.test.ts', 'examples/browser-resources/gamepad.ts', 'tools/qa-browser-gamepad.mjs', 'tools/sdk-browser-inventory.mjs'];
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
function gitBlobs(inputs) {
  for (const { paths } of inputs) for (const path of paths) assert.ok(typeof path === 'string' && path.length <= 1024 &&
    !/[\r\n\0]/.test(path) && !isAbsolute(path) && resolve(root, path).startsWith(root + sep));
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
      { tree: callerTree, paths: [...Object.keys(fingerprints), ...Object.keys(dependencyPins)] }]);
    for (const [path, pin] of Object.entries(fingerprints)) assert.equal(hash(immutable.blobs.get(callerTree + ':' + path)), pin, 'Immutable caller mismatch: ' + path);
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]], 'Manifest must include the actual new provider');
    for (const [path, pin] of Object.entries(dependencyPins)) {
      assert.ok(!isAbsolute(path) && resolve(root, path).startsWith(root + sep)); assert.match(pin, /^[0-9a-f]{64}$/);
      for (const tree of new Set([sourceTree, callerTree])) assert.equal(hash(immutable.blobs.get(tree + ':' + path)), pin, 'Immutable SDK source mismatch: ' + path);
      assert.equal(hash(bytes(join(root, path))), pin, 'Current SDK source mismatch: ' + path);
    }
    immutableManifest = { path: manifestPath, sha256: packed.manifest.sha256 };
    checkInstalled(manifest);
    scratch = realpathSync(mkdtempSync(join(consumer, 'browser-gamepad-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const leaf = join(scratch, 'source/gamepad.ts'); copy(join(root, owned[2]), leaf);
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
    diagnose(program); serve('/gamepad-caller.mjs', join(scratch, 'compiled/gamepad.js'));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-browser-gamepad-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-browser-gamepad-')));
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
    copy(join(compiled, 'examples/browser-resources/gamepad.js'), join(consumer, 'gamepad-caller.mjs')); serve('/gamepad-caller.mjs', join(consumer, 'gamepad-caller.mjs'));
  }
  const resolutionFile = join(scratch, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserGamepadProvider!=='function'||sdk.createBrowserGamepadProvider!==web.createBrowserGamepadProvider)throw Error('Public identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const resolution = spawnSync(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: scratch, env, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' });
  assert.equal(resolution.status, 0, resolution.stderr); assert.equal(resolution.stderr, '');
  const publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
  const html = `<!doctype html><meta charset="utf-8"><title>Owned Gamepad negative diagnostic</title><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkBrowserGamepadWithoutDevice,runBrowserGamepadLogicFixture} from '/gamepad-caller.mjs';import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(sdk.createBrowserGamepadProvider!==web.createBrowserGamepadProvider)throw Error('Public identity');globalThis.proof={native:checkBrowserGamepadWithoutDevice(),fixture:runBrowserGamepadLogicFixture()};globalThis.ready=true;</script>`;
  server = createServer((request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Permissions-Policy', path === '/denied' ? 'gamepad=()' : 'gamepad=(self)');
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
          await page.goto(origin + path); await page.waitForFunction(() => globalThis.ready === true);
          const proof = await page.evaluate(() => globalThis.proof), native = proof.native, fixture = proof.fixture;
          assert.equal(native.kind, 'actual-native-browser-negative'); assert.notEqual(native.native.outcome, 'unexpected-device'); assert.equal(native.physicalDeviceQualification, false);
          assert.equal(native.initial.listeners, 0); assert.equal(native.initial.rafArmed, false); assert.equal(native.initial.timerArmed, false); assert.equal(native.initial.activeSources, 0);
          assert.equal(native.selected.ok, false); assert.equal(native.retry.ok, false); assert.equal(native.captureApprovals, 0);
          if (native.observed.focused && !native.observed.hidden) {
            if (native.native.outcome === 'empty') { assert.equal(native.inventory.ok, true); assert.deepEqual(native.inventory.value, []); assert.equal(native.selected.reason, 'unavailable'); }
            else { assert.equal(native.inventory.ok, false); assert.equal(native.inventory.reason, native.native.outcome === 'denied' ? 'denied' : 'unsupported'); }
          }
          assert.equal(native.final.phase, 'closed'); assert.equal(native.final.listeners, 0); assert.equal(native.final.rafArmed, false); assert.equal(native.final.timerArmed, false);
          assert.equal(fixture.kind, 'injected-native-shaped-logic-fixture'); assert.equal(fixture.positiveHardwareEvidence, false); assert.deepEqual(fixture.selectedCapabilities, ['axes', 'button']);
          assert.deepEqual(fixture.active.axes, [0.25]); assert.deepEqual(fixture.active.heldButtons, ['button-0']); assert.equal(fixture.active.timestamp, 120);
          assert.equal(fixture.active.provenance.gamepadLastUpdateTimestamp, 7.5); assert.equal(fixture.active.provenance.captureTimeKnown, false); assert.equal(fixture.active.provenance.clockMappingEstablished, false);
          assert.deepEqual(fixture.retired.heldButtons, []); assert.deepEqual(fixture.retired.axes, []); assert.ok(fixture.retired.releases > 0);
          assert.equal(fixture.cleanup.activeSources, 0); assert.equal(fixture.cleanup.callbacks, 0); assert.equal(fixture.cleanup.listeners, 0); assert.equal(fixture.cleanup.timerArmed, false);
          assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
          results.push({ browser: engine.name(), version: browser.version(), requestedGamepadPolicy: path === '/denied' ? 'deny' : 'self', checks: ['ordinary-public-facade-identity', 'native-availability-no-pad-or-denial', 'inert-default-no-sources-grants-scheduler', 'explicit-failed-selection-and-retry', 'native-negative-clean-close', 'separately-labeled-software-fixture-typed-resource-routing', 'fixture-exact-provenance', 'fixture-revoke-neutral-sink-release-and-cleanup'], proof });
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
    results, physicalGamepadQualification: false, nativePositiveInjected: false, cleanup: { browsers: 0, contexts: 0, ownedListeners: 0, timers: 0, callbacks: 0, loopbackServers: 0, ownedDirectories: 0 } };
} finally {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
assert.equal(server?.listening, false); assert.equal(existsSync(scratch), false);
if (installed) assert.equal(existsSync(consumer), true);
console.log(JSON.stringify(receipt, null, 2));
