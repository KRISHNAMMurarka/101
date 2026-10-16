import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, fileHash, installedSdk, kotlinTools, ordinaryFiles, sha256, withPublicCaller } from './build-pointer-bindings.mjs';

const root = resolve(import.meta.dirname, '..'), base = 'bindings/structured-telemetry';
export const KOTLIN_STRUCTURED_BINDING_PATHS = Object.freeze([
  `${base}/kotlin/profile.json`,
  `${base}/kotlin/src/main/kotlin/one01/structuredtelemetry/StructuredTelemetryWire.kt`,
  `${base}/kotlin/src/test/kotlin/one01/structuredtelemetry/StructuredTelemetryWireTests.kt`,
  'examples/language-bindings/StructuredTelemetryConsumer.kt', 'tools/build-structured-telemetry-kotlin.mjs',
]);
const sharedPaths = [`${base}/fixtures/page-readings-v1.json`, `${base}/fixtures/structured-telemetry-v1.json`,
  `${base}/fixtures/structured-telemetry-negative-v1.json`,
  'examples/language-bindings/structured-telemetry.mjs', 'tools/build-pointer-bindings.mjs', 'LICENSE'];
const producerPaths = ['packages/device-web/src/wire.ts', 'packages/device-model/src/sample.ts', 'packages/device-model/src/descriptor.ts'];
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function json(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function cachedJar(coordinate, expected) {
  const [group, name, version] = coordinate.split(':');
  assert.ok(group && name && version && coordinate.split(':').length === 3);
  const directory = join(homedir(), '.gradle/caches/modules-2/files-2.1', group, name, version);
  assert.ok(existsSync(directory), 'Declared installed dependency is required; no download is attempted');
  const jars = readdirSync(directory).flatMap(hash => readdirSync(join(directory, hash))
    .filter(file => file === `${name}-${version}.jar`).map(file => join(directory, hash, file)));
  assert.equal(jars.length, 1); assert.equal(fileHash(jars[0]), expected); return jars[0];
}
function encodingLine(packet) {
  const rows = Array.isArray(packet.value) ? packet.value : [packet.value];
  const shape = Array.isArray(packet.value) ? `T ${rows.length}` : 'R';
  return `E ${packet.epoch} ${packet.slot} ${packet.sequence} ${packet.capturedAt} ${shape} ` +
    rows.flatMap(row => [row.step, row.mode, row.ready === undefined ? '-' : row.ready ? '1' : '0']).join(' ');
}

export function buildStructuredTelemetryKotlin(reference, sdkRoot, sdkManifest) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.match(reference, /^[a-f0-9]{40}$/);
  const tree = command('git', ['rev-parse', '--verify', `${reference}^{tree}`], { cwd: root }).trim();
  const sdk = installedSdk(sdkRoot, sdkManifest), selectedProducerSha256 = {};
  for (const path of producerPaths) {
    selectedProducerSha256[path] = sha256(execFileSync('git', ['show', `${tree}:${path}`], { cwd: root }));
    assert.equal(selectedProducerSha256[path], sdk.manifest.source.sha256[path]);
  }
  const output = mkdtempSync(join(root, 'release/structured-kotlin-')), snapshot = join(output, 'source'),
    work = join(output, 'work'), artifact = join(output, 'kotlin');
  for (const path of [snapshot, work, artifact]) mkdirSync(path);
  const sourceSha256 = {}, operations = [];
  function run(name, program, args, options = {}) {
    const { expectedExit = 0, ...childOptions } = options;
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, cwd: work, ...childOptions });
    const stdout = join(work, `${name}.stdout`), stderr = join(work, `${name}.stderr`);
    writeFileSync(stdout, result.stdout ?? '', { flag: 'wx' }); writeFileSync(stderr, result.stderr ?? '', { flag: 'wx' });
    operations.push({ name, command: [program, ...args], exitCode: result.status, expectedExit, signal: result.signal,
      stdout: { path: stdout, sha256: fileHash(stdout) }, stderr: { path: stderr, sha256: fileHash(stderr) } });
    assert.ok(!result.error && !result.signal && result.status === expectedExit, `Owned ${name} failed; outputs retained`);
    return result.stdout;
  }
  function compile(name, args, kotlin) {
    let stdout = '', stderr = '', exitCode = 0;
    try { stdout = kotlin.compile(args); } catch (error) {
      stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; exitCode = error.status ?? null;
    }
    const out = join(work, `${name}.stdout`), err = join(work, `${name}.stderr`);
    writeFileSync(out, stdout, { flag: 'wx' }); writeFileSync(err, stderr, { flag: 'wx' });
    operations.push({ name, call: { helper: 'kotlinTools.compile', args, java: kotlin.java, compilerSha256: kotlin.compilerSha256 },
      exitCode, stdout: { path: out, sha256: fileHash(out) }, stderr: { path: err, sha256: fileHash(err) } });
    assert.equal(exitCode, 0, `Owned ${name} compiler failed; outputs retained`);
  }
  try {
    for (const path of [...KOTLIN_STRUCTURED_BINDING_PATHS, ...sharedPaths]) {
      const bytes = execFileSync('git', ['show', `${tree}:${path}`], { cwd: root, maxBuffer: 1048576 });
      const target = join(snapshot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
      sourceSha256[path] = sha256(bytes);
    }
    assert.equal(fileHash(fileURLToPath(import.meta.url)), sourceSha256['tools/build-structured-telemetry-kotlin.mjs']);
    assert.equal(fileHash(join(root, 'tools/build-pointer-bindings.mjs')), sourceSha256['tools/build-pointer-bindings.mjs']);
    const profile = JSON.parse(readFileSync(join(snapshot, KOTLIN_STRUCTURED_BINDING_PATHS[0])));
    assert.equal(profile.artifactProfile, 'structured-telemetry-kotlin-jvm/1');
    assert.equal(profile.profile, 'structured-telemetry-json2/1'); assert.equal(profile.authority, 'inert-codec-only');
    assert.equal(profile.bytecodeJvm, 17); assert.equal(profile.qualifiedRuntime.jdk, '21.0.12');
    const kotlin = kotlinTools(), gson = cachedJar(profile.runtimeDependencies.gson.coordinate, profile.runtimeDependencies.gson.sha256),
      annotations = cachedJar(profile.compileDependency.coordinate, profile.compileDependency.sha256);
    assert.equal(kotlin.stdlibSha256, profile.runtimeDependencies.stdlib.sha256);
    const release = readFileSync(join(dirname(kotlin.java), '..', 'release'), 'utf8');
    assert.match(release, /JAVA_VERSION="21\.0\.12"/); assert.match(release, /OS_NAME="Darwin"/); assert.match(release, /OS_ARCH="aarch64"/);
    for (const [index, metadata] of profile.runtimeDependencies.gson.metadata.entries()) {
      const bytes = run(`gson-metadata-${index}`, '/usr/bin/unzip', ['-p', gson, metadata.entry]);
      assert.equal(sha256(Buffer.from(bytes)), metadata.sha256);
    }
    const schemaPath = join(snapshot, `${base}/fixtures/page-readings-v1.json`),
      fixturePath = join(snapshot, `${base}/fixtures/structured-telemetry-v1.json`),
      negativeFixturePath = join(snapshot, `${base}/fixtures/structured-telemetry-negative-v1.json`),
      fixtures = JSON.parse(readFileSync(fixturePath));
    const actual = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, caller) =>
      JSON.parse(run('actual-sdk-producer', process.execPath, [caller, '--schema', schemaPath])));
    assert.deepEqual(actual, fixtures); assert.equal(fixtures.positive.length, 5);
    for (const [from, to] of [['LICENSE', 'LICENSE'], [KOTLIN_STRUCTURED_BINDING_PATHS[0], 'assets/profile.json'],
      [`${base}/fixtures/page-readings-v1.json`, 'assets/page-readings-v1.json'],
      [`${base}/fixtures/structured-telemetry-v1.json`, 'assets/structured-telemetry-v1.json'],
      [`${base}/fixtures/structured-telemetry-negative-v1.json`, 'assets/structured-telemetry-negative-v1.json'],
      [KOTLIN_STRUCTURED_BINDING_PATHS[1], 'source/StructuredTelemetryWire.kt'],
      [KOTLIN_STRUCTURED_BINDING_PATHS[2], 'source/StructuredTelemetryWireTests.kt'],
      ['examples/language-bindings/StructuredTelemetryConsumer.kt', 'examples/StructuredTelemetryConsumer.kt'],
      ['examples/language-bindings/structured-telemetry.mjs', 'examples/structured-telemetry.mjs']]) copy(join(snapshot, from), join(artifact, to));
    mkdirSync(join(artifact, 'lib'));
    const library = join(artifact, 'lib/one01-structured-telemetry.jar'), classpath = [kotlin.stdlib, kotlin.annotations, gson, annotations].join(':'),
      callerSource = join(artifact, 'examples/StructuredTelemetryConsumer.kt');
    compile('library', ['-Werror', '-jvm-target', '17', '-classpath', classpath, '-d', library,
      join(artifact, 'source/StructuredTelemetryWire.kt')], kotlin);
    const checks = join(work, 'checks.jar');
    compile('checks', ['-Werror', '-jvm-target', '17', '-classpath', [library, classpath].join(':'), '-d', checks,
      join(artifact, 'source/StructuredTelemetryWireTests.kt'), callerSource], kotlin);
    const tested = run('kotlin-checks', kotlin.java, ['-cp', [checks, library, kotlin.stdlib, gson].join(':'),
      'one01.structuredtelemetry.StructuredTelemetryWireTests'], { env: { ...process.env,
      ONE01_STRUCTURED_FIXTURES: fixturePath, ONE01_STRUCTURED_NEGATIVE_FIXTURES: negativeFixturePath } });
    const count = /^structured-telemetry Kotlin checks: (\d+)\n$/.exec(tested); assert.ok(count);
    const assertions = Number(count[1]); assert.ok(assertions >= 100 && assertions <= 256);
    const caller = join(work, 'caller.jar');
    compile('ordinary-caller', ['-Werror', '-jvm-target', '17', '-classpath', [library, classpath].join(':'), '-d', caller, callerSource], kotlin);
    const args = ['-cp', [caller, library, kotlin.stdlib, gson].join(':'), 'one01.structuredtelemetry.StructuredTelemetryConsumer'],
      lines = fixtures.positive.flatMap(entry => [`D disposable ${entry.hex}`, encodingLine(entry.meaning)]), input = lines.join('\n') + '\n';
    writeFileSync(join(work, 'input.txt'), input);
    run('reciprocal-native', kotlin.java, args, { input });
    const reciprocal = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, script) =>
      JSON.parse(run('actual-sdk-reciprocal', process.execPath, [script, '--schema', schemaPath, '--verify-native', join(work, 'reciprocal-native.stdout')])));
    assert.equal(reciprocal.result, 'pass');
    assert.equal(run('wrong-lane', kotlin.java, args, { input: `D reliable ${fixtures.positive[0].hex}\n` }), 'null\n');
    assert.equal(run('command-boundary', kotlin.java, args, { input: 'invalid\n'.repeat(128) }), 'null\n'.repeat(128));
    assert.equal(run('command-overflow', kotlin.java, args, { input: 'invalid\n'.repeat(129), expectedExit: 2 }), 'null\n'.repeat(128));
    assert.equal(run('line-boundary', kotlin.java, args, { input: 'x'.repeat(16384) + '\n' }), 'null\n');
    assert.equal(run('line-overflow', kotlin.java, args, { input: 'x'.repeat(16385) + '\n', expectedExit: 2 }), '');
    assert.equal(run('unterminated-line', kotlin.java, args, { input: lines[0], expectedExit: 2 }), '');
    assert.equal(run('total-input-overflow', kotlin.java, args, { input: ('x'.repeat(16384) + '\n').repeat(65), expectedExit: 2 }), 'null\n'.repeat(63));
    const files = ordinaryFiles(artifact).map(path => ({ path: path.slice(artifact.length + 1), bytes: readFileSync(path).length, sha256: fileHash(path) }));
    assert.equal(files.length, 10, 'Thin module and declared source/assets only; external dependency jars are not packaged');
    const tarball = join(output, 'one01-structured-telemetry-kotlin-1.0.0.tgz');
    run('local-package', 'tar', ['--format=ustar', '-czf', tarball, '-C', artifact, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const manifest = { schemaVersion: 1, result: 'pass', profile: profile.profile, artifactProfile: profile.artifactProfile,
      source: { tree, sha256: sourceSha256 }, sdk: { manifestSha256: sdk.manifestSha256, selectedProducerSha256 },
      toolchain: { kotlin: '2.1.21', compilerSha256: kotlin.compilerSha256, stdlibSha256: kotlin.stdlibSha256, javaReleaseSha256: sha256(Buffer.from(release)), jdk: '21.0.12', jvmTarget: 17 },
      runtimeDependencies: profile.runtimeDependencies, compileDependency: profile.compileDependency, dependencyJarsPackaged: false,
      target: profile.declaredTarget, authority: profile.authority, exclusions: profile.excluded,
      nativeAssertions: assertions, reciprocal, wrongLaneRejected: true, cliFramingChecks: 6, files,
      tarball: { path: tarball, sha256: fileHash(tarball) }, operations };
    const manifestPath = join(output, 'manifest.json'); json(manifestPath, manifest); return { manifest: manifestPath, ...manifest };
  } catch (cause) { json(join(output, 'failure.json'), { schemaVersion: 1, result: 'fail', tree, sourceSha256, operations }); throw cause; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); assert.ok(args.length === 5 && args[1] === '--sdk-root' && args[3] === '--sdk-manifest');
  console.log(JSON.stringify(buildStructuredTelemetryKotlin(args[0], args[2], args[4]), null, 2));
}
