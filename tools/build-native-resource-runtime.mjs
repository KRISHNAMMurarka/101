import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['bindings/resource-runtime/c/one01_rss_runtime.h', 'bindings/resource-runtime/c/one01_rss_runtime.c',
  'bindings/resource-runtime/c/one01_rss_runtime_test.c', 'examples/native-resource-runtime/rss-agent.c',
  'examples/native-resource-runtime/process-port.mjs', 'examples/native-resource-runtime/consumer.mjs',
  'tools/qa-native-resource-runtime.mjs', 'tests/native-resource-runtime.test.ts', 'tools/build-native-resource-runtime.mjs', 'LICENSE'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))]));
mkdirSync(join(root, 'release'), { recursive: true });
const output = mkdtempSync(join(root, 'release', 'native-resource-runtime-'));
const packageRoot = join(output, 'one01-resource-runtime'), extracted = join(output, 'clean-consumer');
for (const directory of ['include', 'lib', 'share']) mkdirSync(join(packageRoot, directory), { recursive: true });
copyFileSync(join(root, paths[0]), join(packageRoot, 'include/one01_rss_runtime.h'));
copyFileSync(join(root, 'LICENSE'), join(packageRoot, 'LICENSE'));
const run = (program, args) => execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
const compiler = run('/usr/bin/xcrun', ['clang', '--version']).split('\n')[0];
const flags = ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-pedantic', '-O2',
  '-ffile-prefix-map=' + root + '=.', '-I', join(packageRoot, 'include')];
const object = join(output, 'one01_rss_runtime.o');
run('/usr/bin/xcrun', [...flags, '-c', join(root, paths[1]), '-o', object]);
run('/usr/bin/xcrun', ['ar', 'rcs', join(packageRoot, 'lib/libone01_rss_runtime.a'), object]);
const profile = { schemaVersion: 1, id: 'fixed-own-rss-c/1', version: '0.1.0', language: 'c11', target: 'macos-arm64',
  resources: [{ id: 'resident', operation: 'read', unit: 'By', producer: 'own-process-mach-task-info' }],
  lifecycle: ['inert-create', 'host-approved-start', 'host-approved-read', 'current-epoch', 'expiry', 'stop', 'destroy'],
  trust: 'Cooperative same-user host callbacks; local handles are not serialized credentials or a hostile-memory sandbox',
  limits: { generations: 2, readsPerGeneration: 32, registrationMs: 10000, readMs: 1000 },
  sourceSha256, compiler, license: 'MIT', excludes: ['other-os', 'swift-kotlin-api', 'physical-device', 'native-install-update', 'remote-authority'] };
writeFileSync(join(packageRoot, 'share/profile.json'), JSON.stringify(profile, null, 2) + '\n');
const expected = ['LICENSE', 'include/one01_rss_runtime.h', 'lib/libone01_rss_runtime.a', 'share/profile.json'];
function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), state = statSync(path), relative = prefix + name;
    return state.isDirectory() ? files(path, relative + '/') : [relative];
  });
}
assert.deepEqual(files(packageRoot).sort(), expected.sort());
const contents = Object.fromEntries(expected.map(path => {
  const bytes = readFileSync(join(packageRoot, path)); return [path, { sha256: hash(bytes), bytes: bytes.length }];
}));
const archive = join(output, 'one01-resource-runtime-macos-arm64-c-0.1.0.tar.gz');
run('tar', ['-czf', archive, '-C', packageRoot, ...expected]);
assert.deepEqual(run('tar', ['-tzf', archive]).trim().split('\n').sort(), expected.sort());
mkdirSync(extracted); run('tar', ['-xzf', archive, '-C', extracted]);
for (const path of expected) assert.equal(hash(readFileSync(join(extracted, path))), contents[path].sha256);
const testExecutable = join(output, 'clean-native-consumer');
run('/usr/bin/xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-pedantic',
  '-I', join(extracted, 'include'), join(root, paths[2]), join(extracted, 'lib/libone01_rss_runtime.a'), '-o', testExecutable]);
assert.equal(run(testExecutable, []).trim(), 'native-c-groups:denial,identity,read,stop,replacement,limit,reentrancy-thread-destroy');
const manifest = { schemaVersion: 1, status: 'pass', kind: 'selected-native-c-runtime', sourceRevision: run('git', ['rev-parse', 'HEAD']).trim(),
  sourceSha256, environment: { node: process.version, platform: process.platform, arch: process.arch, compiler },
  artifact: { path: archive, sha256: hash(readFileSync(archive)), bytes: statSync(archive).size, contents },
  cleanConsumer: { linked: true, actualRss: true, lifecycleChecks: 7 }, profile };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', manifestPath: join(output, 'manifest.json'), artifact: archive, cleanConsumer: manifest.cleanConsumer }));
