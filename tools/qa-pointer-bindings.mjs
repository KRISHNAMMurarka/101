import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { BINDING_PATHS, command, fileHash, installedSdk, kotlinTools, ordinaryFiles, withPublicCaller } from './build-pointer-bindings.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 5 && args[1] === '--sdk-root' && args[3] === '--sdk-manifest',
  'Usage: node tools/qa-pointer-bindings.mjs <binding manifest> --sdk-root <installed SDK> --sdk-manifest <SDK manifest>');
const manifestPath = resolve(args[0]), base = dirname(manifestPath), manifestBytes = readFileSync(manifestPath);
assert.ok(manifestBytes.length <= 1024 * 1024);
const manifest = JSON.parse(manifestBytes), sdk = installedSdk(args[2], args[4]);
assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.profile, 'normalized-pointer-bindings/1');
assert.equal(manifest.authority, 'inert-codec-only'); assert.equal(manifest.artifacts.length, 3);
assert.equal(manifest.sdk.manifestSha256, sdk.manifestSha256);
for (const [path, pin] of Object.entries(manifest.sdk.selectedProducerSha256)) assert.equal(pin, sdk.manifest.source.sha256[path]);
const root = resolve(import.meta.dirname, '..');
for (const path of BINDING_PATHS) assert.equal(fileHash(join(root, path)), manifest.source.sha256[path], 'QA source differs from artifact freeze');
const temporary = mkdtempSync(join(tmpdir(), '101-pointer-consumers-'));
const kotlin = kotlinTools(), results = [];
const encodeLine = input => `E ${input.epoch} ${input.slot} ${input.sequence} ${input.capturedAt} ${input.value.x} ${input.value.y}`;
try {
  for (const language of ['swift', 'kotlin', 'c']) {
    const record = manifest.artifacts.find(artifact => artifact.language === language); assert.ok(record);
    assert.equal(record.directory, language); assert.ok(record.files.length <= 64);
    assert.match(record.tarball.path, /^tarballs\/one01-pointer-(swift|kotlin|c)-1\.0\.0\.tgz$/);
    const tarball = join(base, record.tarball.path); assert.equal(fileHash(tarball), record.tarball.sha256);
    assert.equal(lstatSync(tarball).size, record.tarball.bytes);
    const directory = join(temporary, language); mkdirSync(directory);
    const members = command('tar', ['-tzf', tarball]).trim().split('\n');
    assert.ok(members.length <= 128 && members.every(path => path.startsWith('./') && !path.split('/').includes('..')));
    command('tar', ['-xzf', tarball, '-C', directory]);
    const extracted = ordinaryFiles(directory).map(path => path.slice(directory.length + 1).replaceAll(sep, '/')).sort();
    assert.deepEqual(extracted, record.files.map(file => file.path).sort(), 'Exact closed artifact file inventory');
    for (const file of record.files) {
      assert.equal(fileHash(join(directory, file.path)), file.sha256); assert.equal(lstatSync(join(directory, file.path)).size, file.bytes);
    }
    const artifact = JSON.parse(readFileSync(join(directory, 'artifact.json')));
    assert.equal(artifact.sourceTree, manifest.source.tree); assert.equal(artifact.language, language); assert.equal(artifact.authority, 'inert-codec-only');
    for (const [path, pin] of [['LICENSE', artifact.licenseSha256], ['assets/profile.json', artifact.profileSha256],
      ['assets/normalized-pointer-v1.json', artifact.fixtureSha256], ['assets/device-descriptor.schema.json', artifact.schemaSha256]]) assert.equal(fileHash(join(directory, path)), pin);
    const profile = JSON.parse(readFileSync(join(directory, 'assets/profile.json'))), fixtureBytes = readFileSync(join(directory, 'assets/normalized-pointer-v1.json'));
    assert.ok(fixtureBytes.length <= profile.limits.fixtureBytes);
    const fixtures = JSON.parse(fixtureBytes);
    assert.ok(fixtures.positive.length <= 32 && fixtures.negative.length <= 64 && fixtures.invalidEncode.length <= 16);
    const actual = withPublicCaller(sdk, join(directory, 'examples/normalized-pointer.mjs'), (_, caller) => JSON.parse(command(process.execPath, [caller, '--fixtures'])));
    assert.deepEqual(fixtures, actual, 'Public JS producer/decoder remains the fixture oracle');
    const work = join(temporary, language + '-caller'); mkdirSync(work);
    let executable, options;
    if (language === 'swift') {
      const source = join(work, 'PointerConsumer.swift'); copyFileSync(join(directory, 'examples/PointerConsumer.swift'), source);
      executable = join(work, 'consumer'); options = [];
      command('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-warnings-as-errors', '-I', join(directory, 'lib'),
        '-L', join(directory, 'lib'), '-lOne01PointerWire', '-Xlinker', '-rpath', '-Xlinker', join(directory, 'lib'), source, '-o', executable]);
      command('/usr/bin/xcrun', ['swift', 'test', '--package-path', join(directory, 'source'), '--scratch-path', join(work, 'swift-test'), '--disable-sandbox']);
    } else if (language === 'kotlin') {
      assert.equal(fileHash(kotlin.stdlib), manifest.toolchains.kotlin.stdlibSha256);
      const source = join(work, 'PointerConsumer.kt'); copyFileSync(join(directory, 'examples/PointerConsumer.kt'), source);
      const classes = join(work, 'consumer.jar');
      kotlin.compile(['-Werror', '-jvm-target', '17', '-classpath', [join(directory, 'lib/one01-pointer-wire.jar'), kotlin.stdlib, kotlin.annotations].join(':'), '-d', classes, source]);
      executable = kotlin.java; options = ['-cp', [classes, join(directory, 'lib/one01-pointer-wire.jar'), kotlin.stdlib].join(':'), 'PointerConsumerKt'];
    } else {
      const source = join(work, 'pointer-consumer.c'); copyFileSync(join(directory, 'examples/pointer-consumer.c'), source);
      executable = join(work, 'consumer'); options = [];
      command('/usr/bin/xcrun', ['clang', '-std=c11', '-pedantic', '-Wall', '-Wextra', '-Werror', '-fno-fast-math', '-ffp-contract=off',
        '-I', join(directory, 'include'), source, join(directory, 'lib/libone01_pointer_wire.a'), '-o', executable]);
    }
    const lines = [], expected = [];
    for (const entry of fixtures.positive) {
      lines.push(encodeLine(entry.input), `D disposable ${entry.hex}`); expected.push({ hex: entry.hex }, { hex: entry.hex });
    }
    for (const entry of fixtures.negative) { lines.push(`D ${entry.lane} ${entry.hex}`); expected.push(null); }
    for (const line of fixtures.invalidEncode) { lines.push(line); expected.push(null); }
    assert.ok(lines.length <= profile.limits.consumerCommands);
    const output = command(executable, options, { cwd: work, input: lines.join('\n') + '\n' }).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(output, expected, `${language} must agree with actual public JS bytes and all negative verdicts`);
    const lifecycle = withPublicCaller(sdk, join(directory, 'examples/normalized-pointer.mjs'), (owned, caller) => {
      const script = join(owned, 'host-proof.mjs');
      writeFileSync(script, `import {execFileSync} from 'node:child_process';\nimport {runPointerBindingHostProof} from './normalized-pointer.mjs';\n` +
        `const executable=${JSON.stringify(executable)},args=${JSON.stringify(options)};\n` +
        `const encode=input=>{const line=\`E \${input.epoch} \${input.slot} \${input.sequence} \${input.capturedAt} \${input.value.x} \${input.value.y}\`;` +
        `const result=JSON.parse(execFileSync(executable,args,{input:line+'\\n',encoding:'utf8',timeout:10000,maxBuffer:16384}).trim());return Uint8Array.from(Buffer.from(result.hex,'hex')).buffer;};\n` +
        `console.log(JSON.stringify(runPointerBindingHostProof(encode)));\n`);
      void caller;
      return JSON.parse(command(process.execPath, [script]));
    });
    assert.equal(lifecycle.checks.length, 8); assert.equal(lifecycle.nativeCodecAuthority, 'none');
    results.push({ language, cleanExternalCompiledConsumer: true, positiveFixtures: fixtures.positive.length,
      malformedDecodeFixtures: fixtures.negative.length, invalidEncodeFixtures: fixtures.invalidEncode.length,
      commands: lines.length, closedAssetsAndHashes: true, hostLifecycle: lifecycle });
  }
  console.log(JSON.stringify({ result: 'pass', profile: manifest.profile, sourceTree: manifest.source.tree,
    bindingManifestSha256: fileHash(manifestPath), sdkManifestSha256: sdk.manifestSha256, node: process.version,
    publicResolution: 'ordinary-installed-sdk-esm', qualifiedTargets: manifest.qualifiedTargets,
    toolchains: manifest.toolchains, authority: 'inert-codec-only', exclusions: manifest.exclusions,
    cleanExternalConsumers: results, ownedTemporaryCleanup: true, sourceSha256: manifest.source.sha256 }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
