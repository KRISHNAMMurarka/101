import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before, after } from 'node:test';
import { startOwnedMqttBroker } from '../tools/qa-mqtt-connector.mjs';
import { pathToFileURL } from 'node:url';
import { launchPeer } from '../examples/rosbridge-pose/consumer.mjs';
import { runOpcUaJsonTelemetryConsumer } from '../examples/opcua-json-telemetry/consumer.mjs';
import { runZigbee2MqttBridgeConsumer } from '../examples/zigbee2mqtt-bridge/consumer.mjs';

let broker: Awaited<ReturnType<typeof startOwnedMqttBroker>>;
before(async () => { broker = await startOwnedMqttBroker(); });
after(async () => { await broker?.close(); });

const fixtures = [
  { name: 'ROS peer', program: '/examples/rosbridge-pose/peer.mjs', run: () => launchPeer(), startupFailure: false },
  { name: 'OPC UA producer', program: '/examples/opcua-json-telemetry/producer.mjs', run: () => runOpcUaJsonTelemetryConsumer(broker.endpoint), startupFailure: true },
  { name: 'Zigbee producer', program: '/examples/zigbee2mqtt-bridge/producer.mjs', run: () => runZigbee2MqttBridgeConsumer('mqtt://127.0.0.1:9'), startupFailure: true },
];
for (const fixture of fixtures) for (const source of ['execArgv', 'NODE_OPTIONS'] as const)
 test(`fixed ${fixture.name} excludes caller ${source} preload at actual dispatch`, async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-producer-arguments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'caller-preload-ran'), preload = join(directory, 'caller-preload.mjs');
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'unrelated caller preload');
throw Error('Caller-only preload reached the fixed producer');
`);
  const previous = [...process.execArgv], previousOptions = process.env.NODE_OPTIONS;
  const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  assert.ok(descriptor && typeof descriptor.value === 'function');
  const nativeSpawn = descriptor.value as (this: ChildProcess, ...args: unknown[]) => unknown;
  const observations: { pid: number; inheritedPreload: boolean }[] = [], closes: Promise<void>[] = [];
  Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function(this: ChildProcess, ...args: unknown[]) {
    const result = Reflect.apply(nativeSpawn, this, args);
    if (this.spawnargs.some(value => value.endsWith(fixture.program))) {
      closes.push(new Promise(resolve => this.once('close', resolve)));
      observations.push({ pid: this.pid!, inheritedPreload: this.spawnargs.includes(pathToFileURL(preload).href) ||
        (args[0] as { envPairs: string[] }).envPairs.some(value => value.startsWith('NODE_OPTIONS=') && value.includes(pathToFileURL(preload).href)) });
      // Broker-independent invocation/failed-start coverage. ROS additionally
      // reaches its actual ready endpoint and returns its final closure report.
      if (fixture.startupFailure) this.once('spawn', () => this.kill('SIGTERM'));
    }
    return result;
  } });
  let peer: Awaited<ReturnType<typeof launchPeer>> | undefined, failure: unknown;
  if (source === 'execArgv') process.execArgv.push('--import', pathToFileURL(preload).href);
  else process.env.NODE_OPTIONS = '--import=' + pathToFileURL(preload).href;
  try {
    try { const result = await fixture.run(); if (!fixture.startupFailure) peer = result as typeof peer; } catch (error) { failure = error; }
    t.diagnostic(JSON.stringify({ observations, callerPreloadRan: existsSync(marker), peerReady: !!peer, controlledStartupFailure: fixture.startupFailure }));
    assert.equal(observations.length, 1, 'The real fixed producer must be dispatched once');
    assert.ok(observations[0]!.pid > 0, 'The actual native spawn returned a PID');
    assert.equal(observations[0]!.inheritedPreload, false, 'Fixed producer arguments/environment must exclude caller-only preload');
    assert.equal(existsSync(marker), false, 'Unrelated caller code must not execute in the fixed producer');
    if (fixture.startupFailure) assert.ok(failure instanceof Error, 'The actual killed child must retain startup failure');
    else {
      assert.equal(failure, undefined, 'The real peer must reach readiness under its original limit');
      assert.ok(peer);
      const report = await peer.close();
      assert.deepEqual({ rawSockets: report.rawSockets, peers: report.peers, timers: report.timers, listener: report.listener, failure: report.failure },
        { rawSockets: 0, peers: 0, timers: 0, listener: false, failure: null });
    }
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...previous);
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor);
    try { if (peer) await peer.close(); } finally { await Promise.all(closes); }
  }
});

test('failed OPC UA producer startup joins actual held native close before returning', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  assert.ok(descriptor && typeof descriptor.value === 'function');
  const nativeSpawn = descriptor.value as (this: ChildProcess, ...args: unknown[]) => unknown;
  let forwarded = false, dispatched = false, returnedBeforeClose: boolean | undefined;
  const closes: Promise<void>[] = [];
  Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function(this: ChildProcess, ...args: unknown[]) {
    const result = Reflect.apply(nativeSpawn, this, args);
    if (this.spawnargs.some(value => value.endsWith('/examples/opcua-json-telemetry/producer.mjs'))) {
      dispatched = true; const nativeEmit = this.emit; let held = false;
      closes.push(new Promise(resolve => this.once('close', resolve)));
      this.emit = function(event: string | symbol, ...values: unknown[]) {
        if (event === 'close' && !held) { held = true;
          setTimeout(() => { forwarded = true; Reflect.apply(nativeEmit, this, [event, ...values]); }, 1000); return true;
        }
        return Reflect.apply(nativeEmit, this, [event, ...values]);
      };
      this.once('spawn', () => this.kill('SIGTERM'));
    }
    return result;
  } });
  try {
    await assert.rejects(runOpcUaJsonTelemetryConsumer(broker.endpoint), (error: unknown) => {
      returnedBeforeClose = !forwarded; return error instanceof Error;
    });
    assert.equal(dispatched, true, 'The actual owned producer was dispatched');
    assert.equal(returnedBeforeClose, false, 'Startup rejection must follow actual native close settlement');
  } finally {
    Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor);
    await Promise.all(closes);
  }
});
