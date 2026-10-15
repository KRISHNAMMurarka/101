import assert from 'node:assert/strict';
import childProcess, { type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startOwnedMqttBroker } from '../tools/qa-mqtt-connector.mjs';

// Darwin's /bin/sh selects and re-execs another shell before this fixed producer.
const probeShell = process.platform === 'darwin' ? '/bin/dash' : '/bin/sh';

test('MQTT broker rejects failed real version help before launching an owned broker', async t => {
  const directory = mkdtempSync(join(tmpdir(), '101-mqtt-binary-'));
  const executable = join(directory, 'probe'), missing = join(directory, 'missing');
  const previous = process.env.MOSQUITTO_BIN;
  const nativeProbe = childProcess.spawnSync, nativeSpawn = childProcess.spawn;
  const closed: Promise<unknown>[] = [];
  let firstStatus: number | null | undefined, firstPid: number | undefined, launches = 0;
  writeFileSync(executable, `#!${probeShell}\nprintf 'mosquitto version 2.1.2\\n'\nexit 17\n`);
  chmodSync(executable, 0o700);
  t.mock.method(childProcess, 'spawnSync', (path: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
    const result = nativeProbe(path === executable ? executable : missing, args, options);
    if (path === executable) { firstStatus = result.status; firstPid = result.pid; }
    return result;
  });
  t.mock.method(childProcess, 'spawn', function (...args: unknown[]) {
    const child = Reflect.apply(nativeSpawn, childProcess, args);
    launches++; closed.push(new Promise(resolve => child.once('close', resolve)));
    return child;
  });
  syncBuiltinESMExports(); process.env.MOSQUITTO_BIN = executable;
  try {
    await assert.rejects(startOwnedMqttBroker(), (error: Error) => {
      const probes = JSON.parse(error.message.split('; probes=')[1]!);
      t.diagnostic(JSON.stringify({ firstStatus, firstPid, launches, probes }));
      assert.equal(firstStatus, 17, 'The real failed help producer must have executed');
      assert.equal(launches, 0, 'An unsuccessful help result cannot select a broker executable');
      assert.match(error.message, /Existing local Mosquitto required; probes=/);
      assert.ok(firstPid && firstPid > 0, 'The actual failed native help producer must have a PID');
      assert.equal(probes[0].pid, firstPid, 'Diagnostics must retain the actual native probe PID');
      assert.equal(probes[0].status, 17); assert.equal(probes[0].stdout, 'mosquitto version 2.1.2\n');
      assert.ok(probes.slice(1).every((probe: { error: { code: string } }) => probe.error.code === 'ENOENT'));
      return true;
    });
  } finally {
    await Promise.allSettled(closed); t.mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.MOSQUITTO_BIN; else process.env.MOSQUITTO_BIN = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

