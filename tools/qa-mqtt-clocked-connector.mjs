import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startOwnedMqttBroker } from './qa-mqtt-connector.mjs';
import { runClockedMqttConnectorExample } from '../examples/mqtt-connector/remote-clock-caller.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function childMessage(child, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`producer-${type}-timeout`)); }, timeoutMs);
    const receive = message => {
      if (message?.type === 'error') { cleanup(); reject(new Error(message.reason)); }
      else if (message?.type === type) { cleanup(); resolve(message); }
    };
    const exit = () => { cleanup(); reject(new Error(`producer-exited-before-${type}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); };
    child.on('message', receive); child.once('exit', exit);
  });
}

export async function runClockedMqttConnectorQa() {
  const broker = await startOwnedMqttBroker(), key = randomBytes(32);
  let child, childExited, childLog = '';
  try {
    child = fork(new URL('../examples/mqtt-connector/remote-clock-producer.mjs', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, MQTT_CLOCK_ENDPOINT: broker.endpoint, MQTT_CLOCK_KEY_HEX: key.toString('hex') } });
    child.stdout?.on('data', chunk => { childLog = (childLog + chunk.toString()).slice(-2048); });
    child.stderr?.on('data', chunk => { childLog = (childLog + chunk.toString()).slice(-2048); });
    childExited = new Promise(resolve => child.once('exit', resolve));
    const ready = await childMessage(child, 'ready');
    assert.notEqual(ready.pid, process.pid);
    const proof = await runClockedMqttConnectorExample(broker.endpoint, key, ready.clockId, child);
    return Object.freeze({ ...proof, broker: broker.version, producerPid: ready.pid, hostPid: process.pid,
      differentMonotonicOrigin: ready.offsetMs === 450000 });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : 'clocked-connector-qa'} ${JSON.stringify({ childLog })}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'close' });
      await Promise.race([childExited, delay(500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([childExited, delay(1000)]); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childExited; }
    }
    await broker.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runClockedMqttConnectorQa())); }
  catch (error) { console.error(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : 'clocked-connector-qa' })); process.exitCode = 1; }
}
