import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileHash, installedSdk, kotlinTools, ordinaryFiles } from './build-pointer-bindings.mjs';

export const WATCH_REPORT_BINDING_PATHS = Object.freeze([
  'bindings/watch-report/fixtures/watch-report-v1.json', 'examples/language-bindings/watch-report.mjs',
  'examples/language-bindings/WatchReportConsumer.swift', 'examples/language-bindings/WatchReportConsumer.kt',
  'tests/watch-report-bindings.test.ts', 'tools/qa-watch-report-bindings.mjs'
]);
const producerPaths = ['apps/watch-ios/Sources/One01WatchCore/WatchPayload.swift',
  'apps/watch-wear/app/src/main/java/com/oneohone/wear/WatchPayload.kt'];
const selectedSdkPaths = ['packages/device-model/src/watch-companion-report.ts', 'packages/device-runtime/src/watch-companion.ts'];
const root = resolve(import.meta.dirname, '..');

/** Asynchronous native launch; one process, fixed deadline and retained raw settlement per command. */
async function run(program, args, { input = '', cwd = root, limit = 131072, deadline = 30000, binary = false } = {}) {
  return await new Promise((accept, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let outBytes = 0, errBytes = 0, failure;
    const stop = reason => { failure ??= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new Error('Native command deadline exceeded')), deadline);
    child.stdout.on('data', bytes => { outBytes += bytes.byteLength; if (outBytes > limit) stop(new Error('Native stdout bound exceeded')); else stdout.push(bytes); });
    child.stderr.on('data', bytes => { errBytes += bytes.byteLength; if (errBytes > limit) stop(new Error('Native stderr bound exceeded')); else stderr.push(bytes); });
    child.on('error', error => { failure ??= error; }); child.stdin.on('error', error => { failure ??= error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        if (failure || code !== 0 || signal) reject(failure ?? new Error(`Native command failed: ${code}/${signal}: ${Buffer.concat(stderr).toString('utf8')}`));
        else accept(binary ? Buffer.concat(stdout) : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)));
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}
function safePath(path) {
  assert.ok(typeof path === 'string' && path.length <= 256 && !path.startsWith('/') &&
    !path.split('/').some(part => !part || part === '.' || part === '..'));
}
async function snapshot(tree, paths, destination) {
  assert.match(tree, /^[0-9a-f]{40}$/); assert.ok(paths.length <= 256); paths.forEach(safePath);
  mkdirSync(destination);
  const archive = await run('git', ['archive', '--format=tar', tree, '--', ...paths], { binary: true, limit: 8 * 1024 * 1024, deadline: 10000 });
  await run('tar', ['-xf', '-', '-C', destination], { input: archive, deadline: 10000 });
  for (const path of paths) assert.ok(lstatSync(join(destination, path)).isFile() && !lstatSync(join(destination, path)).isSymbolicLink());
}
function expected(source, entry) {
  const value = { ...source.baseMeaning, ...entry.changes };
  for (const key of ['orientationReported', 'accelerationG', 'rotationDegPerSecond']) value[key] = value[key].map(Math.fround);
  value.crownReported = Math.fround(value.crownReported); return value;
}
function materialize(source, entry) {
  const bytes = Buffer.from(source.baseHex, 'hex');
  for (const patch of entry.patches ?? []) Buffer.from(patch.hex, 'hex').copy(bytes, patch.offset);
  if (entry.length === undefined) return bytes;
  const resized = Buffer.alloc(entry.length); bytes.copy(resized, 0, 0, Math.min(bytes.length, resized.length)); return resized;
}
function encodeLine(meaning) {
  return ['E', meaning.sequence, meaning.relayEmissionMs, ...meaning.orientationReported, ...meaning.accelerationG,
    ...meaning.rotationDegPerSecond, meaning.crownReported, meaning.tap ? 1 : 0].join(' ');
}
function decodeLine(bytes) { return 'D ' + (bytes.byteLength ? bytes.toString('hex') : '-'); }

export async function qualifyWatchReportBindings(manifestPath, consumerPath, callerTree) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(process.version, 'v24.14.0');
  const sdk = installedSdk(consumerPath, manifestPath);
  assert.ok(sdk.directory.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  for (const record of sdk.manifest.packages) {
    const packageDirectory = join(sdk.directory, 'node_modules', ...record.name.split('/'));
    assert.deepEqual(ordinaryFiles(packageDirectory).map(path => path.slice(packageDirectory.length + 1).replaceAll(sep, '/')).sort(),
      record.files.map(file => file.path).sort(), 'Exact installed package file allowlist');
  }
  const receiptBytes = readFileSync(join(sdk.directory, 'receipt.json')); assert.ok(receiptBytes.byteLength <= 4 * 1024 * 1024);
  const receipt = JSON.parse(receiptBytes); assert.equal(receipt.status, 'pass');
  assert.equal(receipt.source.tree, sdk.manifest.source.tree); assert.equal(receipt.manifest.sha256, sdk.manifestSha256);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), '101-watch-contracts-')));
  const callerDirectory = mkdtempSync(join(sdk.directory, '.101-watch-contracts-'));
  const sourcePins = Object.fromEntries(WATCH_REPORT_BINDING_PATHS.map(path => [path, fileHash(join(root, path))]));
  const producerPins = Object.fromEntries(producerPaths.map(path => [path, fileHash(join(root, path))]));
  const helperPin = fileHash(join(root, 'tools/build-pointer-bindings.mjs'));
  try {
    const sdkSnapshot = join(temporary, 'sdk-source'), sdkPaths = Object.keys(sdk.manifest.source.sha256);
    await snapshot(sdk.manifest.source.tree, sdkPaths, sdkSnapshot);
    for (const path of sdkPaths) assert.equal(fileHash(join(sdkSnapshot, path)), sdk.manifest.source.sha256[path]);
    for (const path of selectedSdkPaths) assert.equal(fileHash(join(root, path)), sdk.manifest.source.sha256[path], 'Selected public runtime/model source changed');
    if (callerTree) {
      const candidate = join(temporary, 'candidate');
      await snapshot(callerTree, [...WATCH_REPORT_BINDING_PATHS, ...producerPaths, 'tools/build-pointer-bindings.mjs'], candidate);
      for (const [path, pin] of Object.entries({ ...sourcePins, ...producerPins, 'tools/build-pointer-bindings.mjs': helperPin }))
        assert.equal(fileHash(join(candidate, path)), pin, 'Caller/native/helper source differs from immutable candidate');
    }
    const fixturePath = join(callerDirectory, 'watch-report-v1.json'), callerPath = join(callerDirectory, 'watch-report.mjs');
    copyFileSync(join(root, WATCH_REPORT_BINDING_PATHS[0]), fixturePath); copyFileSync(join(root, WATCH_REPORT_BINDING_PATHS[1]), callerPath);
    const resolverPath = join(callerDirectory, 'resolve.mjs'); writeFileSync(resolverPath, 'console.log(import.meta.resolve("@101/connect"));\n');
    const resolution = fileURLToPath((await run(process.execPath, [resolverPath], { deadline: 5000 })).trim());
    assert.ok(resolution.startsWith(join(sdk.directory, 'node_modules/@101/connect') + sep));
    const js = JSON.parse(await run(process.execPath, [callerPath, '--fixtures', fixturePath]));
    const source = JSON.parse(readFileSync(fixturePath, 'utf8'));
    assert.ok(source.golden.length * 2 + source.decode.length <= source.limits.commands);
    const lines = [], expectations = [];
    for (const entry of source.golden) {
      const meaning = expected(source, entry), hex = materialize(source, entry).toString('hex');
      lines.push(encodeLine({ ...source.baseMeaning, ...entry.changes }), decodeLine(materialize(source, entry)));
      expectations.push({ hex, ...meaning }, { hex, ...meaning });
    }
    for (const entry of source.decode) {
      const bytes = materialize(source, entry); lines.push(decodeLine(bytes));
      if (!entry.accept.swift) expectations.push(null);
      else { bytes[52] &= 1; expectations.push({ hex: bytes.toString('hex'), ...expected(source, entry) }); }
    }
    assert.ok(lines.every(line => Buffer.byteLength(line) <= source.limits.lineBytes));
    const input = lines.join('\n') + '\n', kotlin = kotlinTools();
    const swiftVersion = (await run('/usr/bin/xcrun', ['swiftc', '--version'])).trim(); assert.match(swiftVersion, /Swift version 6\.3\.3/);
    const swift = join(temporary, 'swift-consumer');
    await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-parse-as-library',
      join(root, producerPaths[0]), join(root, WATCH_REPORT_BINDING_PATHS[2]), '-o', swift]);
    const jar = join(temporary, 'kotlin-consumer.jar');
    kotlin.compile(['-Werror', '-jvm-target', '17', '-classpath', kotlin.stdlib + ':' + kotlin.annotations, '-d', jar,
      join(root, producerPaths[1]), join(root, WATCH_REPORT_BINDING_PATHS[3])]);
    const javaRelease = readFileSync(realpathSync(join(dirname(kotlin.java), '..', 'release')), 'utf8');
    assert.match(javaRelease, /JAVA_VERSION="21\.0\.12"/);
    const nativeResults = [];
    for (const [language, executable, args] of [['swift', swift, []], ['kotlin', kotlin.java, ['-cp', jar + ':' + kotlin.stdlib, 'WatchReportConsumerKt']]]) {
      const output = (await run(executable, args, { input })).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(output, expectations, language + ': exact native bytes and decoded meaning from every shared case');
      const goldenOutput = source.golden.map((entry, index) => ({ id: entry.id, ...output[index * 2] }));
      const before = goldenOutput.find(entry => entry.id === 'sequence-wrap-before').hex, after = goldenOutput.find(entry => entry.id === 'sequence-wrap-zero').hex;
      const host = JSON.parse(await run(process.execPath, [callerPath, '--host-proof', before, after])); assert.equal(host.checks.length, 16);
      nativeResults.push({ language, commands: lines.length, golden: source.golden.length, decode: source.decode.length,
        reservedBitDifference: js.incompatibilities, executableSha256: fileHash(language === 'swift' ? swift : jar), host });
    }
    for (const [path, pin] of Object.entries({ ...sourcePins, ...producerPins, 'tools/build-pointer-bindings.mjs': helperPin })) assert.equal(fileHash(join(root, path)), pin);
    return { status: 'pass', contract: source.contract, node: process.version, callerTree: callerTree ?? 'worker-source-files-sha256', sourceSha256: sourcePins,
      unchangedNativeProducerSha256: producerPins, helperSha256: helperPin, sdk: { sourceTree: sdk.manifest.source.tree, manifestSha256: sdk.manifestSha256,
        sourcePins: sdkPaths.length, installedFiles: sdk.manifest.packages.reduce((sum, item) => sum + item.files.length, 0), publicResolution: resolution },
      javascript: js, native: nativeResults, toolchains: { swift: swiftVersion, kotlin: '2.1.21', kotlinCompilerSha256: kotlin.compilerSha256,
        jvmTarget: 17, qualifiedRuntime: 'JDK21.0.12' }, limits: source.limits,
      exclusions: ['watch/C unsupported', 'new native codec/library/distribution', 'native OS delivery', 'physical readings', 'capture freshness/clock mapping',
        'watch identity/transport authentication', 'phones', 'general portable schema coverage', 'full Q02/E12 completion'],
      cleanup: { ownedChildren: 0, ownedTemporaryDirectories: 0, ownedCallerDirectories: 0 } };
  } finally { rmSync(callerDirectory, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args[0] === '--installed' && (args.length === 3 || args.length === 5 && args[3] === '--caller-tree'),
    'Use --installed <SDK manifest> <clean consumer> [--caller-tree <immutable tree>]');
  console.log(JSON.stringify(await qualifyWatchReportBindings(args[1], args[2], args[4]), null, 2));
}
