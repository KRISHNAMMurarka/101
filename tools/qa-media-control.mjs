import { isSdkBrowserPublicFile } from './sdk-browser-inventory.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// This is a bounded native composition drill, not a browser/media transport or
// physical capture qualification. The helper's raster/contact effects execute
// in two independently running private Workers. No network listener is opened.
const args = process.argv.slice(2);
const installed = args[0] === '--installed', sharedRed = args[1] === '--shared-red';
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--source' && sharedRed ||
  args.length === 4 && installed, 'Use --source [--shared-red] or --installed <manifest> <clean-consumer> <immutable-caller-tree>');
assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..'));
const hash = value => createHash('sha256').update(value).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['examples/media-control/media-control.ts', 'examples/media-control/application-target.mjs', 'tests/media-control.test.ts', 'tools/qa-media-control.mjs', 'tools/sdk-browser-inventory.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(bytes(join(root, path)))]));
let consumer, scratch, sourceTree, callerTree, immutableManifest, dependencyPins, installedBytes, tarballPins, compilerDeclarationPins, compilerStandardTypePins, receipt;

function bytes(path, limit = 4 * 1024 * 1024) {
  const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.ok(stat.size <= limit);
  const value = readFileSync(path); assert.ok(value.byteLength <= limit); return value;
}
function json(path) { return JSON.parse(bytes(path)); }
function files(directory, budget = { left: 1024 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0, 'File inventory bound'); const path = join(directory, name), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) return files(path, budget);
    assert.equal(stat.isFile(), true); return [path];
  });
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function diagnose(program) {
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics,
    { getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
}
function gitBlobs(queries) {
  const keys = [...new Set(queries)]; assert.ok(keys.length > 0 && keys.length <= 1028);
  for (const key of keys) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
  const response = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: keys.join('\n') + '\n', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  let cursor = 0; const values = new Map();
  for (const key of keys) {
    const end = response.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128);
    const header = response.subarray(cursor, end).toString('ascii').match(/^([0-9a-f]{40}) blob ([0-9]+)$/); assert.ok(header);
    const size = Number(header[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    const first = end + 1, last = first + size; assert.ok(last < response.byteLength); assert.equal(response[last], 10);
    values.set(key, hash(response.subarray(first, last))); cursor = last + 1;
  }
  assert.equal(cursor, response.byteLength); assert.equal(values.size, keys.length); return values;
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
      const actual = bytes(path); assert.equal(actual.byteLength, file.size); assert.equal(hash(actual), file.sha256); installedBytes[item.name + '/' + file.path] = file.sha256;
    }
  }
}
async function nativeRun(driver) {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  // Async launch follows the actual Worker/native composition rather than
  // blocking the compiler parent in a second synchronous runtime launch.
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--no-experimental-strip-types', driver], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60000);
    function collect(kind, value) {
      if (kind === 'stdout') stdout += value.toString('utf8'); else stderr += value.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 262144) { failure = Error('Native output bound'); child.kill('SIGTERM'); }
    }
    child.stdout.on('data', value => collect('stdout', value)); child.stderr.on('data', value => collect('stderr', value));
    child.on('error', error => { failure = error; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (failure) rejectRun(failure); else if (timedOut) rejectRun(Error('Native harness deadline60000ms: ' + signal));
      else resolveRun({ status, signal, stdout, stderr, rawProcessSettled: true });
    });
  });
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
    const queries = owned.map(path => callerTree + ':' + path);
    for (const [path, pin] of Object.entries(dependencyPins)) {
      assert.ok(!isAbsolute(path) && resolve(root, path).startsWith(root + sep) && !path.split('/').includes('..')); assert.match(pin, /^[0-9a-f]{64}$/);
      assert.equal(hash(bytes(join(root, path))), pin, 'Current SDK source mismatch: ' + path);
      for (const tree of new Set([sourceTree, callerTree])) queries.push(tree + ':' + path);
    }
    const blobs = gitBlobs(queries);
    for (const [path, pin] of Object.entries(fingerprints)) assert.equal(blobs.get(callerTree + ':' + path), pin, 'Immutable caller mismatch: ' + path);
    for (const [path, pin] of Object.entries(dependencyPins)) for (const tree of new Set([sourceTree, callerTree])) assert.equal(blobs.get(tree + ':' + path), pin, 'Immutable SDK source mismatch: ' + path);
    immutableManifest = { path: manifestPath, sha256: packed.manifest.sha256 }; checkInstalled(manifest);
    scratch = realpathSync(mkdtempSync(join(consumer, 'media-control-caller-')));
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const caller = join(scratch, 'source/media-control.ts'); copy(join(root, owned[0]), caller);
    // Isolate the real Node declarations from unrelated monorepo browser polyfills.
    const standardTypes = join(scratch, 'standard-types/node_modules'); compilerStandardTypePins = {};
    for (const name of ['@types/node', 'undici-types']) {
      const source = realpathSync(join(root, 'node_modules', name));
      for (const path of files(source).filter(path => path.endsWith('.d.ts') || relative(source, path) === 'package.json')) {
        const target = join(standardTypes, name, relative(source, path)), pin = hash(bytes(path)); copy(path, target);
        assert.equal(hash(bytes(target)), pin); compilerStandardTypePins[path] = pin; compilerStandardTypePins[target] = pin;
      }
    }
    const program = ts.createProgram([caller], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'], typeRoots: [join(standardTypes, '@types')],
      strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, rootDir: join(scratch, 'source'), outDir: join(scratch, 'compiled') });
    assert.deepEqual(program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => file.fileName), [caller], 'Compile only the ordinary external caller');
    const declarationRoots = [join(consumer, 'node_modules'), realpathSync(join(root, 'node_modules/typescript/lib')), standardTypes];
    const declarations = program.getSourceFiles().filter(file => file.isDeclarationFile); assert.ok(declarations.length > 0 && declarations.length <= 1024);
    for (const file of declarations) { const path = realpathSync(file.fileName); assert.ok(declarationRoots.some(prefix => path.startsWith(prefix + sep)), 'Declaration escaped installed SDK/compiler/standard Node declarations: ' + path); }
    compilerDeclarationPins = Object.fromEntries(declarations.map(file => [realpathSync(file.fileName), hash(bytes(realpathSync(file.fileName)))]));
    diagnose(program);
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-media-control-')); scratch = consumer;
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-media-control-')));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }));
    const compiled = join(consumer, '.compiled'), roots = [...names.map(name => join(root, `packages/${name}/src/index.ts`)), join(root, owned[0])];
    const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'], typeRoots: [join(root, 'node_modules/@types')],
      strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])) });
    const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    assert.ok(sources.length > 0 && sources.length <= 512 && sources.every(file => file.fileName === join(root, owned[0]) ||
      names.some(name => file.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !file.fileName.endsWith('.test.ts')));
    diagnose(program); dependencyPins = Object.fromEntries(sources.map(file => [relative(root, file.fileName), hash(bytes(file.fileName))]));
    assert.equal(dependencyPins[owned[0]], fingerprints[owned[0]]);
    for (const name of names) {
      const destination = join(consumer, 'node_modules/@101', name), directory = join(compiled, `packages/${name}/src`);
      for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: '@101/' + name, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
    }
    copy(join(compiled, owned[0].replace(/\.ts$/, '.js')), join(scratch, 'compiled/media-control.js'));
  }
  const target = join(scratch, 'compiled/application-target.mjs'); copy(join(root, owned[1]), target);
  assert.equal(hash(bytes(target)), fingerprints[owned[1]], 'Native target bytes pinned before launch');
  const driver = join(scratch, 'driver.mjs');
  writeFileSync(driver, `import assert from 'node:assert/strict';import{performance}from'node:perf_hooks';
import{runMediaControlQualification,runSharedMediaControlNegative,MEDIA_CONTROL_LIMITS}from'./compiled/media-control.js';
import*as sdk from'@101/connect';
const names=${JSON.stringify(names)},resolutions=names.map(name=>({name,url:import.meta.resolve('@101/'+name)}));
assert.equal(typeof sdk.createDeviceRuntime,'function');assert.equal(typeof sdk.readVerifiedResource,'function');
const results=[];function options(owner,mode){return{signal:owner.signal,
authorize(request){if(!['media-recipient-0','media-recipient-1','control-owner'].includes(request.principalId)||request.applicationId!=='media-control-example'||request.sessionId!=='owned-worker-session')return;return{expiresAt:performance.now()+9000,maxAgeMs:1000,maxHz:30};},
approveMedia(request){if(mode==='media-denied')return;if(mode==='owner-reentrant'){owner.abort();return;}return{request,signal:owner.signal,grant:{expiresAt:performance.now()+9000,maxAgeMs:1000,maxHz:30}};},
authorizeResource(request){if(mode==='resource-denied'||!['media-recipient-0','media-recipient-1'].includes(request.principalId)||request.applicationId!=='media-control-example'||request.sessionId!=='owned-worker-session')return;return{expiresAt:performance.now()+9000,maxBytes:65536};}};}
function clean(result){const c=result.ownedCleanup;assert.equal(c.workersExited,c.workersStarted);for(const key of['rawOperations','rawBytes','timers','listeners'])assert.equal(c[key],0);assert.ok(result.peakCallerBytes<=524288);assert.ok(result.frameAttempts<=64);assert.ok(result.controlAttempts<=64);}
async function run(kind){const owner=new AbortController();const result=await(kind==='shared'?runSharedMediaControlNegative:runMediaControlQualification)(options(owner,kind));results.push({case:kind,result});clean(result);return result;}
try{const shared=await run('shared');assert.equal(shared.status,'pass');assert.equal(shared.topology,'shared-negative');assert.equal(shared.controlDuringHeldMedia,false);
if(${JSON.stringify(sharedRed)}){console.log(JSON.stringify({profile:'intentional-shared-runtime-composition-red',resolutions,results}));assert.equal(shared.controlDuringHeldMedia,true,'Missing example composition: actual shared media ACKs block contact; this is not a scheduler bug');}
const split=await run('split');assert.equal(split.status,'pass',split.reason);for(const key of['controlDuringHeldMedia','latestReplacementObserved','slowFastIsolationObserved','adaptedFrameObserved','rawRetainedAfterRevoke','corruptRejected','overbyteRejected','expiryReleasedControl'])assert.equal(split[key],true,key);assert.equal(split.oldEpochAckActivated,false);assert.equal(split.ownedCleanup.workersStarted,2);assert.ok(split.targets.every(target=>target.mediaObserved>=2&&target.lastWidth===64&&target.nativeClock.count>0));
const denied=await run('media-denied');assert.equal(denied.status,'denied');assert.equal(denied.deniedMediaDispatched,0);assert.ok(denied.targets.every(target=>target.mediaDispatched===0));
const resource=await run('resource-denied');assert.equal(resource.status,'failed');assert.ok(resource.targets.every(target=>target.mediaDispatched===0));
const reentrant=await run('owner-reentrant');assert.equal(reentrant.status,'cancelled');assert.ok(reentrant.targets.every(target=>target.mediaDispatched===0));
console.log(JSON.stringify({status:'pass-selected-native-composition',limits:MEDIA_CONTROL_LIMITS,resolutions,results,ownedWorkers:0}));}
catch(error){console.log(JSON.stringify({status:'failed',resolutions,results}));throw error;}
`);
  const native = await nativeRun(driver); assert.equal(native.status, 0, native.stderr + '\n' + native.stdout); assert.equal(native.signal, null); assert.equal(native.stderr, '');
  const proof = JSON.parse(native.stdout); assert.equal(proof.status, 'pass-selected-native-composition');
  for (const item of proof.resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules/@101', item.name, 'dist/index.js')).href);
  for (const [path, pin] of Object.entries({ ...compilerDeclarationPins, ...compilerStandardTypePins })) assert.equal(hash(bytes(path)), pin, 'Compiler input drift: ' + path);
  receipt = { schemaVersion: 1, status: 'pass-selected-local-profile', sourceOnly: !installed,
    qualification: installed ? 'ordinary installed seven-package SDK; separately pinned caller/Worker' : 'compiled ordinary public source graph; no installed artifact claim',
    sourceTree, callerTree, fingerprints, dependencyPins, immutableManifest, installedBytes, tarballPins, compilerDeclarationPins, compilerStandardTypePins,
    node: process.version, platform: process.platform, architecture: process.arch, typescript: ts.version, proof,
    scope: 'Authored RGBA bytes and typed contact apply/release in two private Node Workers. Native emission and host source clocks remain distinct. No hardware, camera, codec, browser media, RTC/WSS, network transport or sandbox claim.' };
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
assert.ok(receipt); receipt.cleanup = { ownedProcesses: 0, ownedWorkers: 0, ownedServers: 0, scratchAbsent: !existsSync(scratch) };
console.log(JSON.stringify(receipt, null, 2));
