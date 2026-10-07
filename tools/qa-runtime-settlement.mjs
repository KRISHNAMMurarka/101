import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 4 && args[0] === '--installed',
  'Use --source or --installed <manifest> <clean-consumer> <immutable-caller-tree>');
assert.equal(process.version, 'v24.14.0'); assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/types.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/inspector.ts',
  'packages/device-runtime/src/route-settlement.test.ts', 'examples/runtime-lifecycle/settlement.ts', 'tools/qa-runtime-settlement.mjs'];
const pins = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const proofDirectory = realpathSync(mkdtempSync('/tmp/101-runtime-settlement-proof-'));
let consumer, scratch, dependencies, installedBytes, manifestPin, tarballPins, sourceTree, callerTree, provenance;
function bytes(path, maximum = 4 * 1024 * 1024) {
  const info = lstatSync(path); assert.equal(info.isSymbolicLink(), false); assert.equal(info.isFile(), true); assert.ok(info.size <= maximum);
  const value = readFileSync(path); assert.ok(value.byteLength <= maximum); return value;
}
function json(path) { return JSON.parse(bytes(path)); }
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory, budget = { left: 1024 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0); const path = join(directory, name), info = lstatSync(path);
    assert.equal(info.isSymbolicLink(), false); if (info.isDirectory()) return files(path, budget);
    assert.equal(info.isFile(), true); return [path];
  });
}
function gitBlobs(trees, paths) {
  for (const tree of trees) assert.match(tree, /^[0-9a-f]{40}$/);
  for (const path of paths) assert.ok(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !isAbsolute(path) &&
    ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && resolve(root, path).startsWith(root + sep));
  const requests = [...new Set(trees)].flatMap(tree => [...new Set(paths)].map(path => tree + ':' + path));
  assert.ok(requests.length > 0 && requests.length <= 1024);
  const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: requests.join('\n') + '\n', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const blobs = new Map(); let offset = 0;
  for (const request of requests) {
    const end = output.indexOf(10, offset); assert.ok(end >= 0);
    const header = output.subarray(offset, end).toString().split(' '); assert.equal(header.length, 3);
    assert.match(header[0], /^[0-9a-f]{40}$/); assert.equal(header[1], 'blob');
    const size = Number(header[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    offset = end + 1; assert.ok(offset + size < output.length); blobs.set(request, output.subarray(offset, offset + size)); offset += size;
    assert.equal(output[offset++], 10);
  }
  assert.equal(offset, output.length); return blobs;
}
function compile(program) {
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => '\n' }));
  assert.equal(program.emit().emitSkipped, false);
}
function checkInstalled(manifest) {
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
  installedBytes = {}; tarballPins = {};
  const output = realpathSync(manifest.outputDir); assert.ok(output.startsWith(join(realpathSync(join(root, 'release')), 'sdk-')));
  assert.ok(manifestPin.path.startsWith(output + sep));
  for (const item of manifest.packages) {
    assert.ok(isAbsolute(item.tarball)); assert.equal(realpathSync(item.tarball), item.tarball); assert.ok(item.tarball.startsWith(output + sep));
    const archive = bytes(item.tarball, 8 * 1024 * 1024); assert.equal(hash(archive), item.sha256); assert.equal(archive.byteLength, item.bytes);
    tarballPins[item.tarball] = item.sha256; assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
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
    assert.deepEqual(files(prefix).map(path => relative(prefix, path)).sort(), [...paths].sort());
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path);
      const actual = bytes(path); assert.equal(actual.byteLength, file.size); assert.equal(hash(actual), file.sha256);
      installedBytes[item.name + '/' + file.path] = file.sha256;
    }
  }
}
try {
  if (args[0] === '--installed') {
    consumer = realpathSync(resolve(args[2])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const receipt = json(join(consumer, 'receipt.json')); assert.equal(receipt.status, 'pass');
    const manifestPath = realpathSync(resolve(args[1])); assert.equal(receipt.manifest.path, manifestPath);
    const manifestBytes = bytes(manifestPath); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
    manifestPin = { path: manifestPath, sha256: hash(manifestBytes) }; const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.schemaVersion, 1); sourceTree = manifest.source.tree; callerTree = args[3];
    assert.equal(receipt.source.tree, sourceTree); assert.deepEqual(receipt.source.sha256, manifest.source.sha256);
    dependencies = manifest.source.sha256; assert.ok(Object.keys(dependencies).length > 0 && Object.keys(dependencies).length <= 512);
    const blobs = gitBlobs([sourceTree, callerTree], [...owned, ...Object.keys(dependencies)]);
    for (const [path, pin] of Object.entries(pins)) assert.equal(hash(blobs.get(callerTree + ':' + path)), pin);
    for (const path of owned.slice(0, 3)) assert.equal(dependencies[path], pins[path], 'Actual settlement implementation packaged');
    for (const [path, pin] of Object.entries(dependencies)) {
      assert.match(pin, /^[0-9a-f]{64}$/);
      for (const tree of new Set([sourceTree, callerTree])) assert.equal(hash(blobs.get(tree + ':' + path)), pin);
      assert.equal(hash(bytes(join(root, path))), pin);
    }
    checkInstalled(manifest);
    scratch = realpathSync(mkdtempSync(join(consumer, 'route-settlement-caller-')));
  } else {
    consumer = realpathSync(mkdtempSync('/tmp/101-runtime-settlement-source-')); scratch = consumer;
    const program = ts.createProgram(names.map(name => join(root, `packages/${name}/src/index.ts`)), {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
      types: [], skipLibCheck: false, noEmitOnError: true, declaration: true, rewriteRelativeImportExtensions: true,
      rootDir: root, outDir: join(consumer, '.compiled'),
      paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])) });
    const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile);
    assert.ok(sources.length > 0 && sources.length <= 512 && sources.every(file => names.some(name => file.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !file.fileName.endsWith('.test.ts')));
    dependencies = Object.fromEntries(sources.map(file => [relative(root, file.fileName), hash(bytes(file.fileName))])); compile(program);
    for (const path of owned.slice(0, 3)) assert.equal(dependencies[path], pins[path]);
    for (const name of names) {
      const source = join(consumer, `.compiled/packages/${name}/src`), target = join(consumer, 'node_modules', '@101', name);
      for (const path of files(source)) copy(path, join(target, 'dist', relative(source, path)));
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@101/' + name, type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
    }
  }
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  const caller = join(scratch, 'source/settlement.ts'); copy(join(root, owned[4]), caller);
  const program = ts.createProgram([caller], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, rootDir: join(scratch, 'source'), outDir: join(scratch, 'compiled') });
  assert.deepEqual(program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => file.fileName), [caller]);
  const library = realpathSync(join(root, 'node_modules/typescript/lib'));
  const declarations = program.getSourceFiles().filter(file => file.isDeclarationFile); assert.ok(declarations.length > 0 && declarations.length <= 1024);
  const declarationPins = {};
  for (const file of declarations) {
    const path = realpathSync(file.fileName); assert.ok(path.startsWith(join(consumer, 'node_modules') + sep) || path.startsWith(library + sep)); declarationPins[path] = hash(bytes(path));
  }
  compile(program);
  const resolution = spawnSync(process.execPath, ['--input-type=module', '-e', names.map(name => `console.log(JSON.stringify({name:${JSON.stringify(name)},url:import.meta.resolve(${JSON.stringify('@101/' + name)})}));`).join('\n')],
    { cwd: scratch, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(resolution.status, 0, resolution.stderr); assert.equal(resolution.stderr, '');
  const publicResolutions = resolution.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.equal(publicResolutions.length, 7);
  for (const item of publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);

  const workerCode = `const {parentPort}=require('node:worker_threads');
const pending=new Map();let messages=0,effects=0,state=false;
function fields(v,k){return v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));}
parentPort.on('message',v=>{if(++messages>16)throw Error('Native message budget');
if(fields(v,['kind','id','value'])&&v.kind==='apply'&&Number.isInteger(v.id)&&v.id>=1&&v.id<=2&&typeof v.value==='boolean'){if(pending.size||pending.has(v.id))throw Error('Native pending budget');pending.set(v.id,v.value);parentPort.postMessage({kind:'held',id:v.id});return;}
if(fields(v,['kind','id','fail'])&&v.kind==='release'&&Number.isInteger(v.id)&&v.id>=1&&v.id<=2&&typeof v.fail==='boolean'){if(!pending.has(v.id))return;const value=pending.get(v.id);pending.delete(v.id);if(v.fail)parentPort.postMessage({kind:'failed',id:v.id});else{state=value;effects++;parentPort.postMessage({kind:'applied',id:v.id,value});}return;}
if(fields(v,['kind'])&&v.kind==='close'){if(pending.size)throw Error('Close before native settlement');parentPort.postMessage({kind:'closed',effects,state,pending:pending.size,messages});parentPort.close();return;}
throw Error('Closed native target command');});parentPort.postMessage({kind:'ready'});`;
  const driver = `import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';import {runRouteSettlementCaller} from './compiled/settlement.js';
const code=${JSON.stringify(workerCode)},worker=new Worker(code,{eval:true});const pending=new Map(),held=new Map();let readyResolve,readyReject,exitResolve,exitCode,closed,settled=false;
const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;}),exited=new Promise(r=>{exitResolve=r;});
let failure;function fail(e){failure=e;readyReject(e);for(const job of pending.values())job.reject(e);for(const job of held.values())job.reject(e);pending.clear();held.clear();}
function message(value){assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype);if(value.kind==='ready'){readyResolve();return;}if(value.kind==='held'){assert.ok(held.has(value.id));held.get(value.id).resolve();held.delete(value.id);return;}if(value.kind==='applied'||value.kind==='failed'){assert.ok(pending.has(value.id));const job=pending.get(value.id);pending.delete(value.id);if(value.kind==='failed')job.reject(Error('Actual software target refused'));else job.resolve();return;}if(value.kind==='closed'){closed=value;return;}throw Error('Unexpected native result');}
worker.on('message',value=>{try{message(value);}catch(e){fail(e);}});worker.once('error',fail);worker.once('exit',code=>{exitCode=code;if(pending.size||held.size)fail(Error('Target exited with unresolved work'));exitResolve();});
const timer=setTimeout(()=>{fail(Error('Owned software fixture deadline'));void worker.terminate();},15000);
try{await ready;const target={apply(id,value){assert.ok(!pending.has(id)&&pending.size===0);const done=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));const wait=new Promise((resolve,reject)=>held.set(id,{resolve,reject}));void wait.catch(()=>{});worker.postMessage({kind:'apply',id,value});return done;},held(id){const entry=held.get(id);assert.ok(entry);return new Promise((resolve,reject)=>{const before=entry.resolve;entry.resolve=()=>{before();resolve();};const failed=entry.reject;entry.reject=e=>{failed(e);reject(e);};});},release(id,fail){worker.postMessage({kind:'release',id,fail});}};
const proof=await runRouteSettlementCaller(target);assert.equal(proof.checks.length,9);assert.equal(proof.runtimeReturnedWork,0);assert.equal(proof.attempts.length,2);worker.postMessage({kind:'close'});await exited;assert.equal(exitCode,0);assert.equal(failure,undefined);assert.equal(closed.pending,0);assert.equal(closed.effects,1);assert.equal(closed.state,true);assert.ok(closed.messages<=16);settled=true;console.log(JSON.stringify({status:'pass',proof,native:{effects:closed.effects,state:closed.state,messages:closed.messages,workerExit:exitCode,workers:0,pending:pending.size,held:held.size},limits:{workers:1,messages:16,fixtureMs:15000},physicalEffects:false,nativeTeardownSeparateFromBarrier:true}));}
finally{clearTimeout(timer);if(!settled){void worker.terminate();await exited;}worker.removeAllListeners();assert.equal(pending.size,0);assert.equal(held.size,0);}`;
  const driverPath = join(scratch, 'driver.mjs'); writeFileSync(driverPath, driver);
  provenance = { schemaVersion: 1, mode: args[0] === '--installed' ? 'ordinary-installed-public-sdk' : 'explicit-source-built-public-packages',
    sourceTree, callerTree, ownedSha256: pins, sourceDependencySha256: dependencies, manifest: manifestPin, tarballSha256: tarballPins,
    installedFileSha256: installedBytes, caller: { path: caller, sha256: hash(bytes(caller)) }, compiledCaller: { path: join(scratch, 'compiled/settlement.js'), sha256: hash(bytes(join(scratch, 'compiled/settlement.js'))) },
    driver: { path: driverPath, sha256: hash(bytes(driverPath)) }, workerProgramSha256: hash(Buffer.from(workerCode)), compiler: { version: ts.version,
      path: realpathSync(join(root, 'node_modules/typescript/lib/typescript.js')), sha256: hash(bytes(realpathSync(join(root, 'node_modules/typescript/lib/typescript.js')), 16 * 1024 * 1024)) },
    compilerDeclarationSha256: declarationPins, publicResolutions, runtimeSourceAliases: false,
    sourceCompilerPublicPaths: args[0] === '--source' ? names.map(name => '@101/' + name) : [],
    qualification: 'owned Node software target and runtime returned apply work; no hardware or detached native quiescence' };
  writeFileSync(join(proofDirectory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  const child = spawnSync(process.execPath, [driverPath], { cwd: scratch, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  writeFileSync(join(proofDirectory, 'caller.stdout'), child.stdout ?? ''); writeFileSync(join(proofDirectory, 'caller.stderr'), child.stderr ?? '');
  writeFileSync(join(proofDirectory, 'child.json'), JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message,
    stdoutSha256: hash(Buffer.from(child.stdout ?? '')), stderrSha256: hash(Buffer.from(child.stderr ?? '')) }, null, 2) + '\n');
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, ''); const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'pass'); assert.equal(result.native.workers, 0); assert.equal(result.native.pending, 0); assert.equal(result.native.held, 0);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(bytes(join(root, path))), pin);
  for (const [path, pin] of Object.entries(dependencies)) assert.equal(hash(bytes(join(root, path))), pin);
  for (const [path, pin] of Object.entries(declarationPins)) assert.equal(hash(bytes(path)), pin);
  if (args[0] === '--installed') { assert.equal(hash(bytes(manifestPin.path)), manifestPin.sha256); checkInstalled(json(manifestPin.path)); }
  console.log(JSON.stringify({ status: 'pass', profile: 'runtime-route-settlement/1', provenance: { path: join(proofDirectory, 'provenance.json'), sha256: hash(bytes(join(proofDirectory, 'provenance.json'))) }, result,
    cleanup: { ownedWorkers: 0, pendingTargetRequests: 0, nativeDeviceCalls: 0 }, installed: args[0] === '--installed', qualification: provenance.qualification }));
} catch (error) {
  writeFileSync(join(proofDirectory, 'failure.json'), JSON.stringify({ status: 'failed', message: String(error), provenanceWritten: !!provenance, nativeCleanupQualified: false }, null, 2) + '\n');
  throw error;
}
