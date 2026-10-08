import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('fixed C RSS process uses current public resource authority and settles Stop', () => {
  const run = spawnSync(process.execPath, ['tools/qa-native-resource-runtime.mjs', '--source'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.result, 'pass');
  assert.equal(result.native.profile, 'fixed-own-rss-c/1');
  assert.ok(result.native.rssBytes > 0);
  assert.equal(result.native.rawPending, 0);
  assert.equal(result.native.childAlive, false);
  assert.equal(result.native.oldHandleAccepted, false);
  assert.equal(result.native.copiedHandleAccepted, false);
});
