import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('required watchOS check fails when its SDK prerequisite is absent', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), '101-watchos-path-'));
  try {
    const result = spawnSync(process.execPath, [resolve('tools/check-watchos-build.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: emptyPath }, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /watchOS SDK is required/i);
  } finally {
    rmSync(emptyPath, { recursive: true });
  }
});

test('only an explicitly optional watchOS check reports a skip', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), '101-watchos-path-'));
  try {
    const result = spawnSync(process.execPath, [resolve('tools/check-watchos-build.mjs'), '--optional'], {
      encoding: 'utf8', env: { ...process.env, PATH: emptyPath }, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /SKIP \(optional\): no watchOS SDK/i);
  } finally {
    rmSync(emptyPath, { recursive: true });
  }
});
