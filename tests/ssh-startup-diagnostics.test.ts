import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { createDisposableLoopbackSshHost } from '../examples/terminal-resources/disposable-host.mjs';

test('failed genuine SSH configuration validation preserves safe native diagnostics after cleanup', async t => {
  const original = childProcess.spawnSync;
  let ownedRoot: string | undefined, nativeStatus: number | null | undefined;
  t.mock.method(childProcess, 'spawnSync', function (...args: unknown[]) {
    const validation = args[0] === '/usr/sbin/sshd' && Array.isArray(args[1]) && args[1][0] === '-t';
    if (validation) {
      const configuration = (args[1] as string[])[2];
      assert.equal(typeof configuration, 'string');
      ownedRoot = dirname(configuration);
      appendFileSync(configuration, '101ControlledUnknownDirective yes\n');
    }
    // Execute the actual native validator and preserve its real result.
    const result = Reflect.apply(original, childProcess, args);
    if (validation) nativeStatus = result.status;
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createDisposableLoopbackSshHost(), (error: Error & { cause?: { stage: string; native: { kind: string; status: number | null }; cleanupCompleted: boolean } }) => {
      assert.equal(error.message, 'Owned SSH startup unavailable');
      assert.ok(ownedRoot); assert.equal(existsSync(ownedRoot), false);
      assert.equal(typeof nativeStatus, 'number'); assert.notEqual(nativeStatus, 0);
      assert.ok(error.cause, 'Native startup cause must survive the redacted public error');
      assert.equal(error.cause.stage, 'configuration-validation');
      assert.equal(error.cause.native.kind, 'sshd-validation'); assert.equal(error.cause.native.status, nativeStatus);
      assert.equal(error.cause.cleanupCompleted, true);
      assert.equal(JSON.stringify(error.cause).includes(ownedRoot), false);
      return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('failed actual SSH listener startup joins its owned cleanup exactly once', async t => {
  const original = childProcess.spawn;
  const nativeRemove = fsPromises.rm, removals: Promise<void>[] = [];
  let ownedRoot: string | undefined, nativeClosed = false, heldBytes = 0, ownedRemovals = 0;
  t.mock.method(fsPromises, 'rm', function (...args: unknown[]) {
    const result = Reflect.apply(nativeRemove, fsPromises, args);
    if (args[0] === ownedRoot) { ownedRemovals++; removals.push(result); }
    return result;
  });
  t.mock.method(childProcess, 'spawn', function (...args: unknown[]) {
    const child = Reflect.apply(original, childProcess, args);
    if (args[0] === '/usr/sbin/sshd' && Array.isArray(args[1]) && args[1][0] === '-D') {
      ownedRoot = dirname((args[1] as string[])[3]);
      child.once('close', () => { nativeClosed = true; });
      assert.ok(child.stderr);
      const nativeOn = child.stderr.on;
      t.mock.method(child.stderr, 'on', function (this: Readable, event: string, listener: (...args: unknown[]) => void) {
        // Drain genuine stderr but withhold its readiness delivery. No native
        // event or bytes are fabricated; the unchanged readiness bound expires.
        return Reflect.apply(nativeOn, this, [event, event === 'data'
          ? (chunk: Buffer) => { heldBytes += chunk.byteLength; }
          : listener]);
      });
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createDisposableLoopbackSshHost(), (error: Error & { cause?: { stage: string; listener: { outcome: string }; cleanupCompleted: boolean } }) => {
      assert.equal(error.message, 'Owned SSH startup unavailable');
      assert.ok(ownedRoot); assert.ok(heldBytes > 0); assert.equal(nativeClosed, true);
      assert.equal(existsSync(ownedRoot), false);
      assert.equal(ownedRemovals, 1, 'Failure must use the host cleanup owner instead of starting a second removal');
      assert.equal(error.cause?.stage, 'listener-startup'); assert.equal(error.cause?.listener.outcome, 'deadline');
      assert.equal(error.cause?.cleanupCompleted, true, 'Failure must join the existing owned cleanup before returning');
      return true;
    });
  } finally { await Promise.allSettled(removals); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
