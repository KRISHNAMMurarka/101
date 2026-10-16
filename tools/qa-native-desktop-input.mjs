import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.deepEqual(process.argv.slice(2), ['--source']);
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const root = resolve(import.meta.dirname, '..');
const paths = ['apps/desktop-hub/src-tauri/src/native_input.rs',
  'apps/desktop-hub/src-tauri/src/native_input_approval.rs',
  'apps/desktop-hub/src-tauri/src/native_input_controller.rs',
  'tests/native-input-harness.rs', 'tests/native-input-controller-harness.rs'];
const hash = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(path)]));
const scratch = mkdtempSync(join(tmpdir(), '101-native-input-owned-'));
const run = (program, args) => execFileSync(program, args,
  { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'] });
const checks = [];
try {
  const compiler = run('rustc', ['--version']).trim();
  for (const [name, path, count] of [['backend', paths[3], 17], ['controller', paths[4], 11]]) {
    const executable = join(scratch, name);
    run('rustc', ['--edition=2021', '--test', join(root, path), '-o', executable]);
    const output = run(executable, ['--test-threads=1']);
    assert.match(output, new RegExp('test result: ok\\. ' + count + ' passed; 0 failed; 0 ignored'));
    checks.push({ name, count, output });
  }
  for (const [path, sha256] of Object.entries(sourceSha256)) assert.equal(hash(path), sha256);
  console.log(JSON.stringify({ status: 'pass', profile: 'macos-focused-native-input/1', compiler,
    sourceSha256, checks, scope: 'Actual native Rust implementation through injected test ports. No OS dialogs, event posting, device or installed-app claim.' }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
