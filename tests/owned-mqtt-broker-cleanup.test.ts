import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { startOwnedMqttBroker } from '../tools/qa-mqtt-connector.mjs';

for (const failedStartup of [false, true])
  test(`owned MQTT broker joins actual close before ${failedStartup ? 'startup rejection' : 'concurrent shutdowns'} and directory removal`, async t => {
    const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
    assert.ok(descriptor && typeof descriptor.value === 'function');
    const nativeSpawn = descriptor.value as (this: ChildProcess, ...args: unknown[]) => unknown;
    const closes: Promise<void>[] = [], observations: { pid: number; directoryPresentAtClose?: boolean }[] = [];
    let directory: string | undefined, forwarded = false;
    Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function(this: ChildProcess, ...args: unknown[]) {
      const result = Reflect.apply(nativeSpawn, this, args);
      const config = this.spawnargs[this.spawnargs.indexOf('-c') + 1];
      if (this.spawnargs.includes('-c') && config?.includes('/101-a05-mqtt-')) {
        directory = dirname(config);
        const observation = { pid: this.pid! } as typeof observations[number];
        observations.push(observation);
        closes.push(new Promise(resolve => this.once('close', resolve)));
        const nativeEmit = this.emit; let held = false;
        this.emit = function(event: string | symbol, ...values: unknown[]) {
          if (event === 'close' && !held) {
            held = true;
            setTimeout(() => {
              observation.directoryPresentAtClose = existsSync(directory!);
              forwarded = true; Reflect.apply(nativeEmit, this, [event, ...values]);
            }, failedStartup ? 5000 : 500);
            return true;
          }
          return Reflect.apply(nativeEmit, this, [event, ...values]);
        };
        if (failedStartup) this.once('spawn', () => this.kill('SIGTERM'));
      }
      return result;
    } });
    let broker: Awaited<ReturnType<typeof startOwnedMqttBroker>> | undefined;
    try {
      if (failedStartup) {
        await assert.rejects(startOwnedMqttBroker(), error => {
          assert.equal(observations.length, 1, 'Startup control must reach an actual broker dispatch');
          assert.equal(forwarded, true, 'Startup rejection must join actual native close');
          return error instanceof Error;
        });
      } else {
        broker = await startOwnedMqttBroker();
        const results = await Promise.all([broker.close(), broker.close()].map(async completion => {
          await completion; return forwarded;
        }));
        assert.deepEqual(results, [true, true], 'Every overlapping shutdown must join actual native close');
      }
      assert.equal(observations.length, 1, 'Exactly one actual broker must be dispatched');
      assert.ok(observations[0]!.pid > 0);
      assert.equal(observations[0]!.directoryPresentAtClose, true, 'Owned directory must remain until actual native close');
      assert.equal(existsSync(directory!), false, 'Directory must be removed after settled cleanup');
    } finally {
      Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor);
      try { if (broker) await broker.close(); } finally { await Promise.all(closes); }
      t.diagnostic(JSON.stringify({ failedStartup, forwarded, observations, directoryRemoved: !!directory && !existsSync(directory) }));
    }
  });
