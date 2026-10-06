import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/workspace-administration.ts', 'packages/device-runtime/src/workspace-administration.test.ts',
  'examples/workspace-administration/consumer.mjs', 'tools/qa-workspace-administration.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const argument = process.argv[2];
assert.ok(argument === '--source' && process.argv.length === 3 || argument === '--sdk-root' &&
  (process.argv.length === 4 || process.argv.length === 6 && process.argv[4] === '--candidate-tree'),
  'Use --source or --sdk-root <installed consumer> [--candidate-tree <immutable caller tree>]');
const candidateTree = process.argv[5]; if (candidateTree !== undefined) assert.match(candidateTree, /^[0-9a-f]{40}$/);
let consumer, mode, sourceTree, callerTree, compiledSource, immutableManifest, installedBytes, dependencySourcePins;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) return files(path); assert.ok(entry.isFile()); return [path];
  });
}
if (argument === '--source') {
  mode = 'owned-public-source-closure'; consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-workspace-administration-source-')));
  const compiled = join(consumer, '.compiled');
  const program = ts.createProgram(names.map(name => join(root, `packages/${name}/src/index.ts`)), {
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
  sourceTree = packed.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/); callerTree = candidateTree ?? sourceTree;
  for (const path of owned) {
    const immutable = execFileSync('git', ['cat-file', 'blob', `${callerTree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 });
    assert.equal(hash(immutable), fingerprints[path], `Caller differs from immutable caller source: ${path}`);
  }
  const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, sourceTree);
  assert.deepEqual(manifest.source.sha256, packed.source.sha256); dependencySourcePins = manifest.source.sha256;
  assert.ok(Object.hasOwn(dependencySourcePins, 'packages/device-runtime/src/workspace-administration.ts'), 'Installed SDK lacks selected administration producer');
  assert.ok(Object.keys(dependencySourcePins).length > 0 && Object.keys(dependencySourcePins).length <= 512);
  for (const [path, sha256] of Object.entries(dependencySourcePins)) {
    assert.ok(typeof path === 'string' && resolve(root, path).startsWith(root + sep)); assert.match(sha256, /^[0-9a-f]{64}$/);
    for (const tree of new Set([sourceTree, callerTree])) {
      const immutable = execFileSync('git', ['cat-file', 'blob', `${tree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 });
      assert.equal(hash(immutable), sha256, `Dependency source differs from original SDK provenance: ${path}`);
    }
    assert.equal(hash(readFileSync(join(root, path))), sha256, `Current dependency source differs from installed SDK: ${path}`);
  }
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => `@101/${name}`).sort()); installedBytes = {};
  for (const item of manifest.packages) {
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
    for (const file of item.files) {
      const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile());
      assert.equal(hash(readFileSync(path)), file.sha256, `Installed SDK bytes differ: ${item.name}/${file.path}`); installedBytes[item.name + '/' + file.path] = file.sha256;
    }
  }
  immutableManifest = { path: packed.manifest.path, sha256: packed.manifest.sha256 };
}
const caller = mkdtempSync(join(consumer, 'workspace-administration-caller-'));
copy(join(root, 'examples/workspace-administration/consumer.mjs'), join(caller, 'consumer.mjs'));
writeFileSync(join(caller, 'public-resolution.mjs'), `import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';
import * as model from '@101/device-model';
if(sdk.createDeviceRuntime!==runtime.createDeviceRuntime||sdk.createWorkspaceAdministration!==runtime.createWorkspaceAdministration||typeof sdk.createWorkspaceAdministration!=='function'||sdk.parseDeviceDescriptor!==model.parseDeviceDescriptor)throw Error('Public facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
function run(name) {
  const output = spawnSync(process.execPath, ['--no-experimental-strip-types', join(caller, name)], {
    cwd: consumer, env: environment, timeout: 10000, encoding: 'utf8', maxBuffer: 131072,
  });
  assert.equal(output.status, 0, `Actual public workspace administration caller failed: ${output.error?.code ?? output.stderr.slice(0, 2400)}`);
  assert.equal(output.stderr, ''); return output.stdout;
}
const resolutions = run('public-resolution.mjs').trim().split('\n').map(line => JSON.parse(line));
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
const proof = JSON.parse(run('consumer.mjs')); assert.equal(proof.status, 'pass'); assert.equal(proof.profile, 'local-workspace-administration/1');
assert.equal(proof.checks.length, 26); assert.equal(proof.persistentAuthority, false); assert.equal(proof.transport, 'none');
for (const [path, fingerprint] of Object.entries(fingerprints)) assert.equal(hash(readFileSync(join(root, path))), fingerprint, `Source changed during proof: ${path}`);
for (const [path, fingerprint] of Object.entries(compiledSource ?? dependencySourcePins)) assert.equal(hash(readFileSync(join(root, path))), fingerprint, `Dependency changed during proof: ${path}`);
const receipt = { schemaVersion: 1, result: 'pass', createdAt: new Date().toISOString(), mode, ...(compiledSource ? { sourceBaseCommit: sourceTree } : { sourceOrPackedTree: sourceTree }),
  environment: { node: process.version, typescript: ts.version }, sourceSha256: fingerprints,
  ...(compiledSource ? { compiledSourceSha256: compiledSource } : {}),
  ...(immutableManifest ? { immutableManifest, installedBytesSha256: installedBytes, callerTree, dependencySourceSha256: dependencySourcePins } : {}),
  consumer, publicEsmResolutions: resolutions, callerSha256: Object.fromEntries(files(caller).map(file => [relative(caller, file), hash(readFileSync(file))])), proof,
  scope: 'Explicit ephemeral workspace creation, membership, delegated roles, sharing policy and complete audit. Exact current host actor approval and separate source/sink owner signals, real public runtime connection retirement and raw provider settlement. All host routes must use this controller; no accounts, durable team state, unmanaged-host isolation, physical device or transport-auth qualification.' };
const receiptPath = join(caller, 'receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
