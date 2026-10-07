import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINDING_PATHS = Object.freeze([
  'bindings/normalized-pointer/profile.json', 'bindings/normalized-pointer/fixtures/normalized-pointer-v1.json',
  'bindings/normalized-pointer/swift/Package.swift', 'bindings/normalized-pointer/swift/Sources/One01PointerWire/PointerWire.swift',
  'bindings/normalized-pointer/swift/Tests/One01PointerWireTests/PointerWireTests.swift',
  'bindings/normalized-pointer/kotlin/src/main/kotlin/com/oneohone/pointerwire/PointerWire.kt',
  'bindings/normalized-pointer/c/include/one01_pointer_wire.h', 'bindings/normalized-pointer/c/src/one01_pointer_wire.c',
  'examples/language-bindings/normalized-pointer.mjs', 'examples/language-bindings/PointerConsumer.swift',
  'examples/language-bindings/PointerConsumer.kt', 'examples/language-bindings/pointer-consumer.c',
  'tests/pointer-bindings.test.ts', 'tools/build-pointer-bindings.mjs', 'tools/qa-pointer-bindings.mjs',
  'tools/audit-native-binding-contents.py', 'tests/native-binding-contents.test.ts', 'tools/qa-native-binding-contents.mjs' ]);
const producerPaths = ['packages/device-web/src/wire.ts', 'packages/device-web/src/binding.ts',
  'packages/device-web/src/pointer-provider.ts', 'packages/device-model/src/input-profile.ts'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileHash = path => sha256(readFileSync(path));
export function command(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options });
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function json(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
export function ordinaryFiles(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), entry = lstatSync(path);
    assert.equal(entry.isSymbolicLink(), false, 'Artifact must not contain symlinks');
    assert.ok(entry.isFile() || entry.isDirectory(), 'Only ordinary files and directories are allowed');
    return entry.isDirectory() ? ordinaryFiles(path) : [path];
  });
}
export function kotlinTools() {
  const cache = join(homedir(), '.gradle/caches/modules-2/files-2.1');
  function jar(group, artifact, version) {
    const base = join(cache, group, artifact, version);
    assert.ok(existsSync(base), `Installed ${artifact} ${version} required; no download is attempted`);
    const files = readdirSync(base).flatMap(hash => readdirSync(join(base, hash))
      .filter(name => name.endsWith('.jar')).map(name => join(base, hash, name)));
    assert.equal(files.length, 1, `Exactly one cached ${artifact} is required`); return files[0];
  }
  const java = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java';
  assert.ok(existsSync(java), 'Installed Homebrew JDK21 is required');
  const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.21');
  const annotations = jar('org.jetbrains', 'annotations', '23.0.0');
  const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.21'), stdlib, annotations,
    jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'), jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.10.2')];
  return { java, stdlib, annotations, compile(args) {
    return command(java, ['-cp', compiler.join(':'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', ...args]);
  }, compilerSha256: compiler.map(path => ({ name: path.split(sep).at(-1), sha256: fileHash(path) })), stdlibSha256: fileHash(stdlib) };
}
export function installedSdk(sdkRoot, manifestPath) {
  const directory = realpathSync(resolve(sdkRoot)), bytes = readFileSync(resolve(manifestPath));
  assert.ok(bytes.length <= 2 * 1024 * 1024, 'SDK manifest is bounded');
  const manifest = JSON.parse(bytes);
  const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.packages.length, names.length);
  for (const name of names) {
    const record = manifest.packages.find(item => item.name === '@101/' + name);
    assert.ok(record && Array.isArray(record.files) && record.files.length <= 1024);
    const path = join(directory, 'node_modules/@101', name);
    assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Use ordinary offline installed SDK packages');
    assert.equal(realpathSync(path), path);
    for (const file of record.files) {
      assert.ok(typeof file.path === 'string' && file.path.length <= 256 && !file.path.startsWith('/') &&
        !file.path.split('/').some(part => part === '..' || part === '.' || !part));
      const installed = join(path, file.path); assert.ok(lstatSync(installed).isFile() && !lstatSync(installed).isSymbolicLink());
      assert.equal(fileHash(installed), file.sha256, 'Installed SDK differs from immutable pack');
    }
  }
  return { directory, manifest, manifestSha256: sha256(bytes) };
}
export function withPublicCaller(sdk, callerPath, action) {
  const directory = mkdtempSync(join(sdk.directory, '.101-pointer-owned-'));
  try {
    const caller = join(directory, 'normalized-pointer.mjs'); copyFileSync(callerPath, caller);
    const resolver = join(directory, 'resolve.mjs');
    writeFileSync(resolver, 'console.log(import.meta.resolve("@101/connect"));\n');
    const resolution = fileURLToPath(command(process.execPath, [resolver]).trim());
    assert.ok(resolution.startsWith(join(sdk.directory, 'node_modules/@101/connect') + sep), 'Normal public ESM resolution required');
    return action(directory, caller);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function toolchains(kotlin) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const swift = command('/usr/bin/xcrun', ['swiftc', '--version']).trim();
  const clang = command('/usr/bin/xcrun', ['clang', '--version']).trim();
  assert.match(swift, /Swift version 6\.3\.3/); assert.match(clang, /clang version 21\./);
  // The release file provides the exact installed JDK version independently of stderr conventions.
  const release = readFileSync(realpathSync(join(dirname(kotlin.java), '..', 'release')), 'utf8');
  const jdk = /JAVA_VERSION="([^"]+)"/.exec(release)?.[1]; assert.equal(jdk, '21.0.12');
  return { swift: { version: '6.3.3', detail: swift, target: 'macos-arm64', runtime: process.platform },
    c: { version: '21', detail: clang, standard: 'C11', target: 'macos-arm64' },
    kotlin: { version: '2.1.21', compilerSha256: kotlin.compilerSha256, stdlibSha256: kotlin.stdlibSha256,
      jdk, declaredJvmTarget: 17, qualifiedJvmRuntime: 21, android: 'unqualified' } };
}

export function buildPointerBindings(reference, sdkRoot, sdkManifest) {
  const root = resolve(import.meta.dirname, '..');
  assert.match(reference, /^[0-9a-f]{40}$/, 'Pass a full immutable Git commit or tree ID');
  const tree = command('git', ['rev-parse', '--verify', `${reference}^{tree}`], { cwd: root }).trim();
  const sdk = installedSdk(sdkRoot, sdkManifest), selectedProducerSha256 = {};
  for (const path of producerPaths) {
    const bytes = execFileSync('git', ['show', `${tree}:${path}`], { cwd: root, maxBuffer: 1024 * 1024 });
    selectedProducerSha256[path] = sha256(bytes);
    assert.equal(selectedProducerSha256[path], sdk.manifest.source.sha256[path], 'Selected public producer must match source tree');
  }
  const snapshot = mkdtempSync(join(tmpdir(), '101-pointer-source-')); let output;
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', tree, '--', ...BINDING_PATHS, 'LICENSE', 'schemas/device-descriptor.schema.json'], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive, timeout: 10_000 });
    for (const path of BINDING_PATHS) assert.ok(existsSync(join(snapshot, path)), `Frozen source missing ${path}`);
    assert.equal(fileHash(fileURLToPath(import.meta.url)), fileHash(join(snapshot, 'tools/build-pointer-bindings.mjs')), 'Build tool must match frozen source');
    const profile = JSON.parse(readFileSync(join(snapshot, BINDING_PATHS[0]), 'utf8'));
    assert.deepEqual(Object.keys(profile).sort(), ['schemaVersion', 'profile', 'version', 'codec', 'packetBytes', 'byteOrder', 'lane', 'inputProfile',
      'capability', 'coordinateAbsoluteError', 'limits', 'authority', 'qualifiedTargets', 'excluded', 'runtimeDependencies'].sort());
    assert.equal(profile.profile, 'normalized-pointer-bindings/1'); assert.equal(profile.version, '1.0.0');
    assert.equal(profile.schemaVersion, 1); assert.equal(profile.codec, 'normalized-pointer/1'); assert.equal(profile.packetBytes, 48);
    assert.equal(profile.byteOrder, 'big-endian'); assert.equal(profile.lane, 'disposable'); assert.equal(profile.authority, 'inert-codec-only');
    assert.deepEqual(profile.limits, { positiveFixtures: 32, negativeFixtures: 64, invalidEncodeFixtures: 16, fixtureBytes: 49152, consumerCommands: 128, consumerLineBytes: 4096 });
    const fixturePath = join(snapshot, BINDING_PATHS[1]), fixtureBytes = readFileSync(fixturePath);
    assert.ok(fixtureBytes.length <= profile.limits.fixtureBytes);
    const regenerated = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/normalized-pointer.mjs'), (_, caller) =>
      JSON.parse(command(process.execPath, [caller, '--fixtures'])));
    assert.deepEqual(JSON.parse(fixtureBytes), regenerated, 'Frozen fixtures must match the actual public producer');
    const schema = readFileSync(join(snapshot, 'schemas/device-descriptor.schema.json'));
    assert.equal(sha256(schema), sdk.manifest.source.sha256['schemas/device-descriptor.schema.json']);
    const sourceSha256 = Object.fromEntries([...BINDING_PATHS, 'LICENSE', 'schemas/device-descriptor.schema.json'].map(path => [path, fileHash(join(snapshot, path))]));
    const kotlin = kotlinTools(), tools = toolchains(kotlin);
    mkdirSync(join(root, 'release'), { recursive: true }); output = mkdtempSync(join(root, 'release/pointer-bindings-'));
    const artifacts = [];
    for (const language of ['swift', 'kotlin', 'c']) {
      const directory = join(output, language); mkdirSync(directory);
      for (const [from, to] of [['LICENSE', 'LICENSE'], [BINDING_PATHS[0], 'assets/profile.json'], [BINDING_PATHS[1], 'assets/normalized-pointer-v1.json'],
        ['schemas/device-descriptor.schema.json', 'assets/device-descriptor.schema.json'], ['examples/language-bindings/normalized-pointer.mjs', 'examples/normalized-pointer.mjs']]) copy(join(snapshot, from), join(directory, to));
      if (language === 'swift') {
        for (const path of BINDING_PATHS.filter(path => path.startsWith('bindings/normalized-pointer/swift/')))
          copy(join(snapshot, path), join(directory, 'source', path.slice('bindings/normalized-pointer/swift/'.length)));
        copy(join(snapshot, 'examples/language-bindings/PointerConsumer.swift'), join(directory, 'examples/PointerConsumer.swift'));
        mkdirSync(join(directory, 'lib'));
        command('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-emit-library', '-emit-module',
          // SourceKit source-info embeds absolute build paths and is unnecessary
          // for the qualified import/consumer ABI. Keep the public module/docs.
          '-avoid-emit-module-source-info', '-file-prefix-map', `${root}=/one01-native`,
          '-debug-prefix-map', `${root}=/one01-native`, '-prefix-serialized-debugging-options',
          '-module-name', 'One01PointerWire', '-emit-module-path', join(directory, 'lib/One01PointerWire.swiftmodule'),
          '-Xlinker', '-install_name', '-Xlinker', '@rpath/libOne01PointerWire.dylib',
          join(directory, 'source/Sources/One01PointerWire/PointerWire.swift'), '-o', join(directory, 'lib/libOne01PointerWire.dylib')]);
      } else if (language === 'kotlin') {
        copy(join(snapshot, BINDING_PATHS[5]), join(directory, 'source/PointerWire.kt'));
        copy(join(snapshot, 'examples/language-bindings/PointerConsumer.kt'), join(directory, 'examples/PointerConsumer.kt'));
        mkdirSync(join(directory, 'lib'));
        kotlin.compile(['-Werror', '-jvm-target', '17', '-classpath', [kotlin.stdlib, kotlin.annotations].join(':'),
          '-d', join(directory, 'lib/one01-pointer-wire.jar'), join(directory, 'source/PointerWire.kt')]);
      } else {
        copy(join(snapshot, BINDING_PATHS[6]), join(directory, 'include/one01_pointer_wire.h'));
        copy(join(snapshot, BINDING_PATHS[7]), join(directory, 'source/one01_pointer_wire.c'));
        copy(join(snapshot, 'examples/language-bindings/pointer-consumer.c'), join(directory, 'examples/pointer-consumer.c'));
        mkdirSync(join(directory, 'lib'));
        const object = join(snapshot, 'pointer-wire.o');
        command('/usr/bin/xcrun', ['clang', '-std=c11', '-pedantic', '-Wall', '-Wextra', '-Werror', '-fno-fast-math', '-ffp-contract=off',
          '-I', join(directory, 'include'), '-c', join(directory, 'source/one01_pointer_wire.c'), '-o', object]);
        command('/usr/bin/xcrun', ['ar', 'rcs', join(directory, 'lib/libone01_pointer_wire.a'), object]);
      }
      json(join(directory, 'artifact.json'), { schemaVersion: 1, profile: profile.profile, version: profile.version, language,
        target: tools[language].target ?? 'jvm-jdk21', toolchain: tools[language], sourceTree: tree,
        authority: 'inert-codec-only', runtimeDependencies: profile.runtimeDependencies[language],
        fixtureSha256: sha256(fixtureBytes), profileSha256: sourceSha256[BINDING_PATHS[0]], schemaSha256: sha256(schema),
        licenseSha256: sourceSha256.LICENSE, sdkManifestSha256: sdk.manifestSha256, selectedProducerSha256 });
      const files = ordinaryFiles(directory).map(path => ({ path: relative(directory, path).replaceAll(sep, '/'),
        bytes: lstatSync(path).size, sha256: fileHash(path) }));
      assert.ok(files.length <= 64);
      mkdirSync(join(output, 'tarballs'), { recursive: true });
      const tarball = `tarballs/one01-pointer-${language}-${profile.version}.tgz`;
      // The inventory covers public payloads only. Suppress macOS metadata
      // serialization without removing any attributes from the source files.
      command('tar', ['--format', 'ustar', '--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags',
        '-czf', join(output, tarball), '-C', directory, '.']);
      artifacts.push({ language, directory: language, files, tarball: { path: tarball, bytes: lstatSync(join(output, tarball)).size, sha256: fileHash(join(output, tarball)) } });
    }
    const manifest = { schemaVersion: 1, profile: profile.profile, version: profile.version,
      source: { tree, sha256: sourceSha256 }, sdk: { sourceTree: sdk.manifest.source.tree, manifestSha256: sdk.manifestSha256, selectedProducerSha256 },
      toolchains: tools, qualifiedTargets: profile.qualifiedTargets, authority: 'inert-codec-only', exclusions: profile.excluded, artifacts };
    const manifestPath = join(output, 'manifest.json'); json(manifestPath, manifest);
    const manifestSha256 = fileHash(manifestPath), auditPath = join(output, 'content-audit.json');
    const contentAudit = JSON.parse(command('python3', ['-I', '-S', '-B', join(snapshot, 'tools/audit-native-binding-contents.py'),
      '--manifest', manifestPath, '--manifest-sha256', manifestSha256, '--artifact-root', output,
      '--output', auditPath, '--workspace-root', root, '--workspace-root', realpathSync(root)], { killSignal: 'SIGKILL' }));
    assert.equal(contentAudit.schemaVersion, 1); assert.equal(contentAudit.auditProfile, 'native-binding-content-audit/1');
    assert.equal(contentAudit.result, 'pass'); assert.equal(contentAudit.reason, 'ok');
    assert.equal(contentAudit.bindingManifestSha256, manifestSha256);
    assert.equal(contentAudit.toolSha256, sourceSha256['tools/audit-native-binding-contents.py']);
    assert.equal(contentAudit.files, 33); assert.equal(contentAudit.artifacts.length, 3);
    assert.equal(contentAudit.releaseAccepted, false);
    assert.equal(fileHash(manifestPath), manifestSha256, 'Content audit must preserve the frozen manifest');
    return { manifest: manifestPath, ...manifest, contentAudit: { path: auditPath, sha256: fileHash(auditPath) } };
  } catch (error) { if (output) rmSync(output, { recursive: true, force: true }); throw error; }
  finally { rmSync(snapshot, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 5 && args[1] === '--sdk-root' && args[3] === '--sdk-manifest',
    'Usage: node tools/build-pointer-bindings.mjs <immutable tree> --sdk-root <installed SDK> --sdk-manifest <manifest>');
  console.log(JSON.stringify(buildPointerBindings(args[0], args[2], args[4]), null, 2));
}
