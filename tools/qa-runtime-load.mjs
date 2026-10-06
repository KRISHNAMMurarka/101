import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = ['examples/runtime-load/runtime-load.ts', 'tests/runtime-load.test.ts',
  'examples/runtime-load/application-target.mjs', 'tools/qa-runtime-load.mjs'];
const pins = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
assert.ok(process.argv[2] === '--source' && process.argv.length === 3 || process.argv[2] === '--sdk-root' &&
  process.argv.length === 6 && process.argv[4] === '--candidate-tree', 'Use --source or --sdk-root <consumer> --candidate-tree <tree>');
let mode, consumer, sourceTree, callerTree, dependencies, installedBytes, immutableManifest;
function gitBlob(tree, path) { return execFileSync('git', ['cat-file', 'blob', tree + ':' + path], { cwd: root, timeout: 5000, maxBuffer: 1048576 }); }
function json(path) { const bytes = readFileSync(path); assert.ok(bytes.byteLength <= 4 * 1024 * 1024); return JSON.parse(bytes); }
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory, budget = { left: 1024 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0); const path = join(directory, name), entry = lstatSync(path);
    assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) return files(path, budget);
    assert.ok(entry.isFile()); return [path];
  });
}
function diagnose(program) {
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n',
  }));
  assert.equal(program.emit().emitSkipped, false);
}
if (process.argv[2] === '--source') {
  mode = 'owned-seven-package-public-source-closure'; consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-runtime-load-source-')));
  sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const program = ts.createProgram(names.map(name => join(root, `packages/${name}/src/index.ts`)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, declaration: true, rewriteRelativeImportExtensions: true,
    rootDir: root, outDir: join(consumer, '.compiled'),
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])),
  });
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.length > 0 && sources.length <= 512 && sources.every(source => names.some(name =>
    source.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  dependencies = Object.fromEntries(sources.map(source => [relative(root, source.fileName), hash(readFileSync(source.fileName))]));
  diagnose(program);
  for (const name of names) {
    const source = join(consumer, `.compiled/packages/${name}/src`), target = join(consumer, 'node_modules', '@101', name);
    for (const path of files(source)) copy(path, join(target, 'dist', relative(source, path)));
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@101/' + name, type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
  }
} else {
  mode = 'ordinary-installed-immutable-sdk'; consumer = realpathSync(resolve(process.argv[3]));
  assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const packed = json(join(consumer, 'receipt.json')); assert.equal(packed.status, 'pass');
  sourceTree = packed.source.tree; callerTree = process.argv[5];
  assert.match(sourceTree, /^[0-9a-f]{40}$/); assert.match(callerTree, /^[0-9a-f]{40}$/);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(gitBlob(callerTree, path)), pin, 'Caller tree mismatch: ' + path);
  const bytes = readFileSync(packed.manifest.path); assert.ok(bytes.byteLength <= 4 * 1024 * 1024); assert.equal(hash(bytes), packed.manifest.sha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, sourceTree); assert.deepEqual(manifest.source.sha256, packed.source.sha256);
  dependencies = manifest.source.sha256; assert.ok(Object.keys(dependencies).length > 0 && Object.keys(dependencies).length <= 512);
  for (const [path, pin] of Object.entries(dependencies)) {
    assert.ok(resolve(root, path).startsWith(root + sep)); assert.match(pin, /^[0-9a-f]{64}$/);
    for (const tree of new Set([sourceTree, callerTree])) assert.equal(hash(gitBlob(tree, path)), pin, 'Dependency tree mismatch: ' + path);
    assert.equal(hash(readFileSync(join(root, path))), pin, 'Current dependency mismatch: ' + path);
  }
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort()); installedBytes = {};
  for (const item of manifest.packages) {
    const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const inventory = files(prefix).map(path => relative(prefix, path)).sort();
    assert.deepEqual(inventory, item.files.map(file => file.path).sort(), 'Closed installed inventory mismatch: ' + item.name);
    for (const file of item.files) {
      const installed = resolve(prefix, file.path); assert.ok(installed.startsWith(prefix + sep));
      assert.equal(realpathSync(dirname(installed)), dirname(installed)); assert.equal(realpathSync(installed), installed);
      assert.ok(lstatSync(installed).isFile()); assert.equal(hash(readFileSync(installed)), file.sha256);
      installedBytes[item.name + '/' + file.path] = file.sha256;
    }
  }
  immutableManifest = { path: packed.manifest.path, sha256: packed.manifest.sha256 };
}
const caller = realpathSync(mkdtempSync(join(consumer, 'runtime-load-caller-')));
writeFileSync(join(caller, 'package.json'), JSON.stringify({ type: 'module', private: true }));
const leaf = join(caller, 'source/runtime-load.ts'); copy(join(root, owned[0]), leaf);
const compiler = ts.createProgram([leaf], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
  types: ['node'], typeRoots: [join(root, 'node_modules/@types')], skipLibCheck: false, noEmitOnError: true,
  rootDir: join(caller, 'source'), outDir: join(caller, 'compiled'),
});
diagnose(compiler); copy(join(root, owned[2]), join(caller, 'compiled/application-target.mjs'));
const declarations = compiler.getSourceFiles().filter(source => source.isDeclarationFile);
assert.ok(declarations.length <= 1024);
const compilerDeclarationPins = Object.fromEntries(declarations.map(source => [source.fileName, hash(readFileSync(source.fileName))]));
writeFileSync(join(caller, 'resolution.mjs'), `import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';
if(sdk.createDeviceRuntime!==runtime.createDeviceRuntime)throw Error('Facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
writeFileSync(join(caller, 'consumer.mjs'), `import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RUNTIME_LOAD_TIERS,runRuntimeLoadQualification } from './compiled/runtime-load.js';
const receipts=[];
const authorize=()=>({expiresAt:performance.now()+20000,maxAgeMs:250,maxHz:50});
for(const tier of RUNTIME_LOAD_TIERS){
 const receipt=await runRuntimeLoadQualification({tier:tier.edges,signal:new AbortController().signal,authorize});
 assert.equal(receipt.status,'pass',JSON.stringify(receipt));assert.equal(receipt.allEdgesServed,true);assert.equal(receipt.turns,60);assert.ok(receipt.sustainedElapsedMs>=1000);
 assert.equal(receipt.heldOtherScopeProgress,true);assert.equal(receipt.denialDispatchDelta,0);assert.equal(receipt.overloadDispatchDelta,0);assert.equal(receipt.overloadPreserved,true);
 for(const scope of receipt.scopes){assert.equal(scope.admittedEdges,tier.edges/4);assert.ok(scope.recoveryApplied>0);assert.ok(scope.peakRaw<=2);
 for(let edge=scope.scopeIndex;edge<tier.edges;edge+=4)assert.ok(scope.perEdge[edge]>0);}
 assert.deepEqual(receipt.ownedCleanup,{workersStarted:4,workersExited:4,pendingRaw:0,timers:0,listeners:0,contexts:0});receipts.push(receipt);
}
const denied=await runRuntimeLoadQualification({tier:16,signal:new AbortController().signal,authorize:()=>undefined});
assert.equal(denied.status,'denied');assert.equal(denied.scopes.reduce((sum,row)=>sum+row.dispatched,0),0);assert.equal(denied.ownedCleanup.contexts,0);
const owner=new AbortController();let timer,admissions=0;
const cancelled=await runRuntimeLoadQualification({tier:16,signal:owner.signal,authorize:()=>{if(++admissions===16)timer=setTimeout(()=>owner.abort(),250);return authorize();}});
clearTimeout(timer);owner.abort();assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.scopes.reduce((sum,row)=>sum+row.dispatched,0)>0);
assert.deepEqual(cancelled.ownedCleanup,{workersStarted:4,workersExited:4,pendingRaw:0,timers:0,listeners:0,contexts:0});
console.log(JSON.stringify({status:'pass',receipts,negatives:{denied,cancelled},limits:RUNTIME_LOAD_TIERS,
 scope:'Actual owned Node Worker integer effects only. No RSS, thermal, SLO, phone, hardware or all-platform qualification; latest coalescing loses intermediate states; issued effects can be uncertain.'}));\n`);
function run(name) {
  const result = spawnSync(process.execPath, ['--no-experimental-strip-types', '--max-old-space-size=128', join(caller, name)], {
    cwd: caller, env: environment, timeout: 25000, maxBuffer: 262144, encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'Ordinary compiled public caller failed: ' + (result.error?.code ?? result.stderr.slice(0, 2400)));
  assert.equal(result.stderr, ''); return result.stdout;
}
const resolutions = run('resolution.mjs').trim().split('\n').map(line => JSON.parse(line));
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
const proof = JSON.parse(run('consumer.mjs')); assert.equal(proof.status, 'pass'); assert.equal(proof.receipts.length, 3);
for (const [path, pin] of Object.entries({ ...pins, ...dependencies })) assert.equal(hash(readFileSync(join(root, path))), pin, 'Source changed during proof: ' + path);
if (installedBytes) for (const [path, pin] of Object.entries(installedBytes)) assert.equal(hash(readFileSync(join(consumer, 'node_modules', path))), pin);
for (const [path, pin] of Object.entries(compilerDeclarationPins)) assert.equal(hash(readFileSync(path)), pin);
const receipt = { schemaVersion: 1, status: 'pass', profile: 'subscribed-runtime-load/1', mode, sourceTree, callerTree,
  sourceSha256: pins, dependencySourceSha256: dependencies, ...(immutableManifest ? { immutableManifest, installedBytesSha256: installedBytes } : {}),
  environment: { node: process.version, platform: process.platform, arch: process.arch, typescript: ts.version,
    compilerSha256: hash(readFileSync(join(root, 'node_modules/typescript/lib/typescript.js'))) },
  compilerDeclarationSha256: compilerDeclarationPins, consumer, callerDirectory: caller, publicEsmResolutions: resolutions,
  callerSha256: Object.fromEntries(files(caller).map(path => [relative(caller, path), hash(readFileSync(path))])), proof,
  scope: 'Fixed sparse subscribed graph/session qualification on this measured Node environment. Exact owner/app/session admission, separate worker clock and parent ACK timing; no fabricated capacity/SLO/native/hardware/thermal claims.' };
const receiptPath = join(caller, 'receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
