import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { findMqttBrokerBinary } from '../tools/mqtt-broker-binary.mjs';

for (const occupySelectedPort of [false, true])
 test(`owned broker launch error joins actual native close and removes its configuration${occupySelectedPort ? ' when its port is rebound' : ''}`, async t => {
  const binary = findMqttBrokerBinary();
  const directory = await mkdtemp(join(tmpdir(), '101-broker-launch-error-'));
  const executable = join(directory, 'mosquitto'), observationFile = join(directory, 'observation.json');
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<{ code: number | null; signal: string | null }> | undefined;
  let observation: { nativeErrorCode?: string; nativeClosed?: boolean; configurationDirectory?: string; directoryPresentAtClose?: boolean; rejected?: boolean; listenerBound?: boolean; brokerReturned?: boolean } = {};
  try {
    await copyFile(binary.path, executable);
    const code = `
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { startOwnedMqttBroker } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'tools/qa-mqtt-connector.mjs')).href)};
const executable = ${JSON.stringify(realpathSync(executable))}, observationFile = ${JSON.stringify(observationFile)};
const occupySelectedPort = ${JSON.stringify(occupySelectedPort)};
let listener;
const observation = {}, save = () => writeFileSync(observationFile, JSON.stringify(observation));
const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
const nativeSpawn = descriptor.value;
Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function(options) {
  if (options.file !== executable || !options.args.includes('-c')) return Reflect.apply(nativeSpawn, this, [options]);
  observation.configurationDirectory = dirname(options.args[options.args.indexOf('-c') + 1]);
  // The actual copied executable passes strict help admission, then disappears
  // at its real native launch boundary. The OS supplies the genuine ENOENT.
  if (occupySelectedPort) {
    const config = options.args[options.args.indexOf('-c') + 1];
    const port = Number(readFileSync(config, 'utf8').match(/^listener (\\d+) 127\\.0\\.0\\.1/m)[1]);
    listener = createServer(socket => socket.destroy());
    listener.once('error', error => { observation.listenerError = error.code; save(); });
    listener.listen(port, '127.0.0.1', () => { observation.listenerBound = true; save(); });
  }
  rmSync(executable); save();
  const result = Reflect.apply(nativeSpawn, this, [options]);
  const nativeEmit = this.emit;
  this.emit = function(event, ...values) {
    if (event === 'error') { observation.nativeErrorCode = values[0].code; save(); }
    return Reflect.apply(nativeEmit, this, [event, ...values]);
  };
  this.once('close', () => {
    observation.nativeClosed = true;
    observation.directoryPresentAtClose = existsSync(observation.configurationDirectory); save();
  });
  return result;
} });
let broker;
try {
  await assert.rejects((async () => {
    broker = await startOwnedMqttBroker(); observation.brokerReturned = true; save();
  })(), /ENOENT/);
} finally {
  if (listener) await new Promise(resolve => listener.close(resolve));
  if (broker) await broker.close();
}
observation.rejected = true; save();
assert.equal(observation.nativeErrorCode, 'ENOENT');
assert.equal(observation.nativeClosed, true);
assert.equal(observation.directoryPresentAtClose, true);
assert.equal(existsSync(observation.configurationDirectory), false);
`;
    child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      env: { NODE_ENV: 'production', PATH: process.env.PATH, TMPDIR: tmpdir(), MOSQUITTO_BIN: executable },
      stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000,
    });
    let stderr = '';
    child.stderr!.on('data', value => { stderr = (stderr + value.toString()).slice(-8192); });
    child.on('error', () => {});
    closed = new Promise(resolve => child!.once('close', (exitCode, signal) => resolve({ code: exitCode, signal })));
    const outcome = await closed;
    if (existsSync(observationFile)) observation = JSON.parse(await readFile(observationFile, 'utf8'));
    t.diagnostic(JSON.stringify({ outcome, observation, stderr }));
    if (occupySelectedPort) assert.equal(observation.listenerBound, true, 'The separate real listener must bind the released port');
    assert.equal(observation.brokerReturned, undefined, 'Native launch failure cannot return a broker handle');
    assert.equal(observation.nativeErrorCode, 'ENOENT', 'The intended actual OS launch failure must execute');
    assert.deepEqual(outcome, { code: 0, signal: null }, 'The helper must reject without an unhandled native error');
    assert.equal(observation.rejected, true);
    assert.equal(observation.nativeClosed, true);
    assert.equal(observation.directoryPresentAtClose, true);
    assert.equal(existsSync(observation.configurationDirectory!), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (closed) await closed;
    if (existsSync(observationFile)) observation = JSON.parse(await readFile(observationFile, 'utf8'));
    if (observation.configurationDirectory) {
      assert.ok(observation.configurationDirectory.startsWith(join(tmpdir(), '101-a05-mqtt-')));
      await rm(observation.configurationDirectory, { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
