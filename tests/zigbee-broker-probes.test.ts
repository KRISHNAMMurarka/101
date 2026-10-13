import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zigbeeBrokerBinary } from '../tools/qa-zigbee2mqtt-bridge.mjs';

// Catch discarded native outcomes: a missing executable, nonzero help result,
// invalid help and a killed help probe must remain distinguishable in failure.
for (const kind of ['nonzero', 'invalid-help', 'timeout'] as const) {
  test(`broker discovery retains authentic bounded ${kind} probe diagnostics`, t => {
    const directory = mkdtempSync(join(tmpdir(), '101-zigbee-probes-'));
    const executable = join(directory, 'probe'), missing = join(directory, 'missing');
    const previous = process.env.MOSQUITTO_BIN, nativeSpawn = childProcess.spawnSync;
    const source = kind === 'timeout'
      ? "printf '%s' 'waiting-help'; printf '%s' 'waiting-error' >&2; exec /bin/sleep 30"
      : kind === 'nonzero'
        ? `printf '%s' '${'x'.repeat(20000)}help-tail'; printf '%s' '${'y'.repeat(20000)}error-tail' >&2; exit 17`
        : "printf '%s' 'unrelated help'; printf '%s' 'unrelated diagnostic' >&2";
    // These are native help-output controls, not Node startup tests. The fixed
    // POSIX producer preserves the same bytes, exit17 and real timeout signal.
    // exec keeps the sleeping timeout producer in the one owned child PID.
    writeFileSync(executable, `#!/bin/sh\n${source}\n`);
    chmodSync(executable, 0o700);
    // Only redirect installed fallback locations. Every outcome still comes
    // from the real synchronous native spawn, including timeout termination.
    t.mock.method(childProcess, 'spawnSync', (path: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) =>
      nativeSpawn(path === executable ? executable : missing, args, options));
    syncBuiltinESMExports();
    process.env.MOSQUITTO_BIN = executable;
    try {
      assert.throws(() => zigbeeBrokerBinary(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Existing local Mosquitto required; probes=/,
          'discovery discarded the actual native probe outcomes');
        const probes = JSON.parse(error.message.split('; probes=')[1]!) as Array<{
          path: string; timeoutMs: number; status: number | null; signal: string | null;
          error: { code: string } | null; stdout: string; stderr: string;
        }>;
        t.diagnostic(JSON.stringify({kind, probes, allSynchronousNativeCallsReturned: true}));
        assert.equal(probes.length, 5);
        const first = probes[0]!;
        assert.equal(first.path, executable);
        assert.equal(first.timeoutMs, 2000);
        assert.ok(first.stdout.length <= 8192);
        assert.ok(first.stderr.length <= 8192);
        if (kind === 'nonzero') {
          assert.equal(first.status, 17); assert.equal(first.signal, null); assert.equal(first.error, null);
          assert.ok(first.stdout.endsWith('help-tail')); assert.ok(first.stderr.endsWith('error-tail'));
        } else if (kind === 'timeout') {
          assert.equal(first.status, null); assert.equal(first.signal, 'SIGTERM');
          assert.equal(first.error?.code, 'ETIMEDOUT');
          assert.equal(first.stdout, 'waiting-help'); assert.equal(first.stderr, 'waiting-error');
        } else {
          assert.equal(first.status, 0); assert.equal(first.signal, null); assert.equal(first.error, null);
          assert.equal(first.stdout, 'unrelated help'); assert.equal(first.stderr, 'unrelated diagnostic');
        }
        for (const probe of probes.slice(1)) {
          assert.equal(probe.status, null); assert.equal(probe.signal, null);
          assert.equal(probe.error?.code, 'ENOENT');
        }
        return true;
      });
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (previous === undefined) delete process.env.MOSQUITTO_BIN;
      else process.env.MOSQUITTO_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
