import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { runner, reportStartupFailure } from './cross-host-test-helpers.ts';

// Keep the independent keeper fixture out of the preceding native SIGKILL test's process.
test('owner abort after an actual keeper sample is issued awaits both preparation and native child settlement', async t => {
  const { runCrossHostWorkloadQualification } = await runner();
  const owner = new AbortController();
  const spawnDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  assert.ok(spawnDescriptor && typeof spawnDescriptor.value === 'function', 'Actual native child spawn is required');
  const originalSpawn = spawnDescriptor.value as (this: ChildProcess, ...args: unknown[]) => unknown;
  const sendDescriptors = new Map<ChildProcess, PropertyDescriptor>();
  const observed = new Set<ChildProcess>(), closed = new Set<ChildProcess>();
  const roles = new WeakMap<ChildProcess, 'source' | 'target'>();
  let sourceSamples = 0, issuedKeeperSample = false,
    targetLaunched = false, sampleWhileTargetPreparationPending = false;
  let failedRun: unknown;
  try {
    Object.defineProperty(ChildProcess.prototype, 'spawn', { ...spawnDescriptor, value: function (this: ChildProcess, ...args: unknown[]) {
      const result = Reflect.apply(originalSpawn, this, args);
      // Native setupChannel installs send on the actual instance during spawn;
      // observing a prototype send would miss every genuine IPC request.
      const sendDescriptor = Object.getOwnPropertyDescriptor(this, 'send');
      if (sendDescriptor && typeof sendDescriptor.value === 'function') {
        const originalSend = this.send;
        sendDescriptors.set(this, sendDescriptor);
        Object.defineProperty(this, 'send', { ...sendDescriptor, value: function (this: ChildProcess, ...sendArgs: Parameters<typeof originalSend>) {
          const message = sendArgs[0], fields = message !== null && typeof message === 'object' && !Array.isArray(message)
            ? message as Record<string, unknown> : undefined;
          if (fields?.kind === 'init' && typeof fields.hostId === 'string' && typeof fields.sessionId === 'string' && fields.sessionId.startsWith('cross-host-')) {
            if (!observed.has(this)) { observed.add(this); this.once('close', () => { closed.add(this); }); }
            if (fields.hostId === 'host-a' && fields.sessionId === 'cross-host-2') roles.set(this, 'source');
            if (fields.hostId === 'host-b' && fields.sessionId === 'cross-host-2-unrelated') roles.set(this, 'target');
          }
          const sent = originalSend.apply(this, sendArgs);
          if (roles.get(this) === 'target' && fields?.kind === 'launch') targetLaunched = true;
          if (roles.get(this) === 'source' && fields?.kind === 'sample' && ++sourceSamples === 2) {
            // Delegate the real keeper request before revoking the owner.
            issuedKeeperSample = true; sampleWhileTargetPreparationPending = !targetLaunched; owner.abort();
          }
          return sent;
        } as typeof originalSend });
      }
      return result;
    } });
    await assert.rejects(runCrossHostWorkloadQualification({ signal: owner.signal }).catch(error => { failedRun = error; throw error; }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(issuedKeeperSample, true, 'Rejection follows the actual delegated source request');
      assert.equal(owner.signal.aborted, true, 'The original caller owner was revoked');
      // The real host can report the fixed sample refusal before its close.
      return /retired|closed|cancelled|^Native host refused fixed sample$/i.test(error.message);
    });
    assert.equal(issuedKeeperSample, true, 'Actual source request, not a canceled placeholder');
    assert.equal(sampleWhileTargetPreparationPending, true, 'Real source sampling runs while the target preparation job is pending');
    assert.ok(observed.size >= 6, 'The loss scenario actually starts both independent hosts');
    assert.equal(closed.size, observed.size, 'No observed runtime child survives runner rejection');
  } catch (error) { reportStartupFailure(t, failedRun); throw error; }
  finally {
    Object.defineProperty(ChildProcess.prototype, 'spawn', spawnDescriptor);
    for (const [child, descriptor] of sendDescriptors) Object.defineProperty(child, 'send', descriptor);
  }
});
