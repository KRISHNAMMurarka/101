import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, fileHash, installedSdk, ordinaryFiles, sha256, withPublicCaller } from './build-pointer-bindings.mjs';

const base = 'bindings/structured-telemetry';
export const STRUCTURED_BINDING_PATHS = Object.freeze([
  `${base}/profile.json`, `${base}/fixtures/page-readings-v1.json`, `${base}/fixtures/structured-telemetry-v1.json`,
  `${base}/swift/Package.swift`, `${base}/swift/Sources/One01StructuredTelemetryWire/StructuredTelemetryWire.swift`,
  `${base}/swift/Tests/One01StructuredTelemetryWireTests/StructuredTelemetryWireTests.swift`,
  'examples/language-bindings/StructuredTelemetryConsumer.swift', 'examples/language-bindings/structured-telemetry.mjs',
  'tests/structured-telemetry-bindings.test.ts', 'tools/build-structured-telemetry-bindings.mjs',
]);
const producerPaths = ['packages/device-web/src/wire.ts', 'packages/device-model/src/sample.ts', 'packages/device-model/src/descriptor.ts'];
const root = resolve(import.meta.dirname, '..');
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function json(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function encodeLine(packet) {
  const rows = Array.isArray(packet.value) ? packet.value : [packet.value];
  const shape = Array.isArray(packet.value) ? `T ${rows.length}` : 'R';
  const values = rows.flatMap(row => [row.step, row.mode, row.ready === undefined ? '-' : row.ready ? '1' : '0']);
  return `E ${packet.epoch} ${packet.slot} ${packet.sequence} ${packet.capturedAt} ${shape} ${values.join(' ')}`;
}

export function buildStructuredTelemetryBindings(reference, sdkRoot, sdkManifest) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.match(reference, /^[a-f0-9]{40}$/);
  const tree = command('git', ['rev-parse', '--verify', `${reference}^{tree}`], { cwd: root }).trim();
  const sdk = installedSdk(sdkRoot, sdkManifest), producerSha256 = {};
  for (const path of producerPaths) {
    producerSha256[path] = sha256(execFileSync('git', ['show', `${tree}:${path}`], { cwd: root }));
    assert.equal(producerSha256[path], sdk.manifest.source.sha256[path]);
  }
  const output = mkdtempSync(join(root, 'release/structured-telemetry-'));
  const snapshot = join(output, 'source'), work = join(output, 'work'), artifact = join(output, 'swift');
  mkdirSync(snapshot); mkdirSync(work); mkdirSync(artifact);
  const sourceSha256 = {}, operations = [];
  function run(name, program, args, options = {}) {
    const { expectedExit = 0, ...childOptions } = options;
    const stdout = join(work, `${name}.stdout`), stderr = join(work, `${name}.stderr`);
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000,
      maxBuffer: 1048576, cwd: work, ...childOptions });
    writeFileSync(stdout, result.stdout ?? '', { flag: 'wx' }); writeFileSync(stderr, result.stderr ?? '', { flag: 'wx' });
    operations.push({ name, command: [program, ...args], exitCode: result.status,
      expectedExit, signal: result.signal, stdout: { path: stdout, sha256: fileHash(stdout) }, stderr: { path: stderr, sha256: fileHash(stderr) } });
    assert.ok(!result.error && !result.signal && result.status === expectedExit, `Owned ${name} command failed; retained both outputs`);
    return result.stdout;
  }
  try {
    for (const path of [...STRUCTURED_BINDING_PATHS, 'LICENSE', 'tools/build-pointer-bindings.mjs']) {
      const bytes = execFileSync('git', ['show', `${tree}:${path}`], { cwd: root, maxBuffer: 1048576 });
      const target = join(snapshot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
      sourceSha256[path] = sha256(bytes);
    }
    assert.equal(fileHash(fileURLToPath(import.meta.url)), sourceSha256['tools/build-structured-telemetry-bindings.mjs']);
    assert.equal(fileHash(join(root, 'tools/build-pointer-bindings.mjs')), sourceSha256['tools/build-pointer-bindings.mjs']);
    const schemaPath = join(snapshot, `${base}/fixtures/page-readings-v1.json`);
    const fixturePath = join(snapshot, `${base}/fixtures/structured-telemetry-v1.json`);
    const fixtures = JSON.parse(readFileSync(fixturePath)), profile = JSON.parse(readFileSync(join(snapshot, `${base}/profile.json`)));
    assert.equal(profile.profile, 'structured-telemetry-json2/1'); assert.equal(profile.authority, 'inert-codec-only');
    assert.equal(fixtures.positive.length, 5);
    const regenerate = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, caller) =>
      JSON.parse(run('actual-sdk-producer', process.execPath, [caller, '--schema', schemaPath])));
    assert.deepEqual(regenerate, fixtures, 'Committed fixtures must equal actual ordinary public SDK producers');
    for (const path of STRUCTURED_BINDING_PATHS.filter(path => path.startsWith(`${base}/swift/`)))
      copy(join(snapshot, path), join(artifact, 'source', path.slice(`${base}/swift/`.length)));
    for (const [from, to] of [['LICENSE', 'LICENSE'], [`${base}/profile.json`, 'assets/profile.json'],
      [`${base}/fixtures/page-readings-v1.json`, 'assets/page-readings-v1.json'],
      [`${base}/fixtures/structured-telemetry-v1.json`, 'assets/structured-telemetry-v1.json'],
      ['examples/language-bindings/StructuredTelemetryConsumer.swift', 'examples/StructuredTelemetryConsumer.swift'],
      ['examples/language-bindings/structured-telemetry.mjs', 'examples/structured-telemetry.mjs']]) copy(join(snapshot, from), join(artifact, to));
    mkdirSync(join(artifact, 'lib'));
    const toolchain = run('toolchain', '/usr/bin/xcrun', ['swiftc', '--version']).trim();
    assert.match(toolchain, /Swift version 6\.3\.3/);
    run('module', '/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors',
      '-emit-library', '-emit-module', '-avoid-emit-module-source-info', '-file-prefix-map', `${root}=/one01-native`,
      '-debug-prefix-map', `${root}=/one01-native`, '-prefix-serialized-debugging-options',
      '-module-name', 'One01StructuredTelemetryWire', '-emit-module-path', join(artifact, 'lib/One01StructuredTelemetryWire.swiftmodule'),
      '-module-cache-path', join(work, 'module-cache'), '-Xlinker', '-install_name', '-Xlinker', '@rpath/libOne01StructuredTelemetryWire.dylib',
      join(artifact, 'source/Sources/One01StructuredTelemetryWire/StructuredTelemetryWire.swift'),
      '-o', join(artifact, 'lib/libOne01StructuredTelemetryWire.dylib')]);
    const tests = run('swift-tests', '/usr/bin/xcrun', ['swift', 'test', '--package-path', join(artifact, 'source'),
      '--scratch-path', join(work, 'swift-tests'), '--cache-path', join(work, 'swift-cache'), '--disable-sandbox', '--skip-update'],
    { env: { ...process.env, ONE01_STRUCTURED_FIXTURES: fixturePath } });
    assert.match(tests + readFileSync(join(work, 'swift-tests.stderr'), 'utf8'), /Test run with 7 tests.*passed/);
    const consumer = join(work, 'consumer');
    run('ordinary-caller-compile', '/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '6',
      '-strict-concurrency=complete', '-warnings-as-errors', '-I', join(artifact, 'lib'), '-L', join(artifact, 'lib'),
      '-lOne01StructuredTelemetryWire', '-Xlinker', '-rpath', '-Xlinker', join(artifact, 'lib'),
      '-module-cache-path', join(work, 'module-cache'), join(artifact, 'examples/StructuredTelemetryConsumer.swift'), '-o', consumer]);
    const lines = fixtures.positive.flatMap(entry => [`D disposable ${entry.hex}`, encodeLine(entry.meaning)]);
    const input = lines.join('\n') + '\n'; writeFileSync(join(work, 'input.txt'), input);
    const native = run('reciprocal-native', consumer, [], { input });
    const nativeOutput = join(work, 'reciprocal-native.stdout');
    assert.equal(native.trim().split('\n').length, 10);
    const reciprocal = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, caller) =>
      JSON.parse(run('actual-sdk-reciprocal', process.execPath, [caller, '--schema', schemaPath, '--verify-native', nativeOutput])));
    assert.equal(reciprocal.result, 'pass');
    const negative = run('wrong-lane', consumer, [], { input: `D reliable ${fixtures.positive[0].hex}\n` });
    assert.equal(negative, 'null\n');
    assert.equal(run('command-boundary', consumer, [], { input: 'invalid\n'.repeat(128) }), 'null\n'.repeat(128));
    assert.equal(run('command-overflow', consumer, [], { input: 'invalid\n'.repeat(129), expectedExit: 2 }), 'null\n'.repeat(128));
    assert.equal(run('line-boundary', consumer, [], { input: 'x'.repeat(16384) + '\n' }), 'null\n');
    assert.equal(run('line-overflow', consumer, [], { input: 'x'.repeat(16385) + '\n', expectedExit: 2 }), '');
    assert.equal(run('unterminated-line', consumer, [], { input: lines[0], expectedExit: 2 }), '');
    const limited = run('total-input-overflow', consumer, [], { input: ('x'.repeat(16384) + '\n').repeat(65), expectedExit: 2 });
    assert.equal(limited, 'null\n'.repeat(63));
    const files = ordinaryFiles(artifact).map(path => ({ path: path.slice(artifact.length + 1), bytes: readFileSync(path).length, sha256: fileHash(path) }));
    assert.ok(files.length <= 32);
    const tarball = join(output, 'one01-structured-telemetry-swift-1.0.0.tgz');
    run('local-package', 'tar', ['--format=ustar', '-czf', tarball, '-C', artifact, '.'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const manifest = { schemaVersion: 1, result: 'pass', profile: profile.profile, source: { tree, sha256: sourceSha256 },
      sdk: { manifestSha256: sdk.manifestSha256, selectedProducerSha256: producerSha256 }, toolchain,
      target: 'swift-macos-arm64', authority: profile.authority, exclusions: profile.excluded,
      swiftTests: 7, reciprocal, wrongLaneRejected: true, cliFramingChecks: 6, files,
      tarball: { path: tarball, sha256: fileHash(tarball) }, operations };
    const manifestPath = join(output, 'manifest.json'); json(manifestPath, manifest);
    return { manifest: manifestPath, ...manifest };
  } catch (cause) {
    json(join(output, 'failure.json'), { schemaVersion: 1, result: 'fail', tree, sourceSha256, operations });
    throw cause;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 5 && args[1] === '--sdk-root' && args[3] === '--sdk-manifest');
  assert.ok(existsSync(join(root, 'release')));
  console.log(JSON.stringify(buildStructuredTelemetryBindings(args[0], args[2], args[4]), null, 2));
}
