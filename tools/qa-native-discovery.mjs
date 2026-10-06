import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/native-discovery.ts', 'packages/device-runtime/src/native-discovery.test.ts',
  'examples/native-discovery/macos-provider.c', 'examples/native-discovery/process-port.mjs', 'examples/native-discovery/consumer.mjs', 'tools/qa-native-discovery.mjs'];
const dependencies = ['packages/device-runtime/src/index.ts', 'packages/device-model/src/discovery.ts', 'packages/device-model/src/index.ts'];
const pins = Object.fromEntries([...owned, ...dependencies].map(path => [path, hash(readFileSync(join(root, path)))]));
const featureRed = process.argv.includes('--feature-red'); const args = process.argv.slice(2).filter(arg => arg !== '--feature-red');
assert.ok(args[0] === '--source' && args.length === 1 || args[0] === '--sdk-root' && args.length === 2);
assert.equal(process.platform, 'darwin', 'Actual native proof requires macOS; unsupported is not a passing native test');
let consumer, sourceTree, compiledSourceSha256, manifestPin;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) { return readdirSync(directory).sort().flatMap(name => { const path = join(directory, name), entry = lstatSync(path);
  assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) return files(path); assert.ok(entry.isFile()); return [path]; }); }
if (args[0] === '--source') {
  consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-native-discovery-source-')));
  let sourceRoot = root; sourceTree = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (featureRed) {
    // Immutable pre-feature public SDK closure. The actual new native producer
    // still runs before the missing owned-provider assertion is made.
    sourceRoot = join(consumer, '.old-source');
    for (const name of names) {
      const prefix = `packages/${name}/src/`, paths = execFileSync('git', ['ls-tree', '-r', '--name-only', sourceTree, '--', prefix], { cwd: root, encoding: 'utf8' }).trim().split('\n');
      assert.ok(paths.length > 0 && paths.length <= 1024);
      for (const path of paths) if (path.startsWith(prefix) && path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const destination = join(sourceRoot, path); mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`], { cwd: root, maxBuffer: 1048576 }));
      }
    }
  }
  const compiled = join(consumer, '.compiled'), program = ts.createProgram(names.map(name => join(sourceRoot, `packages/${name}/src/index.ts`)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true,
    types: [], skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: sourceRoot, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(sourceRoot, `packages/${name}/src/index.ts`)]])),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => sourceRoot, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
  assert.ok(sources.every(source => names.some(name => source.fileName.startsWith(join(sourceRoot, `packages/${name}/src`) + sep)) && !source.fileName.endsWith('.test.ts')));
  assert.equal(program.emit().emitSkipped, false); compiledSourceSha256 = Object.fromEntries(sources.map(source => [relative(sourceRoot, source.fileName), hash(readFileSync(source.fileName))]));
  if (!featureRed) assert.equal(compiledSourceSha256[owned[0]], pins[owned[0]]);
  for (const name of names) { const directory = join(compiled, `packages/${name}/src`), destination = join(consumer, 'node_modules', '@101', name);
    for (const file of files(directory)) copy(file, join(destination, 'dist', relative(directory, file)));
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `@101/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } } })); }
} else {
  assert.equal(featureRed, false); consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(receipt.status, 'pass'); sourceTree = receipt.source.tree; assert.match(sourceTree, /^[0-9a-f]{40}$/);
  for (const path of owned) assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${sourceTree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 })), pins[path]);
  for (const path of dependencies) assert.equal(receipt.source.sha256[path], pins[path]);
  assert.equal(receipt.source.sha256[owned[0]], pins[owned[0]]);
  const bytes = readFileSync(receipt.manifest.path); assert.equal(hash(bytes), receipt.manifest.sha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, sourceTree); assert.equal(manifest.packages.length, names.length);
  assert.equal(new Set(manifest.packages.map(item => item.name)).size, names.length);
  for (const name of names) {
    const item = manifest.packages.find(item => item.name === `@101/${name}`); assert.ok(item && Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
    const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
    for (const file of item.files) { const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path);
      assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), file.sha256); }
  }
  manifestPin = { path: receipt.manifest.path, sha256: receipt.manifest.sha256 };
}
const caller = join(consumer, 'native-discovery-caller'); mkdirSync(caller);
copy(join(root, owned[2]), join(caller, 'macos-provider.c')); copy(join(root, owned[3]), join(caller, 'process-port.mjs')); copy(join(root, owned[4]), join(caller, 'consumer.mjs'));
const executable = join(caller, 'macos-provider');
const compilerArgs = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', join(caller, 'macos-provider.c'), '-o', executable];
// Apple exports DNS-SD through the installed libSystem linkage; no extra library
// or package is installed. This is not Linux libdns_sd or LAN multicast proof.
const compiled = spawnSync('/usr/bin/clang', compilerArgs, { encoding: 'utf8', timeout: 10000 }); assert.equal(compiled.status, 0, compiled.stderr); assert.equal(compiled.stderr, '');
const executableSha256 = hash(readFileSync(executable));
const invalid = spawnSync(executable, ['browse', '_foreign._tcp', '0'], { encoding: 'utf8', timeout: 5000 });
assert.equal(invalid.status, 64, JSON.stringify({ signal: invalid.signal, error: invalid.error?.code, stderr: invalid.stderr })); assert.equal(invalid.stdout, '');
const env = { ...process.env, NATIVE_DISCOVERY_CALLER_CONFIG: JSON.stringify({ executable, sha256: executableSha256, featureRed }) }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
const result = spawnSync(process.execPath, ['--no-experimental-strip-types', join(caller, 'consumer.mjs')], {
  cwd: consumer, env, encoding: 'utf8', timeout: 20000, maxBuffer: 131072,
});
if (featureRed) { assert.notEqual(result.status, 0); console.error(result.stderr); console.error('Actual native producer / immutable old public SDK feature RED observed'); process.exitCode = 1; }
else {
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); const proof = JSON.parse(result.stdout);
  assert.equal(proof.kind, 'actual-macos-local-only-dns-sd'); assert.equal(proof.nativeOpened, proof.rawExited); assert.ok(proof.nativeFrames.some(event => event.type === 'resolved') && proof.nativeFrames.some(event => event.type === 'removed'));
  assert.ok(proof.cleanup.controllerClosed && proof.cleanup.noRawReservation);
  const receipt = { schemaVersion: 1, result: 'pass', mode: compiledSourceSha256 ? 'owned-public-source-closure' : 'installed-immutable-public-sdk',
    sourceTree, sourceSha256: pins, ...(compiledSourceSha256 ? { compiledSourceSha256 } : {}), ...(manifestPin ? { manifestPin } : {}), consumer,
    environment: { node: process.version, typescript: ts.version, nativeCompiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).trim() },
    native: { sourceSha256: hash(readFileSync(join(caller, 'macos-provider.c'))), executableSha256, compilerArgs, linkage: 'installed Apple libSystem DNS-SD',
      headerSha256: hash(readFileSync('/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/dns_sd.h')) },
    proof, scope: 'Actual macOS LocalOnly software DNS-SD provider and public Node SDK caller; no LAN multicast, phone, other platform, authenticated identity, inferred capability, automatic resource grant or general D04 qualification.' };
  const receiptPath = join(consumer, 'native-discovery-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ receiptPath, ...receipt }));
}
