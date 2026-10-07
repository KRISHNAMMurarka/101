import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = ['packages/device-runtime/src/wearable-calibration.ts', 'packages/device-runtime/src/wearable-calibration.test.ts',
  'examples/watch-companion/calibration.mjs', 'tools/qa-wearable-calibration.mjs'];
const inputs = ['bindings/watch-report/fixtures/watch-report-v1.json', 'apps/watch-ios/Sources/One01WatchCore/WatchPayload.swift',
  'apps/watch-wear/app/src/main/java/com/oneohone/wear/WatchPayload.kt'];
const names = ['connect', 'device-model', 'device-runtime', 'device-web', 'vision', 'transport-webrtc', 'transport-websocket'];
const args = process.argv.slice(2), sourceMode = args[0] === '--source';
assert.ok(sourceMode && args.length === 2 || args[0] === '--installed' && args.length === 4,
  'Use --source <immutable-caller-tree> or --installed <manifest> <clean-consumer> <immutable-caller-tree>');
assert.equal(process.version, 'v24.14.0');
const callerTree = sourceMode ? args[1] : args[3]; assert.match(callerTree, /^[0-9a-f]{40}$/);
const ownPins = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const nonModuleInputs = Object.fromEntries(inputs.map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
function run(program, arguments_, options = {}) {
  return execFileSync(program, arguments_, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, ...options });
}
function json(path) { const bytes = readFileSync(path); assert.ok(bytes.byteLength <= 4 * 1024 * 1024); return JSON.parse(bytes); }
function files(base) { return readdirSync(base).sort().flatMap(name => {
  const file = join(base, name); assert.equal(lstatSync(file).isSymbolicLink(), false);
  return lstatSync(file).isDirectory() ? files(file) : [file];
}); }
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function gitPins(entries) {
  assert.ok(entries.length > 0 && entries.length <= 1024);
  const requests = entries.map(([tree, path]) => {
    assert.match(tree, /^[0-9a-f]{40}$/); assert.ok(typeof path === 'string' && path.length <= 512 &&
      !/[\r\n\0:]/.test(path) && !path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..'));
    return tree + ':' + path;
  });
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: requests.join('\n') + '\n', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  let offset = 0;
  for (const [, , pin] of entries) {
    const newline = bytes.indexOf(10, offset); assert.ok(newline > offset && newline - offset <= 128);
    const header = bytes.subarray(offset, newline).toString('ascii').match(/^[0-9a-f]{40} blob (0|[1-9][0-9]*)$/); assert.ok(header);
    const length = Number(header[1]); assert.ok(Number.isSafeInteger(length) && length <= 1048576);
    offset = newline + 1; assert.ok(offset + length < bytes.length); assert.equal(hash(bytes.subarray(offset, offset + length)), pin);
    offset += length; assert.equal(bytes[offset], 10); offset++;
  }
  assert.equal(offset, bytes.length);
}
function diagnostics(program) {
  const list = ts.getPreEmitDiagnostics(program);
  assert.equal(list.length, 0, ts.formatDiagnosticsWithColorAndContext(list, { getCurrentDirectory: () => root,
    getCanonicalFileName: file => file, getNewLine: () => '\n' }));
}
let consumer, directory, sourcePins, sourceTree, manifestRef, installedPins, tarballPins, compilerPins;
let child, childClosed = true, timer, childResult;
const compilerSettings = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] };
try {
  if (sourceMode) {
    directory = realpathSync(mkdtempSync(join(realpathSync('/tmp'), '101-wearable-calibration-source-'))); consumer = directory;
    const paths = Object.fromEntries(names.map(name => ['@101/' + name, [join(root, 'packages', name, 'src/index.ts')]]));
    const program = ts.createProgram(names.map(name => join(root, 'packages', name, 'src/index.ts')), {
      ...compilerSettings, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: root, outDir: join(directory, 'compiled'), paths });
    diagnostics(program);
    const actual = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    assert.ok(actual.length > 0 && actual.length <= 512 && actual.every(file => names.some(name => file.fileName.startsWith(join(root, 'packages', name, 'src') + '/')) && !file.fileName.endsWith('.test.ts')));
    sourcePins = Object.fromEntries(actual.map(file => [relative(root, file.fileName), hash(Buffer.from(file.text))])); sourceTree = callerTree;
    compilerPins = Object.fromEntries(program.getSourceFiles().map(file => [file.fileName, hash(Buffer.from(file.text))]));
    for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(readFileSync(join(root, path))), pin);
    gitPins(Object.entries({ ...sourcePins, ...ownPins, ...nonModuleInputs }).map(([path, pin]) => [callerTree, path, pin]));
    assert.equal(program.emit().emitSkipped, false);
    for (const name of names) {
      const from = join(directory, 'compiled/packages', name, 'src'), to = join(directory, 'node_modules/@101', name), emitted = files(from);
      assert.ok(emitted.length > 0 && emitted.length <= 1024);
      for (const path of emitted) copy(path, join(to, 'dist', relative(from, path)));
      writeFileSync(join(to, 'package.json'), JSON.stringify({ name: '@101/' + name, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
    }
  } else {
    const manifestPath = realpathSync(args[1]), manifestBytes = readFileSync(manifestPath), manifest = json(manifestPath);
    consumer = realpathSync(args[2]); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const receipt = json(join(consumer, 'receipt.json')); assert.equal(receipt.status, 'pass');
    assert.equal(realpathSync(receipt.manifest.path), manifestPath); assert.equal(receipt.manifest.sha256, hash(manifestBytes));
    assert.equal(receipt.source.tree, manifest.source.tree); assert.deepEqual(receipt.source.sha256, manifest.source.sha256);
    sourceTree = manifest.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/); sourcePins = manifest.source.sha256;
    assert.ok(Object.keys(sourcePins).length > 0 && Object.keys(sourcePins).length <= 512 && Object.hasOwn(sourcePins, owned[0]));
    assert.equal(sourcePins[owned[0]], ownPins[owned[0]]);
    gitPins([...Object.entries(sourcePins).flatMap(([path, pin]) => [...new Set([sourceTree, callerTree])].map(tree => [tree, path, pin])),
      ...Object.entries({ ...ownPins, ...nonModuleInputs }).map(([path, pin]) => [callerTree, path, pin])]);
    assert.equal(manifest.packages.length, 7); assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
    installedPins = {}; tarballPins = {};
    for (const item of manifest.packages) {
      const tarball = resolve(dirname(manifestPath), item.tarball); assert.equal(realpathSync(tarball), tarball);
      assert.equal(dirname(tarball), join(dirname(manifestPath), 'tarballs')); assert.ok(lstatSync(tarball).isFile());
      assert.equal(hash(readFileSync(tarball)), item.sha256); assert.equal(lstatSync(tarball).size, item.bytes); tarballPins[tarball] = item.sha256;
      assert.ok(item.files.length > 0 && item.files.length <= 1024);
      const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix); assert.equal(realpathSync(dirname(prefix)), dirname(prefix));
      const listed = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean).filter(path => !path.endsWith('/')).sort();
      assert.deepEqual(listed, item.files.map(file => 'package/' + file.path).sort());
      assert.deepEqual(files(prefix).map(path => relative(prefix, path)).sort(), item.files.map(file => file.path).sort());
      for (const file of item.files) {
        const target = resolve(prefix, file.path); assert.ok(target.startsWith(prefix + '/')); assert.equal(realpathSync(target), target);
        assert.equal(realpathSync(dirname(target)), dirname(target)); assert.equal(lstatSync(target).size, file.size);
        assert.equal(hash(readFileSync(target)), file.sha256); installedPins[target] = file.sha256;
      }
    }
    manifestRef = { path: manifestPath, sha256: hash(manifestBytes) };
    directory = realpathSync(mkdtempSync(join(consumer, 'wearable-calibration-caller-')));
    writeFileSync(join(directory, 'api.ts'), `import { createWearableCalibrationProcessor, wearableFusionInputDevice, WEARABLE_CALIBRATION_PROFILE, WEARABLE_CALIBRATION_LIMITS } from '@101/connect';
import type { WearableReviewedProfile, WearableCalibrationConfiguration, WearableCalibrationHandle, WearableFusionInput, WearableCalibrationProcessor, WearableCalibrationOptions, WearableCalibrationDeliveryScope, WearableCalibrationResult } from '@101/connect';
const options: WearableCalibrationOptions = {clockDomain:'declaration-only',now:()=>0};
const processor: WearableCalibrationProcessor = createWearableCalibrationProcessor(options);
const scope: WearableCalibrationDeliveryScope = {routeId:'route:declaration',expiresAt:100,maxAgeMs:25};void scope;
function typed(config: WearableCalibrationConfiguration, profile: WearableReviewedProfile, handle: WearableCalibrationHandle, value: WearableFusionInput): WearableCalibrationResult<WearableCalibrationHandle> {
wearableFusionInputDevice('software:declared',profile.sourceFrame,config.calibration.revision);processor.isCurrent(handle);void value.provenance;void WEARABLE_CALIBRATION_PROFILE;void WEARABLE_CALIBRATION_LIMITS;return processor.configure(config);}
void typed;processor.close();\n`);
    const program = ts.createProgram([join(directory, 'api.ts')], { ...compilerSettings, noEmit: true }); diagnostics(program);
    compilerPins = Object.fromEntries(program.getSourceFiles().map(file => [file.fileName, hash(Buffer.from(file.text))]));
    assert.ok(Object.keys(compilerPins).length <= 512 && !Object.keys(compilerPins).some(path => path.startsWith(join(root, 'packages') + '/')));
  }
  // This .mjs is deliberately an external reference caller, not a packaged SDK example.
  copy(join(root, owned[2]), join(directory, 'calibration.mjs'));
  writeFileSync(join(directory, 'fixture.json'), readFileSync(join(root, inputs[0])));
  writeFileSync(join(directory, 'run.mjs'), `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';
import {runWearableCalibrationExample} from './calibration.mjs';
for(const name of ['createWearableCalibrationProcessor','wearableFusionInputDevice','WEARABLE_CALIBRATION_PROFILE','WEARABLE_CALIBRATION_LIMITS'])assert.equal(sdk[name],runtime[name]);
const resolutions=Object.fromEntries(${JSON.stringify(names)}.map(name=>['@101/'+name,import.meta.resolve('@101/'+name)]));
const proof=await runWearableCalibrationExample(JSON.parse(readFileSync(new URL('./fixture.json',import.meta.url))));console.log(JSON.stringify({...proof,resolutions}));\n`);
  const callerPin = hash(readFileSync(join(directory, 'calibration.mjs'))); assert.equal(callerPin, ownPins[owned[2]]);
  childResult = await new Promise((accept, reject) => {
    let stdout = '', stderr = '', exceeded = false, timedOut = false;
    child = spawn(process.execPath, ['--no-experimental-strip-types', join(directory, 'run.mjs')], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }); childClosed = false;
    timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 5000);
    const capture = (kind, bytes) => { if (kind === 'out') stdout += bytes; else stderr += bytes;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { exceeded = true; child.kill('SIGTERM'); } };
    child.stdout.on('data', bytes => capture('out', bytes)); child.stderr.on('data', bytes => capture('err', bytes));
    child.once('error', error => { childResult = { stdout, stderr, error: String(error.message), status: null }; });
    child.once('close', (status, signal) => { childClosed = true; clearTimeout(timer); timer = undefined;
      if (childResult?.error) reject(Error('owned child construction failed'));
      else accept({ status, signal, timedOut, exceeded, stdout, stderr }); });
  });
  assert.equal(childResult.timedOut, false); assert.equal(childResult.exceeded, false); assert.equal(childResult.status, 0, childResult.stderr);
  assert.equal(childResult.signal, null); assert.equal(childResult.stderr, '');
  const proof = JSON.parse(childResult.stdout); assert.equal(proof.status, 'pass'); assert.equal(proof.checks.length, 20);
  assert.equal(proof.physicalValidity, 'unspecified'); assert.equal(proof.captureTimeKnown, false); assert.equal(proof.rawSoftwarePromises, 0);
  assert.equal(Object.keys(proof.resolutions).length, 7);
  for (const name of names) assert.equal(proof.resolutions['@101/' + name], pathToFileURL(join(consumer, 'node_modules/@101', name, 'dist/index.js')).href);
  for (const [path, pin] of Object.entries({ ...ownPins, ...nonModuleInputs, ...sourcePins })) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of Object.entries(compilerPins)) assert.equal(hash(readFileSync(path)), pin);
  for (const [path, pin] of Object.entries(installedPins ?? {})) assert.equal(hash(readFileSync(path)), pin);
  for (const [path, pin] of Object.entries(tarballPins ?? {})) assert.equal(hash(readFileSync(path)), pin);
  if (manifestRef) assert.equal(hash(readFileSync(manifestRef.path)), manifestRef.sha256);
  const result = { status: 'pass', mode: sourceMode ? 'owned-public-source-closure' : 'ordinary-installed-public-sdk', callerTree, sourceTree,
    manifest: manifestRef, ownedSha256: ownPins, sourceDependencySha256: sourcePins, nonModuleInputs, compilerPins, installedPins, tarballPins,
    toolchain: { node: process.version, typescript: ts.version }, sourceAliases: sourceMode, installedExampleExport: false,
    callerSha256: callerPin, child: { status: childResult.status, signal: childResult.signal, stdoutSha256: hash(childResult.stdout), stdoutBytes: Buffer.byteLength(childResult.stdout) },
    proof, qualification: 'Declared reported semantics and genuine runtime software application only; no sensor capture, physical calibration or native watch framework delivery.',
    cleanup: { ownedChildren: 0, ownedDirectories: 0 } };
  assert.equal(childClosed, true); rmSync(directory, { recursive: true }); assert.throws(() => lstatSync(directory)); directory = undefined;
  console.log(JSON.stringify(result));
} finally {
  if (timer) clearTimeout(timer);
  if (child && !childClosed) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
  if (directory) rmSync(directory, { recursive: true });
}
