import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {command, fileHash, installedSdk, ordinaryFiles, sha256, withPublicCaller} from './build-pointer-bindings.mjs';

const root = resolve(import.meta.dirname, '..'), base = 'bindings/structured-telemetry';
export const C_STRUCTURED_BINDING_PATHS = Object.freeze([
  `${base}/c/profile.json`, `${base}/c/one01_structured_telemetry_wire.h`, `${base}/c/one01_structured_telemetry_wire.c`,
  `${base}/c/structured_telemetry_wire_test.c`, 'examples/language-bindings/structured-telemetry-consumer.c', 'tools/build-structured-telemetry-c.mjs',
]);
const sharedPaths = [`${base}/fixtures/page-readings-v1.json`, `${base}/fixtures/structured-telemetry-v1.json`,
  `${base}/fixtures/structured-telemetry-negative-v1.json`,
  'examples/language-bindings/structured-telemetry.mjs', 'tools/build-pointer-bindings.mjs', 'LICENSE'];
const producerPaths = ['packages/device-web/src/wire.ts', 'packages/device-model/src/sample.ts', 'packages/device-model/src/descriptor.ts'];
function encodingLine(packet) {
  const rows = Array.isArray(packet.value) ? packet.value : [packet.value], shape = Array.isArray(packet.value) ? `T ${rows.length}` : 'R';
  return `E ${packet.epoch} ${packet.slot} ${packet.sequence} ${packet.capturedAt} ${shape} ` +
    rows.flatMap(row => [row.step, row.mode, row.ready === undefined ? '-' : row.ready ? '1' : '0']).join(' ');
}
const boundarySource = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDeviceDescriptor,parseSignalValue,encodePacket,decodePacket} from '@101/connect';
const schema=JSON.parse(readFileSync(process.argv[2])), capability=parseDeviceDescriptor(schema.descriptor).capabilities.find(x=>x.id==='reading');
const value=parseSignalValue({step:Number.MIN_VALUE,mode:'count-up'},capability.value);
const wire=encodePacket({protocol:'connect',version:1,type:'sample',epoch:'0123456789abcdef0123456789abcdef',slot:1,sequence:1,capturedAt:Number.MIN_VALUE,value},'json/2');
const meaning=decodePacket(wire,'disposable').packet;
assert.equal(meaning.capturedAt,Number.MIN_VALUE);assert.equal(meaning.value.step,Number.MIN_VALUE);
if(process.argv[3]) {const output=readFileSync(process.argv[3],'utf8');assert.ok(Buffer.byteLength(output)<32768);const lines=output.trim().split('\\n').map(x=>JSON.parse(x));assert.equal(lines.length,2);
for(const result of lines){assert.ok(result&&typeof result.hex==='string'&&/^[a-f0-9]+$/.test(result.hex)&&result.hex.length<=8192&&result.hex.length%2===0);const decoded=decodePacket(Buffer.from(result.hex,'hex').toString('utf8'),'disposable');assert.equal(decoded.codec,'json/2');assert.deepEqual(decoded.packet,meaning);assert.deepEqual(result.packet,meaning);assert.deepEqual(parseSignalValue(decoded.packet.value,capability.value),value);}
console.log(JSON.stringify({result:'pass',reciprocalValues:1,commands:2,finiteMinimum:true}));
}else console.log(JSON.stringify({hex:Buffer.from(wire).toString('hex'),meaning}));
`;

export function buildStructuredTelemetryC(reference, sdkRoot, sdkManifest) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.match(reference, /^[a-f0-9]{40}$/);
  const tree = command('git', ['rev-parse', '--verify', `${reference}^{tree}`], {cwd: root}).trim(), sdk = installedSdk(sdkRoot, sdkManifest), selectedProducerSha256 = {};
  for (const path of producerPaths) {
    selectedProducerSha256[path] = sha256(execFileSync('git', ['show', `${tree}:${path}`], {cwd: root}));
    assert.equal(selectedProducerSha256[path], sdk.manifest.source.sha256[path]);
  }
  const output = mkdtempSync(join(root, 'release/structured-c-')), snapshot = join(output, 'source'), work = join(output, 'work'), artifact = join(output, 'c');
  for (const path of [snapshot, work, artifact]) mkdirSync(path);
  const sourceSha256 = {}, operations = [];
  function run(name, program, args, options = {}) {
    const {expectedExit = 0, ...childOptions} = options;
    const result = spawnSync(program, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, cwd: work, ...childOptions});
    const stdout = join(work, `${name}.stdout`), stderr = join(work, `${name}.stderr`);
    writeFileSync(stdout, result.stdout ?? '', {flag: 'wx'}); writeFileSync(stderr, result.stderr ?? '', {flag: 'wx'});
    operations.push({name, command: [program, ...args], exitCode: result.status, expectedExit, signal: result.signal,
      stdout: {path: stdout, sha256: fileHash(stdout)}, stderr: {path: stderr, sha256: fileHash(stderr)}});
    assert.ok(!result.error && !result.signal && result.status === expectedExit, `Owned ${name} failed; outputs retained`);
    return result.stdout;
  }
  function copy(from, to) {const target = join(artifact, to); mkdirSync(dirname(target), {recursive: true}); copyFileSync(join(snapshot, from), target);}
  try {
    for (const path of [...C_STRUCTURED_BINDING_PATHS, ...sharedPaths]) {
      const bytes = execFileSync('git', ['show', `${tree}:${path}`], {cwd: root, maxBuffer: 1048576}), target = join(snapshot, path);
      mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes); sourceSha256[path] = sha256(bytes);
    }
    assert.equal(fileHash(fileURLToPath(import.meta.url)), sourceSha256['tools/build-structured-telemetry-c.mjs']);
    assert.equal(fileHash(join(root, 'tools/build-pointer-bindings.mjs')), sourceSha256['tools/build-pointer-bindings.mjs']);
    const profile = JSON.parse(readFileSync(join(snapshot, C_STRUCTURED_BINDING_PATHS[0])));
    assert.equal(profile.artifactProfile, 'structured-telemetry-c-jansson/1'); assert.equal(profile.authority, 'inert-codec-only');
    assert.equal(profile.runtimeDependency.version, '2.15.1');
    for (const dependency of profile.runtimeDependency.files) assert.equal(fileHash(dependency.path), dependency.sha256);
    const clang = run('compiler-version', '/usr/bin/xcrun', ['clang', '--version']).trim(); assert.match(clang, /clang version 21\./);
    const schemaPath = join(snapshot, `${base}/fixtures/page-readings-v1.json`),
      fixturePath = join(snapshot, `${base}/fixtures/structured-telemetry-v1.json`),
      negativeFixturePath = join(snapshot, `${base}/fixtures/structured-telemetry-negative-v1.json`),
      fixtures = JSON.parse(readFileSync(fixturePath));
    const actual = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, caller) => JSON.parse(run('actual-sdk-producer', process.execPath, [caller, '--schema', schemaPath])));
    assert.deepEqual(actual, fixtures); assert.equal(fixtures.positive.length, 5);
    for (const [from, to] of [['LICENSE', 'LICENSE'], [C_STRUCTURED_BINDING_PATHS[0], 'assets/profile.json'],
      [`${base}/fixtures/page-readings-v1.json`, 'assets/page-readings-v1.json'], [`${base}/fixtures/structured-telemetry-v1.json`, 'assets/structured-telemetry-v1.json'],
      [`${base}/fixtures/structured-telemetry-negative-v1.json`, 'assets/structured-telemetry-negative-v1.json'],
      [C_STRUCTURED_BINDING_PATHS[1], 'include/one01_structured_telemetry_wire.h'], [C_STRUCTURED_BINDING_PATHS[2], 'source/one01_structured_telemetry_wire.c'],
      [C_STRUCTURED_BINDING_PATHS[3], 'source/structured_telemetry_wire_test.c'], [C_STRUCTURED_BINDING_PATHS[4], 'examples/structured-telemetry-consumer.c'],
      ['examples/language-bindings/structured-telemetry.mjs', 'examples/structured-telemetry.mjs']]) copy(from, to);
    mkdirSync(join(artifact, 'lib'));
    const flags = ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', join(artifact, 'include'), '-I', '/opt/homebrew/opt/jansson/include'], link = ['-L', '/opt/homebrew/opt/jansson/lib', '-ljansson', '-lm'];
    const object = join(work, 'codec.o'), library = join(artifact, 'lib/libone01_structured_telemetry.a');
    run('library-compile', '/usr/bin/xcrun', [...flags, '-c', join(artifact, 'source/one01_structured_telemetry_wire.c'), '-o', object]);
    run('library-archive', '/usr/bin/xcrun', ['ar', 'rcs', library, object]);
    const checks = join(work, 'checks'), caller = join(work, 'consumer');
    run('checks-compile', '/usr/bin/xcrun', [...flags, join(artifact, 'source/structured_telemetry_wire_test.c'), library, ...link, '-o', checks]);
    assert.equal(run('native-checks', checks, [], {env: {...process.env,
      ONE01_STRUCTURED_FIXTURES: fixturePath, ONE01_STRUCTURED_NEGATIVE_FIXTURES: negativeFixturePath}}), 'selected-c-groups:8\n');
    run('ordinary-caller-compile', '/usr/bin/xcrun', [...flags, join(artifact, 'examples/structured-telemetry-consumer.c'), library, ...link, '-o', caller]);
    const lines = fixtures.positive.flatMap(entry => [`D disposable ${entry.hex}`, encodingLine(entry.meaning)]), input = lines.join('\n') + '\n';
    writeFileSync(join(work, 'input.txt'), input); run('reciprocal-native', caller, [], {input});
    const reciprocal = withPublicCaller(sdk, join(snapshot, 'examples/language-bindings/structured-telemetry.mjs'), (_, script) => JSON.parse(run('actual-sdk-reciprocal', process.execPath, [script, '--schema', schemaPath, '--verify-native', join(work, 'reciprocal-native.stdout')])));
    assert.equal(reciprocal.result, 'pass');
    const boundary = join(work, 'finite-boundary.mjs'); writeFileSync(boundary, boundarySource);
    const minimum = withPublicCaller(sdk, boundary, (_, script) => JSON.parse(run('actual-minimum-producer', process.execPath, [script, schemaPath])));
    const minimumInput = `D disposable ${minimum.hex}\n${encodingLine(minimum.meaning)}\n`; writeFileSync(join(work, 'minimum-input.txt'), minimumInput);
    run('finite-minimum-native', caller, [], {input: minimumInput});
    const finiteMinimum = withPublicCaller(sdk, boundary, (_, script) => JSON.parse(run('actual-minimum-reciprocal', process.execPath, [script, schemaPath, join(work, 'finite-minimum-native.stdout')])));
    assert.equal(finiteMinimum.result, 'pass');
    assert.equal(run('wrong-lane', caller, [], {input: `D reliable ${fixtures.positive[0].hex}\n`}), 'null\n');
    assert.equal(run('command-boundary', caller, [], {input: 'invalid\n'.repeat(128)}), 'null\n'.repeat(128));
    assert.equal(run('command-overflow', caller, [], {input: 'invalid\n'.repeat(129), expectedExit: 2}), 'null\n'.repeat(128));
    assert.equal(run('line-boundary', caller, [], {input: 'x'.repeat(16384) + '\n'}), 'null\n');
    assert.equal(run('line-overflow', caller, [], {input: 'x'.repeat(16385) + '\n', expectedExit: 2}), '');
    assert.equal(run('unterminated-line', caller, [], {input: lines[0], expectedExit: 2}), '');
    assert.equal(run('total-input-overflow', caller, [], {input: ('x'.repeat(16384) + '\n').repeat(65), expectedExit: 2}), 'null\n'.repeat(63));
    const closedPipe = 'import subprocess,sys; p=subprocess.Popen([sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE); p.stdout.close(); p.stdout=None; out,err=p.communicate(input=b"invalid\\n",timeout=5); assert p.returncode==2 and not err; print("closed-output-exit:2")';
    assert.equal(run('closed-output', '/usr/bin/python3', ['-c', closedPipe, caller]), 'closed-output-exit:2\n');
    const files = ordinaryFiles(artifact).map(path => ({path: path.slice(artifact.length + 1), bytes: readFileSync(path).length, sha256: fileHash(path)}));
    assert.equal(files.length, 11, 'Own thin module/source/assets only; external Jansson is not packaged');
    const tarball = join(output, 'one01-structured-telemetry-c-1.0.0.tgz');
    run('local-package', 'tar', ['--format=ustar', '-czf', tarball, '-C', artifact, '.'], {env: {...process.env, COPYFILE_DISABLE: '1'}});
    const manifest = {schemaVersion: 1, result: 'pass', profile: profile.profile, artifactProfile: profile.artifactProfile,
      source: {tree, sha256: sourceSha256}, sdk: {manifestSha256: sdk.manifestSha256, selectedProducerSha256},
      toolchain: {clang, standard: 'C11', runtime: 'Darwin', arch: 'arm64'}, runtimeDependency: profile.runtimeDependency,
      dependencyLibraryPackaged: false, target: profile.declaredTarget, authority: profile.authority, exclusions: profile.excluded,
      nativeTestGroups: 8, reciprocal, finiteMinimum, wrongLaneRejected: true, cliFramingChecks: 6, closedOutputExitCode: 2, files,
      tarball: {path: tarball, sha256: fileHash(tarball)}, operations};
    const manifestPath = join(output, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'}); return {manifest: manifestPath, ...manifest};
  } catch (cause) {writeFileSync(join(output, 'failure.json'), JSON.stringify({schemaVersion: 1, result: 'fail', tree, sourceSha256, operations}, null, 2) + '\n', {flag: 'wx'}); throw cause;}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); assert.ok(args.length === 5 && args[1] === '--sdk-root' && args[3] === '--sdk-manifest');
  console.log(JSON.stringify(buildStructuredTelemetryC(args[0], args[2], args[4]), null, 2));
}
