import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clipboardNativeProbe } from '../tools/clipboard-probe.mjs';

test('clipboard compiler failure retains its actual native outcome', async t => {
  const nativeSpawn = childProcess.spawnSync, nativeDirectory = fs.mkdtempSync;
  const previousArgs = process.argv;
  const owned: string[] = [];
  let actual: ReturnType<typeof childProcess.spawnSync> | undefined;
  t.mock.method(fs, 'mkdtempSync', (prefix: string) => {
    const directory = nativeDirectory(prefix); owned.push(directory); return directory;
  });
  // Change only this command's arguments. Output/status come from the actual
  // Swift compiler; no native pasteboard process is constructed by this case.
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: object) => {
    assert.equal(command, '/usr/bin/swiftc');
    actual = nativeSpawn(command, ['--one01-unsupported-compiler-argument'], options);
    return actual;
  });
  syncBuiltinESMExports();
  process.argv = [process.execPath, join(import.meta.dirname, '../tools/qa-clipboard-resources.mjs'), '--source'];
  try {
    const qaUrl = new URL('../tools/qa-clipboard-resources.mjs?compiler-outcome-regression', import.meta.url);
    await assert.rejects(import(qaUrl.href), (error: unknown) => {
      assert.ok(actual && actual.status !== 0);
      assert.ok(error instanceof Error);
      t.diagnostic(JSON.stringify({ actualNativeWaitReturned: true, actual: {
        status: actual.status, signal: actual.signal, error: actual.error?.message ?? null,
        stdout: actual.stdout?.toString() ?? '', stderr: actual.stderr?.toString() ?? '',
      }, originalFailureMessage: error.message }));
      const prefix = 'Native clipboard probe failed; probe=';
      assert.ok(error.message.startsWith(prefix), 'compiler failure discarded the actual native outcome');
      const reported = JSON.parse(error.message.slice(prefix.length));
      assert.equal(reported.name, 'compile-private-pasteboard');
      assert.equal(reported.status, actual.status);
      assert.equal(reported.signal, actual.signal);
      assert.equal(reported.error, null);
      assert.equal(reported.timeoutMs, 30000);
      assert.equal(reported.stdout, actual.stdout?.toString() ?? '');
      assert.equal(reported.stderr, actual.stderr?.toString() ?? '');
      assert.ok(reported.elapsedMs >= 0);
      t.diagnostic(JSON.stringify({ actualNativeWaitReturned: true, reported }));
      return true;
    });
  } finally {
    process.argv = previousArgs;
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const directory of owned) {
      assert.ok(directory.includes('101-clipboard-resources-source-'));
      fs.rmSync(directory, { recursive: true, force: true });
      assert.equal(fs.existsSync(directory), false);
    }
    t.diagnostic(JSON.stringify({ ownedDirectories: owned, allOwnedDirectoriesRemoved: true }));
  }
});

test('clipboard diagnostics retain bounded tails from a genuine nonzero process', t => {
  const source = "process.stdout.write('x'.repeat(20000)+'stdout-tail');process.stderr.write('y'.repeat(20000)+'stderr-tail');process.exitCode=17;";
  assert.throws(() => clipboardNativeProbe('nonzero', process.execPath, ['-e', source],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const probe = JSON.parse(error.message.split('; probe=')[1]!);
    assert.equal(probe.status, 17); assert.equal(probe.signal, null); assert.equal(probe.error, null);
    assert.equal(probe.stdoutBytes, 20011); assert.equal(probe.stderrBytes, 20011);
    assert.equal(probe.stdout.length, 8192); assert.equal(probe.stderr.length, 8192);
    assert.ok(probe.stdout.endsWith('stdout-tail')); assert.ok(probe.stderr.endsWith('stderr-tail'));
    t.diagnostic(JSON.stringify({ actualNativeWaitReturned: true, status: probe.status,
      stdoutBytes: probe.stdoutBytes, stderrBytes: probe.stderrBytes, retainedTailBytes: 8192 }));
    return true;
  });
});

test('clipboard diagnostics preserve the actual five-second timeout termination', t => {
  const source = "process.stdout.write('waiting-out');process.stderr.write('waiting-error');setInterval(()=>{},1000);";
  assert.throws(() => clipboardNativeProbe('timeout', process.execPath, ['-e', source],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const probe = JSON.parse(error.message.split('; probe=')[1]!);
    assert.equal(probe.status, null); assert.equal(probe.signal, 'SIGTERM');
    assert.equal(probe.error.code, 'ETIMEDOUT'); assert.equal(probe.timeoutMs, 5000);
    assert.equal(probe.stdout, 'waiting-out'); assert.equal(probe.stderr, 'waiting-error');
    t.diagnostic(JSON.stringify({ actualNativeWaitReturned: true, probe }));
    return true;
  });
});

test('clipboard diagnostics distinguish a missing executable from timeout', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), '101-clipboard-probe-missing-'));
  try {
    assert.throws(() => clipboardNativeProbe('missing', join(directory, 'missing'), [],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      const probe = JSON.parse(error.message.split('; probe=')[1]!);
      assert.equal(probe.status, null); assert.equal(probe.signal, null);
      assert.equal(probe.error.code, 'ENOENT'); assert.equal(probe.stdout, ''); assert.equal(probe.stderr, '');
      t.diagnostic(JSON.stringify({ actualNativeWaitReturned: true, probe }));
      return true;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
