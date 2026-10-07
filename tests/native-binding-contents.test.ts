import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const audit = resolve(import.meta.dirname, '../tools/audit-native-binding-contents.py');
const qa = resolve(import.meta.dirname, '../tools/qa-native-binding-contents.mjs');
const python = process.env.ONE01_K12_PYTHON ?? 'python3';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sensitiveFixture = 'SECRET_TOKEN_FIXTURE_K12';

// This only emits test archives. It contains no content auditor or parser oracle.
// Files mirror the real producer's full 14/9/10 inventories and artifact metadata.
// Compiled bytes here are inert fixtures; only root's separate actual tar/JAR
// prefix can establish real distributable prerequisites for the OLD witness.
const emitFixture = String.raw`
import hashlib, io, json, pathlib, stat, sys, tarfile, warnings, zipfile
root = pathlib.Path(sys.argv[1]); mode = sys.argv[2]
sha = lambda b: hashlib.sha256(b).hexdigest()
encode = lambda v: (json.dumps(v, indent=2) + '\n').encode()
tree = '1' * 40; sdk_hash = '2' * 64
producer = {p: '3' * 64 for p in ['packages/device-web/src/wire.ts', 'packages/device-web/src/binding.ts', 'packages/device-web/src/pointer-provider.ts', 'packages/device-model/src/input-profile.ts']}
profile = {'schemaVersion': 1, 'profile': 'normalized-pointer-bindings/1', 'version': '1.0.0',
 'codec': 'normalized-pointer/1', 'packetBytes': 48, 'byteOrder': 'big-endian', 'lane': 'disposable',
 'inputProfile': 'app:pointer/1', 'capability': 'position', 'coordinateAbsoluteError': 2.9802322387695312e-8,
 'limits': {'positiveFixtures': 32, 'negativeFixtures': 64, 'invalidEncodeFixtures': 16, 'fixtureBytes': 49152, 'consumerCommands': 128, 'consumerLineBytes': 4096},
 'authority': 'inert-codec-only', 'qualifiedTargets': ['swift-macos-arm64', 'c-macos-arm64', 'kotlin-jvm-jdk21'],
 'excluded': ['native-runtime-lifecycle', 'resource-grants', 'identity', 'transport-authentication', 'physical-effects', 'ios', 'android', 'cross-toolchain-abi', 'public-distribution'],
 'runtimeDependencies': {'swift': 'Foundation', 'c': 'C11 standard library and IEEE binary32/binary64', 'kotlin': 'Kotlin stdlib 2.1.21; JVM target17 declared, tested on JDK21 only'}}
fixtures = {'schemaVersion': 1, 'profile': profile['profile'], 'codec': profile['codec'],
 'positive': [{'id': 'actual-publisher', 'input': {'protocol': 'connect', 'version': 1, 'type': 'sample',
  'epoch': '0123456789abcdef0123456789abcdef', 'slot': 1, 'sequence': 1, 'capturedAt': 1000,
  'value': {'x': 0.25, 'y': 0.75}}, 'hex': '434e01010123456789abcdef0123456789abcdef0001000000000001408f4000000000003e8000003f40000000000000'}],
 'negative': [], 'invalidEncode': []}
common = {'LICENSE': b'MIT License\nCopyright (c) 101\n', 'assets/profile.json': encode(profile),
 'assets/normalized-pointer-v1.json': encode(fixtures), 'assets/device-descriptor.schema.json': encode({'$schema': 'https://json-schema.org/draft/2020-12/schema', 'type': 'object'}),
 'examples/normalized-pointer.mjs': b'// Inert consumer fixture; not executed.\n'}
extra = {
 'swift': ['examples/PointerConsumer.swift', 'lib/One01PointerWire.abi.json', 'lib/One01PointerWire.swiftdoc', 'lib/One01PointerWire.swiftmodule', 'lib/libOne01PointerWire.dylib', 'source/Package.swift', 'source/Sources/One01PointerWire/PointerWire.swift', 'source/Tests/One01PointerWireTests/PointerWireTests.swift'],
 'kotlin': ['examples/PointerConsumer.kt', 'lib/one01-pointer-wire.jar', 'source/PointerWire.kt'],
 'c': ['examples/pointer-consumer.c', 'include/one01_pointer_wire.h', 'lib/libone01_pointer_wire.a', 'source/one01_pointer_wire.c']}
toolchains = {'swift': {'version': '6.3.3', 'target': 'macos-arm64', 'runtime': 'darwin', 'detail': 'fixture'},
 'c': {'version': '21', 'standard': 'C11', 'target': 'macos-arm64', 'detail': 'fixture'},
 'kotlin': {'version': '2.1.21', 'jdk': '21.0.12', 'declaredJvmTarget': 17, 'qualifiedJvmRuntime': 21, 'android': 'unqualified',
  'compilerSha256': [{'name': p, 'sha256': '4' * 64} for p in ['kotlin-compiler-embeddable-2.1.21.jar', 'kotlin-stdlib-2.1.21.jar', 'annotations-23.0.0.jar', 'trove4j-1.0.20200330.jar', 'kotlinx-coroutines-core-jvm-1.10.2.jar']], 'stdlibSha256': '4' * 64}}
jar_entries = {'META-INF/MANIFEST.MF': b'Manifest-Version: 1.0\r\n\r\n', 'META-INF/main.kotlin_module': b'public metadata',
 'com/oneohone/pointerwire/PointerLane.class': b'\xca\xfe\xba\xbepublic-lane',
 'com/oneohone/pointerwire/PointerSample.class': b'\xca\xfe\xba\xbepublic-sample',
 'com/oneohone/pointerwire/PointerWire.class': b'\xca\xfe\xba\xbepublic-wire'}
if mode == 'jar-private-file': jar_entries['receipts/SECRET_TOKEN_FIXTURE_K12.json'] = b'private receipt'
if mode == 'jar-private-content': jar_entries['com/oneohone/pointerwire/PointerWire.class'] += b'-----BEGIN PRIVATE KEY-----SECRET_TOKEN_FIXTURE_K12'
if mode == 'jar-missing-class': del jar_entries['com/oneohone/pointerwire/PointerSample.class']
jar = io.BytesIO()
with warnings.catch_warnings():
 warnings.simplefilter('ignore', UserWarning)
 with zipfile.ZipFile(jar, 'w') as z:
  for name, data in jar_entries.items():
   info = zipfile.ZipInfo(name); info.create_system = 3; info.external_attr = (stat.S_IFREG | 0o644) << 16
   info.compress_type = zipfile.ZIP_BZIP2 if mode == 'jar-compression' else zipfile.ZIP_STORED
   if mode == 'jar-link' and name.endswith('PointerWire.class'): info.external_attr = (stat.S_IFLNK | 0o777) << 16
   z.writestr(info, data)
  if mode == 'jar-duplicate': z.writestr('com/oneohone/pointerwire/PointerWire.class', b'public duplicate')
jar_bytes = jar.getvalue()
if mode == 'jar-crc':
 at = jar_bytes.index(b'\xca\xfe\xba\xbe'); jar_bytes = jar_bytes[:at] + b'X' + jar_bytes[at+1:]
source_pins = {'LICENSE': sha(common['LICENSE']), 'schemas/device-descriptor.schema.json': sha(common['assets/device-descriptor.schema.json']),
 'bindings/normalized-pointer/profile.json': sha(common['assets/profile.json']), 'bindings/normalized-pointer/fixtures/normalized-pointer-v1.json': sha(common['assets/normalized-pointer-v1.json'])}
records = []; tar_root = root / 'tarballs'; tar_root.mkdir()
for language in ['swift', 'kotlin', 'c']:
 files = dict(common); files.update({p: ('public fixture ' + p + '\n').encode() for p in extra[language]})
 if language == 'kotlin': files['lib/one01-pointer-wire.jar'] = jar_bytes
 if language == 'swift':
  target = 'lib/One01PointerWire.swiftmodule'
  if mode == 'private-content': files[target] += b'-----BEGIN PRIVATE KEY-----SECRET_TOKEN_FIXTURE_K12'
  if mode == 'split-marker': files[target] = b'A' * 65530 + b'-----BEGIN PRIVATE KEY-----SECRET_TOKEN_FIXTURE_K12'
  if mode == 'workspace-content': files[target] += str(root).encode()
  if mode == 'temporary-source-content': files[target] += b'/private/tmp/101-pointer-source-SECRET_TOKEN_FIXTURE_K12/source.swift'
  if mode == 'file-bound': files[target] = b'A' * (4 * 1024 * 1024 + 1)
 metadata = {'schemaVersion': 1, 'profile': profile['profile'], 'version': profile['version'], 'language': language,
  'target': toolchains[language].get('target', 'jvm-jdk21'), 'toolchain': toolchains[language], 'sourceTree': tree,
  'authority': 'inert-codec-only', 'runtimeDependencies': profile['runtimeDependencies'][language],
  'fixtureSha256': sha(files['assets/normalized-pointer-v1.json']), 'profileSha256': sha(files['assets/profile.json']),
  'schemaSha256': sha(files['assets/device-descriptor.schema.json']), 'licenseSha256': sha(files['LICENSE']),
  'sdkManifestSha256': sdk_hash, 'selectedProducerSha256': producer}
 if mode == 'metadata-authority' and language == 'c': metadata['authority'] = 'automatic-resource-authority'
 files['artifact.json'] = encode(metadata)
 if mode == 'missing-license' and language == 'c': del files['LICENSE']
 directory = root / language; directory.mkdir()
 for name, data in files.items():
  p = directory / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
 member_files = dict(files)
 if language == 'swift' and mode == 'apple-sidecar': member_files['._LICENSE'] = b'Apple metadata SECRET_TOKEN_FIXTURE_K12'
 if language == 'swift' and mode == 'private-file': member_files['.env.production'] = b'SECRET_TOKEN_FIXTURE_K12'
 path = tar_root / ('one01-pointer-' + language + '-1.0.0.tgz')
 with tarfile.open(path, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'mtime': '0'} if language == 'swift' and mode == 'pax-global-header' else {}) as t:
  info = tarfile.TarInfo('.'); info.type = tarfile.DIRTYPE; info.mode = 0o755; t.addfile(info)
  for name, data in sorted(member_files.items()):
   if language == 'swift' and name == 'LICENSE' and mode in ['gnu-private-header', 'gnu-undeclared-header']:
    extension = b'./LICENSE\0' + (b'-----BEGIN PRIVATE KEY-----SECRET_TOKEN_FIXTURE_K12' if mode == 'gnu-private-header' else b'')
    header = tarfile.TarInfo('././@LongLink'); header.type = tarfile.GNUTYPE_LONGNAME; header.size = len(extension)
    t.addfile(header, io.BytesIO(extension))
   info = tarfile.TarInfo('./' + name); info.size = len(data); info.mode = 0o644
   if language == 'swift' and mode == 'pax-provenance' and name == 'LICENSE':
    info.pax_headers = {'LIBARCHIVE.xattr.com.apple.provenance': 'SECRET_TOKEN_FIXTURE_K12', 'SCHILY.xattr.com.apple.provenance': 'SECRET_TOKEN_FIXTURE_K12'}
   if language == 'swift' and mode == 'tar-link' and name == 'LICENSE':
    info.type = tarfile.SYMTYPE; info.linkname = 'SECRET_TOKEN_FIXTURE_K12'; info.size = 0; t.addfile(info)
   else: t.addfile(info, io.BytesIO(data))
  if language == 'swift' and mode in ['tar-duplicate', 'tar-traversal']:
   info = tarfile.TarInfo('./LICENSE' if mode == 'tar-duplicate' else '../SECRET_TOKEN_FIXTURE_K12'); info.size = 6; t.addfile(info, io.BytesIO(b'public'))
 if language == 'swift' and mode == 'gzip-truncated': path.write_bytes(path.read_bytes()[:-8])
 records.append({'language': language, 'directory': language, 'files': [{'path': p, 'bytes': len(b), 'sha256': sha(b)} for p, b in sorted(files.items())],
  'tarball': {'path': 'tarballs/' + path.name, 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())}})
manifest = {'schemaVersion': 1, 'profile': profile['profile'], 'version': profile['version'], 'source': {'tree': tree, 'sha256': source_pins},
 'sdk': {'sourceTree': tree, 'manifestSha256': sdk_hash, 'selectedProducerSha256': producer}, 'toolchains': toolchains,
 'qualifiedTargets': profile['qualifiedTargets'], 'authority': 'inert-codec-only', 'exclusions': profile['excluded'], 'artifacts': records}
if mode == 'schema-future': manifest['schemaVersion'] = 2
if mode == 'outer-digest': manifest['artifacts'][0]['tarball']['sha256'] = '0' * 64
(root / 'manifest.json').write_bytes(encode(manifest))
print(json.dumps({'fixture': 'ready', 'languages': 3, 'qualifiedNativeBuild': False}))
`;

function fixture(mode = 'ordinary') {
  const root = mkdtempSync(join(tmpdir(), '101-native-content-test-'));
  try {
    const emitted = spawnSync(python, ['-I', '-S', '-B', '-c', emitFixture, root, mode], {
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.equal(emitted.status, 0, 'Fixture emission must settle before an auditor assertion');
    assert.equal(emitted.signal, null); assert.equal(emitted.error, undefined);
    assert.deepEqual(JSON.parse(emitted.stdout), { fixture: 'ready', languages: 3, qualifiedNativeBuild: false });
    const manifest = join(root, 'manifest.json'), output = join(root, 'content-audit.json');
    const manifestSha = sha256(readFileSync(manifest));
    return { root, manifest, output, manifestSha,
      run(extra: string[] = []) {
        return spawnSync(python, ['-I', '-S', '-B', audit, '--manifest', manifest, '--manifest-sha256', manifestSha,
          '--artifact-root', root, '--output', output, '--workspace-root', root, ...extra], {
          encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        });
      },
      close() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function rejected(mode: string, reason: string) {
  const f = fixture(mode);
  try {
    const result = f.run();
    assert.equal(result.status, 1, 'Policy refusal must be an actual bounded auditor verdict');
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1); assert.equal(report.auditProfile, 'native-binding-content-audit/1');
    assert.equal(report.result, 'fail'); assert.equal(report.reason, reason);
    assert.equal(report.bindingManifestSha256, f.manifestSha);
    const combined = result.stdout + result.stderr + (existsSync(f.output) ? readFileSync(f.output, 'utf8') : '');
    for (const value of [sensitiveFixture, f.root, 'automatic-resource-authority']) {
      assert.ok(!combined.includes(value), 'Audit diagnostics must exclude caller and payload values');
    }
    assert.equal(sha256(readFileSync(f.manifest)), f.manifestSha, 'Audit must preserve the immutable producer manifest');
  } finally { f.close(); }
}

test('missing native binding artifact content audit', () => {
  // Root may run this against actual retained archives after its real prefix.
  // Default unit use exercises a complete ordinary producer-shaped fixture.
  const actualManifest = process.env.ONE01_K12_ACTUAL_MANIFEST;
  if (actualManifest) {
    const expectedSha = process.env.ONE01_K12_ACTUAL_MANIFEST_SHA256;
    const artifactRoot = process.env.ONE01_K12_ACTUAL_ARTIFACT_ROOT;
    const workspaceRoot = process.env.ONE01_K12_WORKSPACE_ROOT;
    const outputRoot = process.env.ONE01_K12_QA_OUTPUT_ROOT;
    assert.ok(expectedSha && artifactRoot && workspaceRoot && outputRoot, 'Actual prerequisite inputs must be explicit');
    const args = [qa, '--manifest', actualManifest, '--manifest-sha256', expectedSha, '--artifact-root', artifactRoot,
      '--workspace-root', workspaceRoot, '--python', python, '--output-root', outputRoot];
    if (process.env.ONE01_K12_PREFIX_RECEIPT) {
      assert.ok(process.env.ONE01_K12_PREFIX_SHA256);
      args.push('--prefix-receipt', process.env.ONE01_K12_PREFIX_RECEIPT, '--prefix-sha256', process.env.ONE01_K12_PREFIX_SHA256);
    }
    if (process.env.ONE01_K12_EXPECT_RESULT) args.push('--expect-result', process.env.ONE01_K12_EXPECT_RESULT);
    if (process.env.ONE01_K12_EXPECT_REASON) args.push('--expect-reason', process.env.ONE01_K12_EXPECT_REASON);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.outerManifestBound, true, 'Real manifest/tar identity prefix must succeed');
    assert.equal(receipt.childIssued, true); assert.equal(receipt.childSettled, true); assert.equal(receipt.rawChildrenAtReturn, 0);
    assert.equal(receipt.result, 'pass', 'The promised content command must return the expected bounded audit verdict');
    assert.equal(result.status, 0);
    return;
  }
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, 'Missing content command cannot satisfy a producer content gate');
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const report = JSON.parse(readFileSync(f.output, 'utf8'));
    assert.equal(report.schemaVersion, 1); assert.equal(report.auditProfile, 'native-binding-content-audit/1');
    assert.equal(report.result, 'pass'); assert.equal(report.reason, 'ok');
    assert.equal(report.bindingManifestSha256, f.manifestSha);
    assert.equal(report.artifacts.length, 3); assert.equal(report.files, 33);
    assert.equal(report.releaseAccepted, false);
  } finally { f.close(); }
});

const refusals = [
  ['pax-global-header', 'forbidden-metadata', 'global PAX metadata skipped before the first ordinary member'],
  ['gnu-private-header', 'private-content', 'GNU metadata private bytes discarded during name normalization'],
  ['gnu-undeclared-header', 'forbidden-metadata', 'unapproved GNU extension header despite an ordinary normalized member'],
  ['private-content', 'private-content', 'private key bytes in an otherwise allowed native module'],
  ['split-marker', 'private-content', 'private marker split across stream chunks'],
  ['workspace-content', 'private-content', 'explicit trusted workspace root in a native module'],
  ['temporary-source-content', 'private-content', 'declared producer temporary source path'],
  ['apple-sidecar', 'undeclared-file', 'undeclared Apple sidecar despite matching tar identity'],
  ['pax-provenance', 'forbidden-metadata', 'Apple provenance xattrs on a required file'],
  ['private-file', 'private-file', 'nested environment file absent from the public inventory'],
  ['tar-duplicate', 'unsafe-archive', 'duplicate tar member'],
  ['tar-traversal', 'unsafe-archive', 'tar path traversal'],
  ['tar-link', 'unsafe-archive', 'tar link at a required license path'],
  ['gzip-truncated', 'archive-corrupt', 'truncated gzip trailer after valid tar payload'],
  ['outer-digest', 'artifact-integrity', 'tar digest differing from the producer manifest'],
  ['schema-future', 'unsupported-schema', 'future manifest schema'],
  ['missing-license', 'inventory-mismatch', 'required packaged license omitted by the producer'],
  ['metadata-authority', 'metadata-invalid', 'packaged metadata claiming automatic authority'],
  ['jar-private-file', 'private-file', 'private receipt inside the decoded Kotlin JAR'],
  ['jar-private-content', 'private-content', 'private key bytes inside a decoded Kotlin class'],
  ['jar-missing-class', 'inventory-mismatch', 'missing declared public Kotlin class'],
  ['jar-crc', 'archive-corrupt', 'decoded Kotlin class CRC corruption'],
  ['jar-duplicate', 'unsafe-archive', 'duplicate Kotlin JAR member'],
  ['jar-link', 'unsafe-archive', 'Kotlin JAR Unix link member'],
  ['jar-compression', 'unsupported-compression', 'Kotlin JAR compression outside stored and deflated'],
  ['file-bound', 'limit-exceeded', 'native member exceeding the declared byte bound'],
] as const;
for (const [mode, reason, description] of refusals) {
  test(`native binding content refuses ${description}`, () => rejected(mode, reason));
}

test('native binding content preserves an existing receipt instead of overwriting it', () => {
  const f = fixture();
  try {
    writeFileSync(f.output, 'prior immutable receipt');
    const result = f.run();
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'output-exists');
    assert.equal(readFileSync(f.output, 'utf8'), 'prior immutable receipt');
  } finally { f.close(); }
});

test('native binding content refuses a symlinked archive before reading outside the artifact root', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'tarballs/one01-pointer-swift-1.0.0.tgz');
    const bytes = readFileSync(path), destination = join(f.root, 'owned-original.tgz');
    writeFileSync(destination, bytes); rmSync(path); symlinkSync(destination, path);
    const result = f.run();
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'unsafe-file');
    assert.equal(sha256(readFileSync(destination)), sha256(bytes));
  } finally { f.close(); }
});

test('native binding content bounds explicit workspace roots without serializing them', () => {
  const f = fixture();
  try {
    const extra = [];
    for (let index = 0; index < 4; index++) {
      const path = join(f.root, `workspace-${index}`); mkdirSync(path); extra.push('--workspace-root', path);
    }
    const result = f.run(extra);
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'invalid-arguments');
    assert.ok(!result.stdout.includes(f.root)); assert.ok(!result.stderr.includes(f.root));
  } finally { f.close(); }
});
