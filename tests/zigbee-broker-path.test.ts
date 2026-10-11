import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { zigbeeBrokerBinary } from '../tools/qa-zigbee2mqtt-bridge.mjs';

for (const mode of ['default-path', 'configured-name', 'cwd-shadow'] as const) {
  test(`broker discovery binds the actual PATH executable for ${mode}`, t => {
    const actual = zigbeeBrokerBinary();
    const directory = mkdtempSync(join(tmpdir(), '101-zigbee-path-'));
    const search = join(directory, 'search'), blocked = join(directory, 'blocked'), cwd = join(directory, 'cwd');
    for (const path of [search, blocked, cwd]) mkdirSync(path);
    const executable = join(search, 'mosquitto'), missing = join(directory, 'missing');
    symlinkSync(actual.path, executable);
    writeFileSync(join(blocked, 'mosquitto'), 'not executable\n', {mode: 0o600});
    chmodSync(join(blocked, 'mosquitto'), 0o600);
    if (mode === 'cwd-shadow') writeFileSync(join(cwd, 'mosquitto'), 'unrelated current-directory file\n');
    const previousPath = process.env.PATH, previousBinary = process.env.MOSQUITTO_BIN, previousCwd = process.cwd();
    const nativeSpawn = childProcess.spawnSync;
    const observations: unknown[] = [];
    t.mock.method(childProcess, 'spawnSync', (path: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      const result = nativeSpawn(path === 'mosquitto' || path === executable ? path : missing, args, options);
      observations.push({path, status: result.status, signal: result.signal, error: (result.error as NodeJS.ErrnoException | undefined)?.code,
        stdout: result.stdout?.slice(0,1000), stderr: result.stderr?.slice(0,1000)});
      return result;
    });
    syncBuiltinESMExports();
    process.env.PATH = blocked + delimiter + search;
    if (mode === 'configured-name') process.env.MOSQUITTO_BIN = 'mosquitto';
    else delete process.env.MOSQUITTO_BIN;
    process.chdir(cwd);
    try {
      const found = zigbeeBrokerBinary();
      assert.equal(found.path, realpathSync(executable), 'fingerprint must bind the executed PATH binary');
      assert.equal(found.version, actual.version);
    } finally {
      process.chdir(previousCwd);
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousBinary === undefined) delete process.env.MOSQUITTO_BIN; else process.env.MOSQUITTO_BIN = previousBinary;
      rmSync(directory, {recursive:true, force:true});
      t.diagnostic(JSON.stringify({mode, observations, allSynchronousNativeCallsReturned:true}));
    }
  });
}
