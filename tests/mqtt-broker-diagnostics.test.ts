import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { findMqttBrokerBinary } from '../tools/mqtt-broker-binary.mjs';

test('failed broker discovery reports the wall-clock bracket for each issued child', (t) => {
  const previousOverride = process.env.MOSQUITTO_BIN;
  delete process.env.MOSQUITTO_BIN;
  let issued = 0;
  const spawn = t.mock.method(childProcess, 'spawnSync', () => {
    const present = issued++ === 0;
    return {
      pid: present ? 2221 : 0, status: null, signal: present ? 'SIGTERM' : null,
      stdout: present ? '' : null, stderr: present ? '' : null,
      error: Object.assign(new Error(present ? 'spawnSync ETIMEDOUT' : 'spawnSync ENOENT'),
        { code: present ? 'ETIMEDOUT' : 'ENOENT' }),
    };
  });
  syncBuiltinESMExports();
  const before = Date.now();
  try {
    let failure: unknown;
    try { findMqttBrokerBinary(); } catch (error) { failure = error; }
    const after = Date.now();
    assert.ok(failure instanceof Error);
    const probes = JSON.parse(failure.message.split('probes=')[1]) as Array<{
      startedAtUnixMs: number; endedAtUnixMs: number; parentPid: number;
      pid: number; timeoutMs: number; elapsedMs: number; status: null;
      signal: string | null; error: { code: string }; stdout: string; stderr: string;
    }>;
    assert.equal(probes.length, 4);
    assert.equal(spawn.mock.calls.length, probes.length);
    for (const [index, probe] of probes.entries()) {
      assert.equal(typeof probe.startedAtUnixMs, 'number');
      assert.equal(typeof probe.endedAtUnixMs, 'number');
      assert.ok(probe.startedAtUnixMs >= before && probe.startedAtUnixMs <= after);
      assert.ok(probe.endedAtUnixMs >= before && probe.endedAtUnixMs <= after);
      assert.equal(probe.parentPid, process.pid);
      assert.equal(probe.timeoutMs, 2000);
      assert.ok(probe.elapsedMs >= 0);
      assert.equal(probe.status, null);
      assert.equal(probe.pid, index === 0 ? 2221 : 0);
      assert.equal(probe.signal, index === 0 ? 'SIGTERM' : null);
      assert.equal(probe.error.code, index === 0 ? 'ETIMEDOUT' : 'ENOENT');
      assert.equal(probe.stdout, '');
      assert.equal(probe.stderr, '');
      assert.deepEqual(spawn.mock.calls[index].arguments.slice(1),
        [['-h'], { encoding: 'utf8', timeout: 2000 }]);
    }
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    if (previousOverride === undefined) delete process.env.MOSQUITTO_BIN;
    else process.env.MOSQUITTO_BIN = previousOverride;
  }
});
