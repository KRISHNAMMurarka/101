#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--sdk-root' && args[1], 'Use only --source or --sdk-root OWNED_CONSUMER.');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const names = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const ownPaths = ['examples/wire-replay/wire-replay.ts', 'tests/wire-replay.test.ts', 'examples/wire-replay/consumer.mjs', 'tools/qa-wire-replay.mjs'];
const selectedProducerPaths = ['packages/device-model/src/descriptor.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts',
  'packages/device-web/src/authenticated-peer.ts', 'packages/device-web/src/binding.ts', 'packages/device-web/src/wire.ts', 'packages/device-web/src/pointer-provider.ts',
  'packages/transport-websocket/src/peer.ts', 'examples/device-pipelines/secure-websocket.ts'];
const callerPins = Object.fromEntries(ownPaths.map(path => [path, existsSync(join(root, path)) ? hash(readFileSync(join(root, path))) : 'missing-feature']));
const fixturePath = join(root, 'tools/qa-https-coordinator.mjs'), fixturePin = hash(readFileSync(fixturePath));
function boundedJson(path, limit) { const bytes = readFileSync(path); assert.ok(bytes.length <= limit); return JSON.parse(bytes.toString('utf8')); }
function inventory(directory) {
  const files = []; let entries = 0;
  function walk(path) { assert.equal(realpathSync(path), path); assert.equal(lstatSync(path).isSymbolicLink(), false);
    for (const name of readdirSync(path).sort()) { assert.ok(++entries <= 2048); const full = join(path, name), stat = lstatSync(full);
      assert.equal(realpathSync(full), full); assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(full); else { assert.ok(stat.isFile() && files.length < 1024); files.push(relative(directory, full)); }
    }
  } walk(directory); return files.sort();
}
function compileInstalledLeaf(executionRoot, installedFiles, compilePins) {
  const leafDirectory = join(executionRoot, 'examples/wire-replay'), input = join(leafDirectory, 'wire-replay.mts');
  mkdirSync(leafDirectory, { recursive: true });
  copyFileSync(join(root, ownPaths[0]), input); assert.equal(hash(readFileSync(input)), callerPins[ownPaths[0]]);
  const compiler = realpathSync(createRequire(import.meta.url).resolve('typescript')), compilerDirectory = dirname(compiler);
  const compilerPackage = join(dirname(compilerDirectory), 'package.json');
  assert.equal(boundedJson(compilerPackage, 65536).version, ts.version);
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, types: [],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], rootDir: leafDirectory, outDir: leafDirectory };
  assert.equal(realpathSync(dirname(ts.getDefaultLibFilePath(options))), compilerDirectory);
  for (const path of [compiler, compilerPackage, input]) compilePins.set(path, hash(readFileSync(path)));
  // Default NodeNext resolution reads only normal installed package declarations.
  // There are no aliases, ambient type packages or source-workspace hooks here.
  const program = ts.createProgram([input], options), standardDeclarations = {}, installedDeclarations = {};
  const sources = program.getSourceFiles(); assert.ok(sources.length > 1 && sources.length <= 512);
  for (const source of sources) {
    const path = resolve(source.fileName); assert.equal(realpathSync(path), path); assert.equal(lstatSync(path).isSymbolicLink(), false);
    const pin = hash(readFileSync(path)); compilePins.set(path, pin);
    if (path === input) { assert.equal(source.isDeclarationFile, false); assert.equal(pin, callerPins[ownPaths[0]]); }
    else if (dirname(path) === compilerDirectory && /^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(relative(compilerDirectory, path))) {
      assert.equal(source.isDeclarationFile, true); standardDeclarations[relative(compilerDirectory, path)] = pin;
    } else { assert.equal(source.isDeclarationFile, true); assert.match(path, /\.d\.(ts|mts|cts)$/);
      assert.equal(installedFiles.get(path), pin, 'TypeScript may read only hash-verified installed SDK declarations.');
      installedDeclarations[path] = pin;
    }
  }
  assert.ok(Object.keys(standardDeclarations).length > 0 && Object.keys(installedDeclarations).length > 0);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.slice(0, 32).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n').slice(0, 2048)).join('\n'));
  const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
  const output = join(leafDirectory, 'wire-replay.mjs'); assert.equal(realpathSync(output), output);
  const bytes = readFileSync(output); assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024); compilePins.set(output, hash(bytes));
  return { bytes, receipt: { compilerVersion: ts.version, compilerPath: compiler, compilerSha256: compilePins.get(compiler),
    compilerPackageSha256: compilePins.get(compilerPackage), module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, ambientTypePackages: [], sourceAliases: false,
    diagnostics: 0, inputSha256: callerPins[ownPaths[0]], emittedSha256: hash(bytes), standardDeclarations, installedDeclarations } };
}
let hook, producer, executionRoot = root, caller, prefix, proof;
const sourceClosure = new Map(), compilePins = new Map(), provenanceDirectory = mkdtempSync(join(tmpdir(), '101-wire-replay-proof-'));
try {
  if (args[0] === '--source') {
    const entries = Object.fromEntries(names.map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href]));
    entries['@101/connect/examples/secure-websocket'] = pathToFileURL(join(root, 'examples/device-pipelines/secure-websocket.ts')).href;
    hook = registerHooks({ resolve(specifier, context, next) {
      const result = next(entries[specifier] ?? specifier, context);
      if (result.url.startsWith(pathToFileURL(root + '/').href) && /\.(ts|mjs)$/.test(result.url) && !result.url.includes('/node_modules/')) {
        assert.ok(sourceClosure.size < 256 || sourceClosure.has(result.url)); sourceClosure.set(result.url, hash(readFileSync(new URL(result.url))));
      } return result;
    } });
    caller = await import('../examples/wire-replay/consumer.mjs');
    prefix = await caller.runWireReplayProducerPrefix(new AbortController().signal);
    let runner; try { runner = await import('../examples/wire-replay/wire-replay.ts'); } catch { /* Missing runner feature RED follows the genuine native prefix. */ }
    assert.equal(typeof runner?.runWireReplayQualification, 'function', 'actual native producer works; selected wire replay runner is missing');
  } else {
    const consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const receipt = boundedJson(join(consumer, 'receipt.json'), 512 * 1024); assert.equal(receipt.status, 'pass');
    const manifestBytes = readFileSync(receipt.manifest.path); assert.ok(manifestBytes.length <= 2 * 1024 * 1024); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
    const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
    assert.match(manifest.source.tree, /^[0-9a-f]{40}$/); assert.equal(manifest.packages.length, 7);
    const sourcePins = Object.entries(manifest.source.sha256); assert.ok(sourcePins.length > 0 && sourcePins.length <= 256);
    for (const [path, pin] of sourcePins) {
      assert.match(path, /^(LICENSE|schemas\/device-descriptor\.schema\.json|(packages|examples)\/[A-Za-z0-9_./-]+)$/); assert.equal(path.includes('..'), false);
      assert.equal(hash(execFileSync('git', ['show', manifest.source.tree + ':' + path], { cwd: root, maxBuffer: 2 * 1024 * 1024 })), pin);
    }
    const selectedSource = {};
    for (const path of selectedProducerPaths) { const actual = hash(readFileSync(join(root, path))); assert.equal(actual, manifest.source.sha256[path]); selectedSource[path] = actual; }
    let files = 0; const installedFiles = new Map();
    for (const name of names) {
      const item = manifest.packages.find(item => item.name === '@101/' + name); assert.ok(item?.files.length && item.files.length <= 1024);
      const directory = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(directory), directory); assert.equal(lstatSync(directory).isSymbolicLink(), false);
      assert.deepEqual(inventory(directory), item.files.map(file => file.path).sort());
      for (const file of item.files) { const path = resolve(directory, file.path); assert.ok(path.startsWith(directory + '/')); assert.equal(realpathSync(path), path);
        assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), file.sha256); installedFiles.set(path, file.sha256); files++; }
    }
    executionRoot = mkdtempSync(join(consumer, 'wire-replay-'));
    const resolver = join(executionRoot, 'resolve.mjs'), specifiers = [...names.map(name => '@101/' + name), '@101/connect/examples/secure-websocket'];
    const resolverBytes = 'const result={};for(const name of ' + JSON.stringify(specifiers) + '){result[name]=import.meta.resolve(name);await import(name);}export default result;\n';
    writeFileSync(resolver, resolverBytes); const resolved = (await import(pathToFileURL(resolver).href)).default;
    for (const [specifier, url] of Object.entries(resolved)) { const name = specifier.slice(5).split('/')[0], directory = join(consumer, 'node_modules/@101', name);
      const path = new URL(url); assert.ok(path.pathname.startsWith(directory + '/')); assert.equal(realpathSync(path), path.pathname);
      assert.ok(manifest.packages.find(item => item.name === '@101/' + name).files.some(file => file.path === relative(directory, path.pathname))); }
    // The new caller is independently compiled OUTSIDE the unchanged SDK. All SDK
    // imports are normal public ESM; no source aliases, loader or type stripping.
    const compiled = compileInstalledLeaf(executionRoot, installedFiles, compilePins); mkdirSync(join(executionRoot, 'tools'), { recursive: true });
    const callerSource = readFileSync(join(root, ownPaths[2]), 'utf8'), sourceImport = "import('./wire-replay.ts')";
    assert.equal(callerSource.split(sourceImport).length - 1, 2, 'Exactly one JSDoc and one awaited runner import.');
    const externalCaller = callerSource.replaceAll(sourceImport, "import('./wire-replay.mjs')");
    assert.equal(externalCaller.includes(sourceImport), false); writeFileSync(join(executionRoot, ownPaths[2]), externalCaller); copyFileSync(fixturePath, join(executionRoot, 'tools/qa-https-coordinator.mjs'));
    // Copy only already-installed fixed ws8.21 bytes into this new owned caller.
    // Never change the reusable consumer's packages, receipt or node_modules.
    const wsRoot = realpathSync(dirname(createRequire(import.meta.url).resolve('ws/package.json'))), wsPins = {};
    assert.equal(boundedJson(join(wsRoot, 'package.json'), 65536).version, '8.21.0');
    const destination = join(executionRoot, 'node_modules/ws');
    for (const path of inventory(wsRoot)) { const target = join(destination, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(wsRoot, path), target); wsPins[path] = hash(readFileSync(target)); }
    assert.deepEqual(inventory(destination), Object.keys(wsPins).sort());
    producer = { manifest: receipt.manifest, tree: manifest.source.tree, sourcePins: sourcePins.length, packedFiles: files, packages: 7, selectedSource,
      ordinaryPublicEsmImports: resolved, noSdkSourceAliases: true, noTypeStrippingInstalledSdk: true, newCallerCompiler: ts.version,
      installedTypeScriptCompile: compiled.receipt, newCompiledLeafSha256: hash(compiled.bytes), newExternalCallerSha256: hash(externalCaller), callerDirectory: executionRoot, wsVersion: '8.21.0', wsSha256: wsPins };
    caller = await import(pathToFileURL(join(executionRoot, ownPaths[2])).href);
  }
  proof = await caller.runNodeWireReplayQualification(new AbortController().signal); assert.equal(proof.result, 'pass');
  for (const [path, pin] of Object.entries(callerPins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  assert.equal(hash(readFileSync(fixturePath)), fixturePin);
  for (const [url, pin] of sourceClosure) assert.equal(hash(readFileSync(new URL(url))), pin);
  for (const [path, pin] of compilePins) assert.equal(hash(readFileSync(path)), pin);
  const provenancePath = join(provenanceDirectory, 'provenance.json');
  writeFileSync(provenancePath, JSON.stringify({ callerPins, fixturePin, sourceClosure: Object.fromEntries(sourceClosure), producer, executionRoot, node: process.version }, null, 2));
  const provenance = readFileSync(provenancePath); assert.ok(provenance.length <= 256 * 1024);
  const result = { result: 'pass', profile: 'direct-wss-wire-replay/1', mode: args[0] === '--source' ? 'owned-public-source-barrels' : 'new-compiled-caller-with-ordinary-installed-seven-sdk',
    nativePrefix: prefix, proof, provenance: { path: provenancePath, sha256: hash(provenance), callerPins, sourceModuleCount: sourceClosure.size,
      producerTree: producer?.tree, producerSources: producer?.sourcePins, packedFiles: producer?.packedFiles, sdkPackages: producer?.packages },
    ownedNativeContexts: 0, installedHubClaim: false, tlsCiphertextReplay: false, physicalQualification: false };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384); console.log(JSON.stringify(result, null, 2));
} finally { hook?.deregister(); }
