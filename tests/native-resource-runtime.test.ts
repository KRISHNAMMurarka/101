import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function qualify(checks: 'runtime' | 'observer-expiry') {
  const run = spawnSync(process.execPath, ['tools/qa-native-resource-runtime.mjs', '--source', '--checks', checks], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(run.status, 0, JSON.stringify({ status: run.status, signal: run.signal,
    error: run.error && { code: 'code' in run.error ? run.error.code : undefined,
      message: run.error.message }, stdout: run.stdout, stderr: run.stderr }));
  const result = JSON.parse(run.stdout);
  assert.equal(result.result, 'pass');
  assert.equal(result.checksGroup, checks);
  return result;
}

test('fixed C RSS process uses current public resource authority and settles Stop', () => {
  const result = qualify('runtime');
  assert.equal(result.native.profile, 'fixed-own-rss-c/1');
  assert.ok(result.native.rssBytes > 0);
  assert.equal(result.native.rawPending, 0);
  assert.equal(result.native.childAlive, false);
  assert.equal(result.native.oldHandleAccepted, false);
  assert.equal(result.native.copiedHandleAccepted, false);
  assert.deepEqual(result.reviewChecks, ['signal-only-grant-is-authority', 'reject-hidden-currentness-grant',
    'reject-forged-signal-grant', 'reentrant-Stop-authorizer-zero-child', 'registration-signal-abort-in-authorizer-zero-child',
    'registration-signal-abort-in-observer-fences-start', 'verified-launch-survives-source-modify',
    'verified-launch-survives-source-replace', 'opposite-registration-abort-in-read-authorizer-zero-native-read',
    'read-signal-abort-zero-native-read', 'read-approval-expiry-zero-native-read',
    'queued-native-start-expiry-before-activation', 'queued-native-read-expiry-before-capture']);
});

test('actual native observer reaches grant expiry and fences START before yielding', () => {
  const result = qualify('observer-expiry');
  assert.deepEqual(result.reviewChecks, ['post-observer-expiry-zero-native-start']);
});
