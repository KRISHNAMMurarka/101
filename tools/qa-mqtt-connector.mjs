import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMqttConnectorExample } from '../examples/mqtt-connector/caller.mjs';

function pickBinary() {
  const candidates = [process.env.MOSQUITTO_BIN, '/opt/homebrew/opt/mosquitto/sbin/mosquitto', '/usr/sbin/mosquitto', '/usr/bin/mosquitto', 'mosquitto'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-h'], { encoding: 'utf8', timeout: 2000 });
    if (result.stdout?.includes('mosquitto version')) return { path: candidate, version: result.stdout.trim().split('\n')[0] };
  }
  throw new Error('A local Mosquitto executable is required; no service or image is started or downloaded.');
}
async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise(resolve => server.close(resolve)); return address.port;
}
async function waitReady(child, port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Owned Mosquitto process exited before readiness.');
    const ready = await new Promise(resolve => {
      const socket = tcpConnect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      setTimeout(() => { socket.destroy(); resolve(false); }, 150).unref();
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Owned Mosquitto did not bind its loopback listener in time.');
}

/** Starts one disposable foreground broker with an explicit loopback-only config. */
export async function startOwnedMqttBroker() {
  const binary = pickBinary(), directory = await mkdtemp(join(tmpdir(), '101-a05-mqtt-'));
  const port = await unusedLoopbackPort(), configPath = join(directory, 'mosquitto.conf');
  await writeFile(configPath, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\nmax_packet_size 16384\nmax_queued_messages 32\nmax_inflight_messages 4\nlog_dest stdout\n`, { mode: 0o600 });
  const child = spawn(binary.path, ['-c', configPath, '-v'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const append = chunk => { log = (log + chunk.toString('utf8')).slice(-8192); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await waitReady(child, port); }
  catch (error) { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : 'broker-start-failed'} ${log.slice(-2000)}`); }
  let closed = false;
  return Object.freeze({ endpoint: `mqtt://127.0.0.1:${port}`, version: binary.version, pid: child.pid,
    async close() {
      if (closed) return; closed = true;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const outcome = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(undefined), 1500))]);
        if (!outcome && child.exitCode === null) { child.kill('SIGKILL'); await exited; }
      }
      await rm(directory, { recursive: true, force: true });
    },
    logs: () => log,
  });
}

export async function runMqttConnectorQa() {
  const broker = await startOwnedMqttBroker();
  try {
    const result = await runMqttConnectorExample(broker.endpoint);
    return Object.freeze({ ...result, broker: Object.freeze({ version: broker.version, ownedPid: broker.pid,
      listener: '127.0.0.1 only', persistent: false, externalService: false }) });
  } finally { await broker.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runMqttConnectorQa())); }
  catch (error) { console.error(JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : 'mqtt-qa-failed' })); process.exitCode = 1; }
}
