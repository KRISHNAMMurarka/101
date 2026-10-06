import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['examples/clipboard-resources/macos-pasteboard.swift', 'examples/clipboard-resources/process-port.mjs', 'examples/clipboard-resources/consumer.mjs',
  'packages/device-runtime/src/clipboard-resources.test.ts', 'tools/qa-clipboard-resources.mjs'];
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const argument = process.argv[2];
assert.ok(argument === '--source' && process.argv.length === 3 || argument === '--sdk-root' &&
  (process.argv.length === 4 || process.argv.length === 6 && process.argv[4] === '--candidate-tree'),
  'Use --source or --sdk-root <installed consumer> [--candidate-tree <immutable caller tree>]');
const candidateTree = process.argv[5]; if (candidateTree !== undefined) assert.match(candidateTree, /^[0-9a-f]{40}$/);
assert.equal(process.platform, 'darwin', 'Actual private AppKit proof requires macOS; no simulated clipboard positive');
let consumer, mode, sourceTree, callerTree, compiledSource, immutableManifest, installedBytes, dependencySourcePins;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) return files(path); assert.ok(entry.isFile()); return [path];
  });
}
if (argument === '--source') {
  mode = 'owned-public-source-closure'; consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-clipboard-resources-source-')));
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
  sourceTree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
} else {
  mode = 'installed-immutable-public-sdk'; consumer = realpathSync(resolve(process.argv[3]));
  assert.ok([...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])].some(directory => consumer.startsWith(join(directory, '101-sdk-consumer-'))));
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
const caller = mkdtempSync(join(consumer, 'clipboard-resources-caller-'));
for (const name of ['macos-pasteboard.swift', 'process-port.mjs', 'consumer.mjs']) copy(join(root, 'examples/clipboard-resources', name), join(caller, name));
const executable = join(caller, 'macos-pasteboard');
const compilerArgs = [join(caller, 'macos-pasteboard.swift'), '-o', executable];
const compiler = spawnSync('/usr/bin/swiftc', compilerArgs, { encoding: 'utf8', timeout: 30000, maxBuffer: 131072 });
assert.equal(compiler.status, 0, compiler.stderr); assert.equal(compiler.stderr, ''); chmodSync(executable, 0o700);
const compilerVersion = spawnSync('/usr/bin/swiftc', ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
assert.equal(compilerVersion.status, 0);
const executableSha256 = hash(readFileSync(executable));
writeFileSync(join(caller, 'caller-inputs.json'), JSON.stringify({ executableSha256, sourceSha256: {
  'macos-pasteboard.swift': fingerprints[owned[0]], 'process-port.mjs': fingerprints[owned[1]],
} }));
const negatives = [];
for (const [name, input] of [['name-substitution', '1\tGENERAL\n'], ['oversize', '1\tWRITE\t0\tabsent\t' + '00'.repeat(129) + '\n'],
  ['malformed-bytes', Buffer.from([255, 10])], ['partial-frame', '1\tREAD']]) {
  const started = performance.now();
  const result = spawnSync(executable, [], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  assert.equal(result.status, 64, JSON.stringify({ name, status: result.status, signal: result.signal,
    error: result.error?.code, elapsedMs: performance.now() - started, stdoutBytes: Buffer.byteLength(result.stdout ?? '') }));
  assert.equal(result.stderr, '');
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 2); assert.equal(frames[0].kind, 'ready'); assert.deepEqual(frames[1], { cleared: true, kind: 'closed', released: true, version: 1 });
  negatives.push({ name, exitCode: result.status, frames: frames.length, verifiedOwnedCleanup: true });
}
const substitute = spawnSync(executable, ['NSGeneralPboard'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
assert.equal(substitute.status, 64); assert.equal(substitute.stdout, ''); assert.equal(substitute.stderr, '');
negatives.push({ name: 'program-argument-substitution', exitCode: 64, frames: 0, noNativeBoardProvisioned: true });
writeFileSync(join(caller, 'public-resolution.mjs'), `import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';
import * as model from '@101/device-model';
if(sdk.createDeviceRuntime!==runtime.createDeviceRuntime||sdk.parseDeviceDescriptor!==model.parseDeviceDescriptor)throw Error('Public facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
function run(name) {
  const output = spawnSync(process.execPath, ['--no-experimental-strip-types', join(caller, name)], {
    cwd: consumer, env: environment, timeout: 20000, encoding: 'utf8', maxBuffer: 131072,
  });
  assert.equal(output.status, 0, `Actual private AppKit caller failed: ${output.error?.code ?? output.stderr.slice(0, 2400)}`);
  assert.equal(output.stderr, ''); return output.stdout;
}
const resolutions = run('public-resolution.mjs').trim().split('\n').map(line => JSON.parse(line));
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
const proof = JSON.parse(run('consumer.mjs')); assert.equal(proof.result, 'pass'); assert.equal(proof.kind, 'actual-macos-private-named-pasteboard');
assert.equal(proof.sessions.length, 2); assert.equal(proof.checks.length, 22);
assert.deepEqual(proof.cleanup, { nativeChildrenAlive: 0, operationTimers: 0, verifiedClearedReleasedBoards: 2 });
assert.equal(proof.nativeSourceSha256, fingerprints[owned[0]]); assert.equal(proof.nativeExecutableSha256, executableSha256);
for (const session of proof.sessions) {
  assert.equal(session.nativeStatus.rawPending, 0); assert.equal(session.nativeStatus.timerArmed, false);
  assert.equal(session.uncertainIssuedWrite.issuedEffect, true); assert.equal(session.uncertainIssuedWrite.acknowledgementReleased, false);
}
const receipt = { schemaVersion: 1, result: 'pass', createdAt: new Date().toISOString(), mode, sourceOrPackedTree: sourceTree,
  environment: { node: process.version, typescript: ts.version }, sourceSha256: fingerprints,
  ...(compiledSource ? { compiledSourceSha256: compiledSource } : {}),
  ...(immutableManifest ? { immutableManifest, installedBytesSha256: installedBytes, callerTree, dependencySourceSha256: dependencySourcePins } : {}),
  consumer, publicEsmResolutions: resolutions, callerSha256: Object.fromEntries(files(caller).map(file => [relative(caller, file), hash(readFileSync(file))])), proof, native: { sourceSha256: fingerprints[owned[0]], executableSha256, compilerArgs, compilerVersion: (compilerVersion.stderr + compilerVersion.stdout).trim(), negatives },
  scope: 'Actual AppKit read/write/clear on two sole-issued private named pasteboards through a source/binary-pinned native CLI and ordinary public Node SDK grants. Original native10s lifetime clears/releases its owned board; cancellation cannot undo issued native effects. No general/user clipboard, arbitrary names/programs, UI, application control, physical timing, remote or malicious-host isolation.' };
const receiptPath = join(caller, 'receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
