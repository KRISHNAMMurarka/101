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
const rawArgs = process.argv.slice(2), featureRed = rawArgs.includes('--feature-red');
const ownedDirIndex = rawArgs.indexOf('--owned-dir'), selectedIndexArg = rawArgs.indexOf('--selected-interface-index');
const ownedOutput = ownedDirIndex >= 0 ? rawArgs[ownedDirIndex + 1] : undefined;
const selectedInterfaceIndex = selectedIndexArg >= 0 ? Number(rawArgs[selectedIndexArg + 1]) : undefined;
if (ownedDirIndex >= 0) rawArgs.splice(ownedDirIndex, 2);
const selectedPosition = rawArgs.indexOf('--selected-interface-index'); if (selectedPosition >= 0) rawArgs.splice(selectedPosition, 2);
const args = rawArgs.filter(arg => arg !== '--feature-red');
assert.ok(args[0] === '--source' && args.length === 1 || args[0] === '--sdk-root' && args.length === 2);
assert.ok(ownedOutput === undefined || args[0] === '--source');
if (selectedInterfaceIndex !== undefined) assert.ok(Number.isSafeInteger(selectedInterfaceIndex) && selectedInterfaceIndex > 0 && selectedInterfaceIndex < 0xfffffffb);
assert.ok(selectedInterfaceIndex === undefined || !featureRed);
assert.equal(process.platform, 'darwin', 'Actual native proof requires macOS; unsupported is not a passing native test');
let consumer, sourceTree, compiledSourceSha256, manifestPin;
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function files(directory) { return readdirSync(directory).sort().flatMap(name => { const path = join(directory, name), entry = lstatSync(path);
  assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) return files(path); assert.ok(entry.isFile()); return [path]; }); }
if (args[0] === '--source') {
  if (ownedOutput !== undefined) {
    const release = realpathSync(join(root, 'release')), directory = realpathSync(resolve(ownedOutput));
    assert.ok(directory.startsWith(release + sep) && lstatSync(directory).isDirectory(), 'Owned output must be a precreated directory inside release');
    consumer = join(directory, 'consumer'); mkdirSync(consumer); consumer = realpathSync(consumer);
  } else consumer = realpathSync(mkdtempSync(join(tmpdir(), '101-native-discovery-source-')));
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
const seamSource = `#include <dns_sd.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
char *seam_if_indextoname(unsigned int, char *);
DNSServiceErrorType seam_DNSServiceRegister(DNSServiceRef *, DNSServiceFlags, uint32_t, const char *, const char *, const char *, const char *, uint16_t, uint16_t, const void *, DNSServiceRegisterReply, void *);
DNSServiceErrorType seam_DNSServiceBrowse(DNSServiceRef *, DNSServiceFlags, uint32_t, const char *, const char *, DNSServiceBrowseReply, void *);
#define DNSServiceRegister seam_DNSServiceRegister
#define DNSServiceBrowse seam_DNSServiceBrowse
#define if_indextoname seam_if_indextoname
#define main provider_main
#include "macos-provider.c"
#undef main
#undef DNSServiceRegister
#undef DNSServiceBrowse
#undef if_indextoname
static unsigned seam_if_calls, seam_register_calls, seam_browse_calls;
static uint32_t seam_register_index, seam_browse_index;
char *seam_if_indextoname(unsigned int index, char *name) {
  (void)index; seam_if_calls++;
  const char *selected = getenv("D04_FAKE_IFNAME"); if (!selected) return NULL;
  size_t length = strlen(selected); if (length >= IF_NAMESIZE) return NULL;
  memcpy(name, selected, length + 1); return name;
}
DNSServiceErrorType seam_DNSServiceRegister(DNSServiceRef *ref, DNSServiceFlags flags, uint32_t index,
  const char *name, const char *type, const char *domain, const char *host, uint16_t port,
  uint16_t txt_length, const void *txt, DNSServiceRegisterReply callback, void *context) {
  (void)flags; (void)name; (void)type; (void)domain; (void)host; (void)port; (void)txt_length; (void)txt; (void)callback; (void)context;
  seam_register_calls++; seam_register_index = index; *ref = NULL; return kDNSServiceErr_NoError;
}
DNSServiceErrorType seam_DNSServiceBrowse(DNSServiceRef *ref, DNSServiceFlags flags, uint32_t index,
  const char *type, const char *domain, DNSServiceBrowseReply callback, void *context) {
  (void)flags; (void)type; (void)domain; (void)callback; (void)context;
  seam_browse_calls++; seam_browse_index = index; *ref = NULL; return kDNSServiceErr_NoError;
}
int main(int argc, char **argv) {
  int result = provider_main(argc, argv);
  fprintf(stderr, "SEAM ifIndexCalls=%u registerCalls=%u registerIndex=%u browseCalls=%u browseIndex=%u providerResult=%d\\n",
    seam_if_calls, seam_register_calls, seam_register_index, seam_browse_calls, seam_browse_index, result);
  return 0;
}
`;
const seamPath = join(caller, 'macos-provider-seam.c'), seamExecutable = join(caller, 'macos-provider-seam');
writeFileSync(seamPath, seamSource);
const seamCompilerArgs = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', caller, seamPath, '-o', seamExecutable];
const seamCompiled = spawnSync('/usr/bin/clang', seamCompilerArgs, { encoding: 'utf8', timeout: 10000 });
writeFileSync(join(caller, 'seam-compile.stdout'), seamCompiled.stdout ?? ''); writeFileSync(join(caller, 'seam-compile.stderr'), seamCompiled.stderr ?? '');
assert.equal(seamCompiled.status, 0, seamCompiled.stderr); assert.equal(seamCompiled.stderr, '');
const seamCases = [];
for (const [family, ifname] of [['awdl', 'awdl0'], ['llw', 'llw0'], ['p2p', 'p2p0']]) for (const operation of ['browse', 'register']) {
  seamCases.push({ name: family + '-' + operation, ifname, args: operation === 'browse' ? ['browse', '_seam._tcp', '1', '17'] :
    ['register', '_seam._tcp', 'seam-owned', '12345', '1', '17'], expected: { ifIndexCalls: 1, registerCalls: 0, browseCalls: 0, providerResult: 64 } });
}
for (const operation of ['browse', 'register']) seamCases.push({ name: 'ordinary-' + operation, ifname: 'en0',
  args: operation === 'browse' ? ['browse', '_seam._tcp', '1', String(selectedInterfaceIndex ?? 17)] :
    ['register', '_seam._tcp', 'seam-owned', '12345', '1', String(selectedInterfaceIndex ?? 17)],
  expected: { ifIndexCalls: 1, registerCalls: operation === 'register' ? 1 : 0, browseCalls: operation === 'browse' ? 1 : 0,
    [operation === 'register' ? 'registerIndex' : 'browseIndex']: selectedInterfaceIndex ?? 17, providerResult: 0 } });
for (const operation of ['browse', 'register']) seamCases.push({ name: 'local-only-' + operation,
  args: operation === 'browse' ? ['browse', '_seam._tcp', '1'] : ['register', '_seam._tcp', 'seam-owned', '12345', '1'],
  expected: { ifIndexCalls: 0, registerCalls: operation === 'register' ? 1 : 0, browseCalls: operation === 'browse' ? 1 : 0,
    [operation === 'register' ? 'registerIndex' : 'browseIndex']: 0xffffffff, providerResult: 0 } });
const seamResults = [];
for (const item of seamCases) {
  const env = { ...process.env }; delete env.D04_FAKE_IFNAME; if (item.ifname) env.D04_FAKE_IFNAME = item.ifname;
  const result = spawnSync(seamExecutable, item.args, { cwd: caller, env, encoding: 'utf8', timeout: 3000 });
  for (const [suffix, content] of [['stdout', result.stdout ?? ''], ['stderr', result.stderr ?? ''], ['exit', String(result.status ?? 'null') + '\n']])
    writeFileSync(join(caller, 'seam-' + item.name + '.' + suffix), content);
  writeFileSync(join(caller, 'seam-' + item.name + '.argv.json'), JSON.stringify({ argv: [seamExecutable, ...item.args], ifname: item.ifname ?? null, cwd: caller }, null, 2) + '\n');
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  const match = result.stderr.match(/^SEAM ifIndexCalls=(\d+) registerCalls=(\d+) registerIndex=(\d+) browseCalls=(\d+) browseIndex=(\d+) providerResult=(-?\d+)$/m);
  assert.ok(match, item.name); const observed = { ifIndexCalls: Number(match[1]), registerCalls: Number(match[2]), registerIndex: Number(match[3]),
    browseCalls: Number(match[4]), browseIndex: Number(match[5]), providerResult: Number(match[6]) };
  for (const [key, value] of Object.entries(item.expected)) assert.equal(observed[key], value, item.name + ': ' + key);
  seamResults.push({ name: item.name, args: item.args, ifname: item.ifname ?? null, observed });
}
writeFileSync(join(caller, 'seam-results.json'), JSON.stringify({ result: 'pass', cases: seamResults }, null, 2) + '\n');
const compilerArgs = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', join(caller, 'macos-provider.c'), '-o', executable];
// Apple exports DNS-SD through the installed libSystem linkage; no extra library
// or package is installed. This is not Linux libdns_sd or LAN multicast proof.
const compiled = spawnSync('/usr/bin/clang', compilerArgs, { encoding: 'utf8', timeout: 10000 }); assert.equal(compiled.status, 0, compiled.stderr); assert.equal(compiled.stderr, '');
const executableSha256 = hash(readFileSync(executable));
const invalid = spawnSync(executable, ['browse', '_foreign._tcp', '0'], { encoding: 'utf8', timeout: 5000 });
assert.equal(invalid.status, 64, JSON.stringify({ signal: invalid.signal, error: invalid.error?.code, stderr: invalid.stderr })); assert.equal(invalid.stdout, '');
const scenarios = featureRed ? [{ name: 'local-only', selected: false }] :
  [{ name: 'local-only', selected: false }, ...(selectedInterfaceIndex === undefined ? [] : [{ name: 'selected-interface', selected: true }])];
const proofs = [];
for (const scenario of scenarios) {
  const config = { executable, sha256: executableSha256, featureRed, ...(scenario.selected ? { selectedInterfaceIndex } : {}) };
  const env = { ...process.env, NATIVE_DISCOVERY_CALLER_CONFIG: JSON.stringify(config) }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const callerArgs = ['--no-experimental-strip-types', join(caller, 'consumer.mjs')];
  writeFileSync(join(caller, `${scenario.name}.command.json`), JSON.stringify({ executable: process.execPath, args: callerArgs, cwd: consumer, config }, null, 2) + '\n');
  const result = spawnSync(process.execPath, callerArgs, { cwd: consumer, env, encoding: 'utf8', timeout: 20000, maxBuffer: 131072 });
  writeFileSync(join(caller, `${scenario.name}.stdout`), result.stdout ?? ''); writeFileSync(join(caller, `${scenario.name}.stderr`), result.stderr ?? '');
  writeFileSync(join(caller, `${scenario.name}.exit`), `${result.status ?? 'null'}\n`);
  if (featureRed) { assert.notEqual(result.status, 0); console.error(result.stderr); console.error('Actual native producer / immutable old public SDK feature RED observed'); process.exitCode = 1; continue; }
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const proof = JSON.parse(result.stdout), expectedKind = scenario.selected ? 'actual-macos-selected-interface-dns-sd' : 'actual-macos-local-only-dns-sd';
  assert.equal(proof.kind, expectedKind); assert.equal(proof.nativeOpened, proof.rawExited);
  assert.ok(proof.nativeFrames.some(event => event.type === 'resolved') && proof.nativeFrames.some(event => event.type === 'removed'));
  assert.ok(Number.isSafeInteger(proof.consumerPid));
  assert.ok(proof.ownedProcesses.length > 0 && proof.ownedProcesses.every(child => Number.isSafeInteger(child.pid) && Array.isArray(child.argv) &&
    (Number.isInteger(child.exitCode) || typeof child.signal === 'string')));
  assert.ok(proof.cleanup.controllerClosed && proof.cleanup.noRawReservation && proof.cleanup.childrenJoined && proof.cleanup.loopbackListenerClosed);
  assert.equal(proof.cleanup.ownedChildCount, proof.ownedProcesses.length); proofs.push(proof);
}
if (!featureRed) {
  const receipt = { schemaVersion: 1, result: 'pass', mode: compiledSourceSha256 ? 'owned-public-source-closure' : 'installed-immutable-public-sdk',
    sourceTree, sourceSha256: pins, ...(compiledSourceSha256 ? { compiledSourceSha256 } : {}), ...(manifestPin ? { manifestPin } : {}), consumer,
    operatorSelectedInterfaceIndex: selectedInterfaceIndex ?? null,
    environment: { node: process.version, typescript: ts.version, nativeCompiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).trim() },
    native: { sourceSha256: hash(readFileSync(join(caller, 'macos-provider.c'))), executableSha256, compilerArgs, linkage: 'installed Apple libSystem DNS-SD',
      headerSha256: hash(readFileSync('/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include/dns_sd.h')) },
    cAdmissionSeam: { sourceSha256: hash(readFileSync(seamPath)), seamCompilerArgs, cases: seamResults },
    proofs, scope: 'Actual LocalOnly lifecycle plus, when explicitly requested, same-machine DNS-SD self-browse on the operator-selected interface. The selected profile does not prove remote reachability or on-wire multicast and does not close all D04 clauses.' };
  const receiptPath = join(consumer, 'native-discovery-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ receiptPath, ...receipt }));
}
