import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-web/src/browser-chooser.ts', 'packages/device-web/src/browser-chooser.test.ts',
  'examples/browser-resources/chooser.ts', 'tools/qa-browser-chooser.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
assert.ok(process.argv.length === 3 && process.argv[2] === '--source' || process.argv.length === 4 && process.argv[2] === '--sdk-root',
  'Use --source or --sdk-root <fresh installed consumer>');
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = join(directory, name), entry = lstatSync(file); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) return files(file); assert.ok(entry.isFile()); return [file];
  });
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
const served = new Map(); let consumer, mode, sourceTree, compiledSource, immutableManifest;
function serve(url, file, expected = hash(readFileSync(file))) {
  assert.equal(realpathSync(file), file); assert.ok(lstatSync(file).isFile());
  assert.equal(hash(readFileSync(file)), expected); assert.equal(served.has(url), false);
  served.set(url, { file, sha256: expected });
}
if (process.argv[2] === '--source') {
  mode = 'owned-public-source-closure'; consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-browser-chooser-source-')));
  const compiled = join(consumer, '.compiled'), roots = [...names.map(name => join(root, `packages/${name}/src/index.ts`)), join(root, owned[2])];
  const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true, noUncheckedIndexedAccess: true, types: [], skipLibCheck: false, noEmitOnError: true,
    rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])),
  });
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.every(source => source.fileName === join(root, owned[2]) || names.some(name => source.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
  compiledSource = Object.fromEntries(sources.map(source => [relative(root, source.fileName), hash(readFileSync(source.fileName))]));
  assert.equal(compiledSource[owned[0]], fingerprints[owned[0]]);
  for (const name of names) {
    const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
    for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
    for (const file of files(destination)) serve(`/sdk/${name}/${relative(destination, file).split(sep).join('/')}`, file);
  }
  sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  copy(join(compiled, 'examples/browser-resources/chooser.js'), join(consumer, 'chooser-caller.mjs'));
} else {
  mode = 'installed-immutable-public-sdk'; consumer = realpathSync(resolve(process.argv[3]));
  assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
  sourceTree = packed.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/);
  for (const path of owned) assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`],
    { cwd: root, timeout: 5000, maxBuffer: 1048576 })), fingerprints[path], `Caller differs from immutable tree: ${path}`);
  assert.equal(packed.source.sha256[owned[0]], fingerprints[owned[0]]);
  const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, sourceTree);
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => `@101/${name}`).sort());
  for (const item of manifest.packages) {
    const name = item.name.slice(5), prefix = join(consumer, 'node_modules', item.name); assert.ok(names.includes(name));
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep));
      serve(`/sdk/${name}/${file.path}`, path, file.sha256);
    }
  }
  immutableManifest = { path: packed.manifest.path, sha256: packed.manifest.sha256 };
  const example = ts.transpileModule(readFileSync(join(root, owned[2]), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
  }); assert.equal(example.diagnostics?.length ?? 0, 0); writeFileSync(join(consumer, 'chooser-caller.mjs'), example.outputText);
}
serve('/chooser-caller.mjs', join(consumer, 'chooser-caller.mjs'));
const resolutionFile = join(consumer, 'chooser-resolution.mjs');
writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(typeof sdk.createBrowserChooserController!=='function'||sdk.createBrowserChooserController!==web.createBrowserChooserController)throw Error('Public facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const resolved = spawnSync(process.execPath, ['--no-experimental-strip-types', resolutionFile], { cwd: consumer, env: environment, timeout: 5000, encoding: 'utf8' });
assert.equal(resolved.status, 0, resolved.stderr); assert.equal(resolved.stderr, '');
const publicEsmResolutions = resolved.stdout.trim().split('\n').map(line => JSON.parse(line));
for (const item of publicEsmResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/sdk/${name}/dist/index.js`]));
const html = `<!doctype html><meta charset="utf-8"><title>Local chooser availability diagnostic</title>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import {checkBrowserChooserWithoutActivation} from '/chooser-caller.mjs';
import * as sdk from '@101/connect';import * as web from '@101/device-web';
if(sdk.createBrowserChooserController!==web.createBrowserChooserController)throw Error('Facade identity');
globalThis.chooserProof=await checkBrowserChooserWithoutActivation();globalThis.ready=true;
</script>`;
let serverFailure;
const server = createServer((request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), hid=(), serial=(), bluetooth=()');
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    const file = served.get(path); if (!file) { response.writeHead(404); response.end(); return; }
    const bytes = readFileSync(file.file); assert.equal(hash(bytes), file.sha256, 'Served bytes changed after verification');
    response.setHeader('Content-Type', 'text/javascript'); response.end(bytes);
  } catch (error) { serverFailure = error; response.writeHead(500); response.end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`, results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext(), page = await context.newPage(), errors = [], remoteAttempts = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { remoteAttempts.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await page.goto(origin); await page.waitForFunction(() => globalThis.ready === true);
      const proof = await page.evaluate(() => globalThis.chooserProof);
      assert.equal(proof.kind, 'actual-browser-unactivated-chooser'); assert.equal(proof.observed.secureContext, true);
      assert.equal(proof.observed.transientActivation, false); assert.equal(proof.initial.state, 'idle');
      assert.equal(proof.initial.nativePending, 0); assert.equal(proof.initial.timerArmed, false); assert.equal(proof.initial.current, undefined);
      assert.equal(proof.outcomes.length, 5); assert.equal(proof.captureApprovalCalls, 0);
      for (const item of proof.outcomes) {
        assert.equal(item.ok, false);
        const option = proof.initial.options.find(option => option.id === item.id);
        assert.equal(item.reason, ['camera', 'audio'].includes(item.id) ? 'adapter-unbound' : option.chooserSupported ? 'activation-required' : 'unsupported');
      }
      assert.equal(proof.stopped.current, undefined); assert.equal(proof.stopped.nativePending, 0);
      assert.equal(proof.stopped.timerArmed, false); assert.equal(proof.retry.ok, false);
      assert.equal(proof.final.state, 'closed'); assert.equal(proof.final.nativePending, 0); assert.equal(proof.final.timerArmed, false);
      assert.deepEqual(errors, []); assert.deepEqual(remoteAttempts, []); assert.equal(serverFailure, undefined);
      results.push({ browser: engine.name(), version: browser.version(), checks: ['ordinary-public-facade-identity', 'native-secure-loopback-unactivated-execution',
        'inert-declared-options-no-authority', 'actual-native-api-availability-and-no-gesture-rejection', 'unbound-camera-audio-no-capture', 'explicit-retry-and-clean-close'], proof });
      await context.close();
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolveClose => server.close(resolveClose)); }
const receipt = { schemaVersion: 1, result: 'pass', mode, createdAt: new Date().toISOString(), environment: { node: process.version, typescript: ts.version },
  baseOrPackedSource: sourceTree, sourceSha256: fingerprints, ...(compiledSource ? { compiledSourceSha256: compiledSource } : {}),
  ...(immutableManifest ? { immutableManifest } : {}), consumer, publicEsmResolutions,
  servedSha256: Object.fromEntries([...served].map(([url, file]) => [url, file.sha256])), results,
  scope: 'Real Chromium/WebKit public browser availability and missing activation negatives only; no selected physical hardware, camera/audio binding, native permission dialog, capture, authentication or resource operation grant. D03 remains partial.' };
const receiptPath = join(consumer, 'browser-chooser-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
