import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

function brokerExecutablePath(command) {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) return command;
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const path = resolve(directory, command);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; }
    catch { /* Keep searching native executable locations. */ }
  }
  return command;
}

/** Import is inert. Only this explicit call probes the existing local binary. */
export function findMqttBrokerBinary() {
  const probes = [];
  let binary;
  for (const path of [process.env.MOSQUITTO_BIN, '/opt/homebrew/opt/mosquitto/sbin/mosquitto', '/usr/sbin/mosquitto', '/usr/bin/mosquitto', 'mosquitto'].filter(Boolean)) {
    const executable = brokerExecutablePath(path), startedAtUnixMs = Date.now(), started = performance.now();
    const result = spawnSync(executable, ['-h'], { encoding: 'utf8', timeout: 2000 });
    const elapsedMs = performance.now() - started, endedAtUnixMs = Date.now();
    probes.push({ path, executablePath: executable, timeoutMs: 2000, elapsedMs,
      startedAtUnixMs, endedAtUnixMs, parentPid: process.pid,
      pid: result.pid, status: result.status, signal: result.signal,
      error: result.error ? { code: result.error.code, message: result.error.message.slice(0, 512) } : null,
      stdout: result.stdout?.slice(-8192) ?? '', stderr: result.stderr?.slice(-8192) ?? '' });
    if (result.status === 0 && result.stdout?.includes('mosquitto version')) {
      binary = { path: executable, version: result.stdout.trim().split('\n')[0] }; break;
    }
  }
  assert.ok(binary, `Existing local Mosquitto required; probes=${JSON.stringify(probes)}`);
  return Object.freeze({ ...binary, path: realpathSync(binary.path) });
}
