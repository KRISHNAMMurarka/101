import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This caller never launches the Hub, a webview, a listener, recording, or user-selected files.
// It qualifies the private macOS filesystem leaf, not an installed seven-package SDK API.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = 'desktop-local-replay-retention/1';
const inputs = [
  'apps/desktop-hub/src-tauri/src/replay_storage.rs',
  'apps/desktop-hub/src-tauri/src/storage.rs',
  'apps/desktop-hub/src-tauri/src/lib.rs',
  'apps/desktop-hub/src/types.ts',
  'apps/desktop-hub/src/main.ts',
  'apps/desktop-hub/src/style.css',
  'tools/qa-desktop-replay-retention.mjs',
];
const dependencies = [
  'apps/desktop-hub/src-tauri/Cargo.toml', 'apps/desktop-hub/src-tauri/Cargo.lock',
  'apps/desktop-hub/src-tauri/src/signaling.rs', 'apps/desktop-hub/src-tauri/build.rs',
  'apps/desktop-hub/src-tauri/tauri.conf.json', 'apps/desktop-hub/src-tauri/capabilities/default.json',
  'packages/input/src/index.ts', 'packages/replay/src/index.ts',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function pins(paths) {
  const result = {};
  for (const relative of paths) result[relative] = hash(await readFile(join(root, relative)));
  return result;
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; throw error; }
}
async function command(executable, args, environment, bound) {
  const child = spawn(executable, args, { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let bytes = 0; let timedOut = false;
  let timer; let killTimer;
  const settled = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });
  const stop = () => {
    if (child.pid && groupAlive(child.pid)) {
      process.kill(-child.pid, 'SIGTERM');
      // Schedule escalation before awaiting close; a TERM-ignoring child still
      // owns its process group and must actually settle within the cleanup budget.
      if (!killTimer) killTimer = setTimeout(() => {
        if (child.pid && groupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
      }, 1000);
    }
  };
  const chunk = (destination, data) => {
    bytes += data.byteLength;
    if (bytes > 262144) { stop(); return; }
    if (destination === 'out') output += data.toString('utf8'); else errors += data.toString('utf8');
  };
  child.stdout.on('data', (data) => chunk('out', data));
  child.stderr.on('data', (data) => chunk('err', data));
  let result;
  try {
    timer = setTimeout(() => { timedOut = true; stop(); }, bound);
    result = await settled;
  } finally { clearTimeout(timer); }
  // Cargo's logical exit does not stand in for its issued compiler/test children.
  const until = performance.now() + 5000;
  while (child.pid && groupAlive(child.pid) && performance.now() < until) {
    stop(); await new Promise((done) => setTimeout(done, 25));
  }
  const empty = !child.pid || !groupAlive(child.pid);
  clearTimeout(killTimer);
  assert.ok(empty, 'owned native process group did not actually settle; retain its scratch');
  return { ...result, pid: child.pid, actualProcessGroupEmpty: empty, timedOut, bytes, output, errors };
}
async function resolvedProducer(specifier, expected) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  assert.equal(hash(await readFile(resolved)), hash(await readFile(join(root, expected))), 'ordinary producer resolution differs from declared source bytes');
  return { specifier, resolved, sha256: hash(await readFile(resolved)) };
}

assert.deepEqual(process.argv.slice(2), ['--source'], 'only the fixed --source filesystem qualification is supported');
assert.equal(process.platform, 'darwin', 'selected macOS filesystem proof requires its actual target');
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'ambient Node loader overrides are not part of this proof');
const sourcePins = await pins(inputs);
const dependencyPins = await pins(dependencies);
const scratch = await realpath(await mkdtemp(join(tmpdir(), '101-desktop-replay-retention-')));
const fixture = join(scratch, 'producer.json');
const largeFixture = join(scratch, 'producer-large.json');
const sentinel = join(scratch, 'sentinel');
const receipt = { profile, mode: 'private-desktop-source/native-filesystem', node: process.version, platform: process.platform, architecture: process.arch, sourcePins, dependencyPins, status: 'failed', qualification: { nativeApp: false, browserUI: false, physical: false, sdkDistribution: false, externalBackupRollback: false, genericSecretExport: false }, cleanup: { compilerAndTestProcessGroupsEmpty: false, scratchRemoved: false, networkAndUIContextsCreated: 0 } };
let noProcesses = true;
try {
  receipt.producerResolutions = [
    await resolvedProducer('@101/input', 'packages/input/src/index.ts'),
    await resolvedProducer('@101/replay', 'packages/replay/src/index.ts'),
  ];
  const { normalizeInputFrame } = await import('@101/input');
  const { ReplayRecorder } = await import('@101/replay');
  const frame = normalizeInputFrame({ deviceId: 'keyboard-1', playerId: 'player-1', sequence: 1, timestamp: 2, source: 'keyboard', actions: { activate: true, pressure: 0.5 }, axes: { horizontal: 0.25 }, vectors: { aim: { x: 0.1, y: 0.2, z: 0.3 } }, poses: { hand: [1, 2, 3] } }, 3);
  const recorder = new ReplayRecorder('fixture-game', '1.0.0', 'fixed');
  recorder.recordFrame(frame); recorder.recordEvent('fixture', { privateOpaque: 'never-in-audit' });
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.schema, 1); assert.deepEqual(snapshot.frames[0], frame);
  const large = new ReplayRecorder('fixture-game', '1.0.0', 'fixed');
  large.recordFrame(frame); large.recordEvent('quota-fixture', 'x'.repeat(15 * 1024 * 1024));
  await writeFile(fixture, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
  await writeFile(largeFixture, JSON.stringify(large.snapshot()), { mode: 0o600, flag: 'wx' });
  await writeFile(sentinel, 'owned-sentinel', { mode: 0o600, flag: 'wx' });
  receipt.producer = { snapshotSha256: hash(await readFile(fixture)), snapshotBytes: (await stat(fixture)).size, largeSnapshotSha256: hash(await readFile(largeFixture)), largeSnapshotBytes: (await stat(largeFixture)).size, frames: snapshot.frames.length, events: snapshot.events.length, sourceTimestampsAreRetentionClock: false };
  const compilerCache = join(root, 'apps/desktop-hub/src-tauri/target');
  receipt.compilerCache = { path: compilerCache, retained: true, qualification: 'Cargo checks current locked inputs; cached dependency compilation is reused' };
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch, CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: compilerCache, REPLAY_PRODUCER_FIXTURE: fixture, REPLAY_PRODUCER_LARGE_FIXTURE: largeFixture };
  for (const executable of ['cargo', 'rustc']) {
    noProcesses = false;
    const version = await command(executable, ['--version'], environment, 10000);
    noProcesses = version.actualProcessGroupEmpty;
    assert.equal(version.code, 0); receipt[executable] = version.output.trim();
  }
  noProcesses = false;
  const native = await command('cargo', ['test', '--offline', '--locked', '--manifest-path', join(root, 'apps/desktop-hub/src-tauri/Cargo.toml'), '--lib', 'replay_storage::native::tests', '--', '--test-threads=1'], environment, 120000);
  noProcesses = native.actualProcessGroupEmpty;
  await writeFile(join(scratch, 'native.stdout.log'), native.output, { mode: 0o600 });
  await writeFile(join(scratch, 'native.stderr.log'), native.errors, { mode: 0o600 });
  receipt.native = { args: ['cargo', 'test', '--offline', '--locked', '--lib', 'replay_storage::native::tests', '--', '--test-threads=1'], code: native.code, signal: native.signal, timedOut: native.timedOut, actualProcessGroupEmpty: native.actualProcessGroupEmpty, stdoutSha256: hash(Buffer.from(native.output)), stderrSha256: hash(Buffer.from(native.errors)), logBytes: native.bytes };
  assert.equal(native.code, 0, 'native regression failed; stderr is retained in owned scratch');
  assert.ok(!native.timedOut && native.bytes <= 262144);
  const summary = /test result: ok\. (\d+) passed; 0 failed; 0 ignored;/.exec(native.output);
  assert.ok(summary, 'actual native test summary missing');
  assert.equal(Number(summary[1]), 14, 'all fixed native regressions are mandatory');
  receipt.native.passed = Number(summary[1]);
  assert.equal(await readFile(sentinel, 'utf8'), 'owned-sentinel');
  assert.deepEqual(await pins(inputs), sourcePins); assert.deepEqual(await pins(dependencies), dependencyPins);
  receipt.status = 'pass';
} catch (error) {
  receipt.failure = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'fixed caller failed' };
  process.exitCode = 1;
} finally {
  receipt.cleanup.compilerAndTestProcessGroupsEmpty = noProcesses;
  // Keep actual failure logs/scratch rather than erasing evidence or active native state.
  if (noProcesses && receipt.status === 'pass') { await rm(scratch, { recursive: true }); receipt.cleanup.scratchRemoved = true; }
  else receipt.retainedScratch = scratch;
  const serialized = `${JSON.stringify(receipt)}\n`;
  assert.ok(Buffer.byteLength(serialized) <= 16384, 'closed receipt including newline exceeds its byte cap');
  process.stdout.write(serialized);
}
