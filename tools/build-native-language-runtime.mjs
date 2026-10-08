import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileHash, kotlinTools, ordinaryFiles } from './build-pointer-bindings.mjs';

const root = resolve(import.meta.dirname, '..');
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const swiftPrefix = 'bindings/resource-runtime/swift/';
const kotlinPrefix = 'bindings/resource-runtime/kotlin/';
const swiftPaths = ['Package.swift', 'Sources/One01ResourceRss/ResourceRssRuntime.swift',
  'Sources/One01ResourceRssCaller/main.swift', 'Tests/One01ResourceRssTests/ResourceRssTests.swift',
  'Tests/One01ResourceRssTests/Fixtures/rss-cases.json'];
const kotlinPaths = ['src/main/kotlin/one01/resourcerss/ResourceRssRuntime.kt', 'src/main/c/one01_rss_jni.c',
  'src/caller/kotlin/one01/resourcerss/ResourceRssCaller.kt',
  'src/test/kotlin/one01/resourcerss/ResourceRssTests.kt', 'src/test/c/jni-slots-harness.c'];
const cPaths = ['bindings/resource-runtime/c/one01_rss_runtime.c', 'bindings/resource-runtime/c/one01_rss_runtime.h'];
const sourcePaths = [...swiftPaths.map(path => swiftPrefix + path), ...kotlinPaths.map(path => kotlinPrefix + path),
  ...cPaths, 'LICENSE', 'tools/build-native-language-runtime.mjs', 'tools/build-pointer-bindings.mjs'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, fileHash(join(root, path))]));
mkdirSync(join(root, 'release'), { recursive: true });
const output = mkdtempSync(join(root, 'release', 'native-language-runtime-'));
const kotlin = kotlinTools();
const javaHome = dirname(dirname(kotlin.java));
const run = (program, args, cwd = output, env = process.env) => execFileSync(program, args,
  { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 ** 20 });
const operations = [];
function check(name, action) {
  const log = action(); writeFileSync(join(output, name + '.log'), log);
  operations.push({ name, result: 'pass', log: name + '.log', sha256: fileHash(join(output, name + '.log')) });
  return log;
}
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
const toolchains = { swift: run('/usr/bin/swift', ['--version']).trim(),
  clang: run('/usr/bin/xcrun', ['clang', '--version']).split('\n')[0],
  kotlin: { version: '2.1.21', compilerSha256: kotlin.compilerSha256, stdlibSha256: kotlin.stdlibSha256,
    declaredJvmTarget: 17, qualifiedRuntime: readFileSync(join(javaHome, 'release'), 'utf8') } };
const artifacts = [];
for (const language of ['swift', 'kotlin']) {
  const payload = join(output, language), clean = join(output, 'clean-' + language);
  mkdirSync(payload); copy(join(root, 'LICENSE'), join(payload, 'LICENSE'));
  if (language === 'swift') {
    for (const path of swiftPaths) copy(join(root, swiftPrefix + path), join(payload, 'source', path));
    mkdirSync(join(payload, 'lib'));
    check('swift-library-build', () => run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6',
      '-strict-concurrency=complete', '-warnings-as-errors', '-emit-library', '-emit-module',
      '-avoid-emit-module-source-info', '-module-name', 'One01ResourceRss',
      '-target', 'arm64-apple-macosx14.0', '-file-prefix-map', root + '=/one01-native',
      '-debug-prefix-map', root + '=/one01-native', '-emit-module-path', join(payload, 'lib/One01ResourceRss.swiftmodule'),
      '-Xlinker', '-install_name', '-Xlinker', '@rpath/libOne01ResourceRss.dylib',
      join(payload, 'source/Sources/One01ResourceRss/ResourceRssRuntime.swift'),
      '-o', join(payload, 'lib/libOne01ResourceRss.dylib')]));
  } else {
    for (const path of kotlinPaths) copy(join(root, kotlinPrefix + path), join(payload, 'source', path));
    for (const path of cPaths) copy(join(root, path), join(payload, 'source/c', path.split('/').at(-1)));
    copy(join(root, swiftPrefix + swiftPaths[4]), join(payload, 'assets/rss-cases.json'));
    mkdirSync(join(payload, 'lib'));
    check('kotlin-library-build', () => kotlin.compile(['-Werror', '-jvm-target', '17',
      '-classpath', [kotlin.stdlib, kotlin.annotations].join(':'), '-d', join(payload, 'lib/one01-resource-rss.jar'),
      join(payload, 'source/src/main/kotlin/one01/resourcerss/ResourceRssRuntime.kt')]));
    check('jni-library-build', () => run('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-dynamiclib', '-I', join(javaHome, 'include'), '-I', join(javaHome, 'include/darwin'),
      '-I', join(payload, 'source/c'), join(payload, 'source/c/one01_rss_runtime.c'),
      join(payload, 'source/src/main/c/one01_rss_jni.c'), '-o', join(payload, 'lib/libone01rss.dylib')]));
  }
  const metadata = { schemaVersion: 1, profile: 'self-current-rss-macos-mach/1', version: '0.1.0',
    language, target: 'macos-arm64', license: 'MIT', sourceSha256, toolchain: toolchains[language],
    authority: 'Cooperative synchronous owner-thread callbacks; opaque process-local handles are not remote credentials.',
    limits: { generations: 2, readsPerGeneration: 32, registrationMs: 10000, readMs: 1000 },
    runtimeDependencies: language === 'swift' ? ['macOS 14 or later', 'compatible Swift 6 runtime'] :
      ['macOS arm64', 'JVM 17 bytecode; qualified here with JDK 21', 'external Kotlin stdlib 2.1.21'],
    excluded: ['other-process RSS', 'other OS', 'Android JNI qualification', 'physical-device qualification', 'remote authority'] };
  writeFileSync(join(payload, 'artifact.json'), JSON.stringify(metadata, null, 2) + '\n');
  const inventory = ordinaryFiles(payload).map(path => ({ path: relative(payload, path),
    bytes: lstatSync(path).size, sha256: fileHash(path) }));
  const allowed = ['LICENSE', 'artifact.json', ...(language === 'swift' ? [
    'lib/One01ResourceRss.abi.json', 'lib/One01ResourceRss.swiftdoc',
    'lib/One01ResourceRss.swiftmodule', 'lib/libOne01ResourceRss.dylib',
    ...swiftPaths.map(path => 'source/' + path),
  ] : ['assets/rss-cases.json', 'lib/libone01rss.dylib', 'lib/one01-resource-rss.jar',
    ...kotlinPaths.map(path => 'source/' + path),
    ...cPaths.map(path => 'source/c/' + path.split('/').at(-1)),
  ])].sort();
  const expected = inventory.map(file => file.path).sort();
  assert.deepEqual(expected, allowed, 'Unexpected artifact path');
  const archive = join(output, 'one01-resource-rss-' + language + '-macos-arm64-0.1.0.tgz');
  run('tar', ['-czf', archive, '-C', payload, ...expected], output, { ...process.env, COPYFILE_DISABLE: '1' });
  assert.deepEqual(run('tar', ['-tzf', archive]).trim().split('\n').sort(), expected);
  mkdirSync(clean); run('tar', ['-xzf', archive, '-C', clean]);
  assert.deepEqual(ordinaryFiles(clean).map(path => relative(clean, path)).sort(), expected);
  for (const file of inventory) assert.equal(fileHash(join(clean, file.path)), file.sha256);
  if (language === 'swift') {
    check('swift-installed-tests', () => run('/usr/bin/swift', ['test', '--package-path', join(clean, 'source')]));
    const caller = join(output, 'installed-swift-caller');
    check('swift-installed-caller-build', () => run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6',
      '-target', 'arm64-apple-macosx14.0', '-I', join(clean, 'lib'), '-L', join(clean, 'lib'),
      '-lOne01ResourceRss', '-Xlinker', '-rpath', '-Xlinker', join(clean, 'lib'),
      join(clean, 'source/Sources/One01ResourceRssCaller/main.swift'), '-o', caller]));
    assert.match(check('swift-installed-caller', () => run(caller, [])), /swift-self-rss:read-stop-pass/);
  } else {
    const classpath = [join(clean, 'lib/one01-resource-rss.jar'), kotlin.stdlib, kotlin.annotations].join(':');
    const tests = join(output, 'installed-kotlin-tests.jar'), caller = join(output, 'installed-kotlin-caller.jar');
    for (const [name, target, path] of [['tests', tests, 'src/test/kotlin/one01/resourcerss/ResourceRssTests.kt'],
      ['caller', caller, 'src/caller/kotlin/one01/resourcerss/ResourceRssCaller.kt']])
      check('kotlin-installed-' + name + '-build', () => kotlin.compile(['-Werror', '-jvm-target', '17',
        '-classpath', classpath, '-d', target, join(clean, 'source', path)]));
    const launch = (jar, entry) => run(kotlin.java, ['-Djava.library.path=' + join(clean, 'lib'), '-cp',
      [jar, join(clean, 'lib/one01-resource-rss.jar'), kotlin.stdlib].join(':'), entry], output,
      { ...process.env, ONE01_RSS_CASES: join(clean, 'assets/rss-cases.json') });
    assert.match(check('kotlin-installed-tests', () => launch(tests, 'one01.resourcerss.ResourceRssTests')), /kotlin-self-rss:17-cases:pass/);
    assert.match(check('kotlin-installed-caller', () => launch(caller, 'one01.resourcerss.ResourceRssCaller')), /kotlin-self-rss:read-stop-pass/);
    const harness = join(output, 'installed-jni-slots-harness');
    check('jni-installed-harness-build', () => run('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      '-I', join(javaHome, 'include'), '-I', join(javaHome, 'include/darwin'), '-I', join(clean, 'source/c'),
      join(clean, 'source/c/one01_rss_runtime.c'), join(clean, 'source/src/test/c/jni-slots-harness.c'), '-o', harness]));
    assert.match(check('jni-installed-harness', () => run(harness, [])), /jni-concurrent-slots:pass/);
  }
  artifacts.push({ language, path: archive, bytes: lstatSync(archive).size, sha256: fileHash(archive), files: inventory,
    installedCaller: 'pass', conformance: { canonicalCases: 17, additionalReentryAndOwnerChecks: true } });
}
for (const [path, sha] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), sha, 'Build input changed');
const manifest = { schemaVersion: 1, status: 'pass', kind: 'selected-native-resource-language-distributions',
  sourceRevision: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceSha256, toolchains, artifacts, operations,
  scope: 'Local selected macOS own-process RSS only. External JDK and Kotlin stdlib are required, not redistributed.' };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', manifest: join(output, 'manifest.json'), artifacts: artifacts.map(item => item.path) }));
