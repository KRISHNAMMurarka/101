import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/capability-inventory.ts', 'packages/device-runtime/src/capability-inventory.test.ts',
  'examples/device-profiles/live-inventory.mjs', 'tools/qa-capability-inventory.mjs'];
const assets = ['examples/device-profiles/node-memory-profile.ts', 'examples/device-profiles/node-memory-producer.mjs'];
const fingerprints = Object.fromEntries([...owned, ...assets].map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const argument = process.argv[2];
assert.ok(argument === '--source' && process.argv.length === 3 || argument === '--sdk-root' && process.argv.length === 4,
  'Use --source for an owned public source closure or --sdk-root <fresh installed consumer>');
let consumer, mode, sourceTree, compiledSource, immutableManifest;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path);
    assert.equal(entry.isSymbolicLink(), false, 'No source/consumer file may be a symlink');
    if (entry.isDirectory()) return files(path);
    assert.ok(entry.isFile()); return [path];
  });
}
if (argument === '--source') {
  mode = 'owned-public-source-closure';
  consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-capability-inventory-source-')));
  const compiled = join(consumer, '.compiled'), roots = names.map(name => join(root, `packages/${name}/src/index.ts`));
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: root, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(root, `packages/${name}/src/index.ts`)]])),
  });
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.every(source => names.some(name => source.fileName.startsWith(join(root, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
  compiledSource = Object.fromEntries(sources.map(source => [relative(root, source.fileName), hash(readFileSync(source.fileName))]));
  assert.equal(compiledSource['packages/device-runtime/src/capability-inventory.ts'], fingerprints[owned[0]]);
  for (const name of names) {
    const destination = join(consumer, 'node_modules', '@101', name), directory = join(compiled, `packages/${name}/src`);
    for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  }
  sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} else {
  mode = 'installed-immutable-public-sdk'; consumer = realpathSync(resolve(process.argv[3]));
  assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
  sourceTree = packed.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/);
  for (const path of [...owned, ...assets]) {
    const immutable = execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 });
    assert.equal(hash(immutable), fingerprints[path], `Caller bytes differ from immutable SDK source: ${path}`);
  }
  assert.equal(packed.source.sha256[owned[0]], fingerprints[owned[0]]);
  for (const path of ['packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/profile-connector.ts'])
    assert.equal(packed.source.sha256[path], hash(readFileSync(join(root, path))));
  const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, sourceTree);
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => `@101/${name}`).sort());
  for (const item of manifest.packages) {
    assert.ok(names.some(name => item.name === `@101/${name}`));
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const prefix = join(consumer, 'node_modules', item.name);
    assert.equal(realpathSync(prefix), prefix); assert.equal(lstatSync(prefix).isSymbolicLink(), false);
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep));
      assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile());
      assert.equal(hash(readFileSync(path)), file.sha256, `Installed bytes differ: ${item.name}/${file.path}`);
    }
  }
  immutableManifest = { path: packed.manifest.path, sha256: packed.manifest.sha256 };
}
const caller = join(consumer, 'capability-inventory-caller'); mkdirSync(caller);
copy(join(root, 'examples/device-profiles/node-memory-producer.mjs'), join(caller, 'node-memory-producer.mjs'));
const profile = ts.transpileModule(readFileSync(join(root, 'examples/device-profiles/node-memory-profile.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
}); assert.equal(profile.diagnostics?.length ?? 0, 0);
writeFileSync(join(caller, 'node-memory-profile.js'), profile.outputText);
const example = readFileSync(join(root, 'examples/device-profiles/live-inventory.mjs'), 'utf8').replace("'./node-memory-profile.ts'", "'./node-memory-profile.js'");
writeFileSync(join(caller, 'live-inventory.mjs'), example);
writeFileSync(join(caller, 'public-resolution.mjs'), `import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';
if(sdk.createCapabilityInventory!==runtime.createCapabilityInventory)throw Error('Public facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
function run(file, timeout = 8000) {
  const result = spawnSync(process.execPath, ['--no-experimental-strip-types', join(caller, file)], {
    cwd: consumer, env: environment, timeout, encoding: 'utf8', maxBuffer: 131072,
  });
  assert.equal(result.status, 0, `Actual public Node caller failed: ${result.error?.code ?? result.stderr.slice(0, 1600)}`);
  assert.equal(result.stderr, ''); return result.stdout;
}
const resolutions = run('public-resolution.mjs').trim().split('\n').map(line => JSON.parse(line));
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
const result = JSON.parse(run('live-inventory.mjs'));
assert.equal(result.kind, 'actual-node-rss-live-capability-inventory'); assert.equal(result.sourceSha256, fingerprints[assets[1]]);
assert.equal(result.scenarios.length, 2);
for (const scenario of result.scenarios) {
  assert.ok(scenario.samples.length === 2 && scenario.wireBytes <= 4096);
  assert.ok(Object.values(scenario.checks).every(value => value === true));
  assert.ok(scenario.steps.some(step => step.rows.some(row => row.state === 'supported')));
}
assert.deepEqual(result.scenarios.map(item => item.mode), ['quiet-expiry', 'child-loss']);
assert.ok(Object.values(result.checks).every(value => value === true));
const receipt = { schemaVersion: 1, result: 'pass', mode, createdAt: new Date().toISOString(), environment: { node: process.version, typescript: ts.version },
  baseOrPackedSource: sourceTree, sourceSha256: fingerprints, ...(compiledSource ? { compiledSourceSha256: compiledSource } : {}),
  ...(immutableManifest ? { immutableManifest } : {}), consumer, publicEsmResolutions: resolutions,
  callerSha256: Object.fromEntries(files(caller).map(file => [relative(caller, file), hash(readFileSync(file))])), proof: result,
  scope: 'Actual read/subscribe inventory for two selected resources of one reviewed Node profile using two genuine owned children. No physical/OS qualification, authentication, automatic resource grant, write/command qualification or general hardware compatibility.' };
const receiptPath = join(consumer, 'capability-inventory-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
