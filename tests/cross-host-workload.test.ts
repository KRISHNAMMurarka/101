import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { ChildProcess } from 'node:child_process';
import { planRouteGroup } from '@101/connect';
import { describeCrossHostGroup } from '../examples/cross-host-workload/runtime-host.mjs';

const location = new URL('../examples/cross-host-workload/cross-host-workload.ts', import.meta.url);
async function runner() {
  const value = await import(location.href);
  assert.equal(typeof value.runCrossHostWorkloadQualification, 'function', 'Actual cross-host orchestration runner is required');
  return value as { runCrossHostWorkloadQualification(options: { signal: AbortSignal }): Promise<{
    profile: string; checks: readonly string[]; scenarios: readonly { hostPids: readonly number[]; effects: number; recoveryMs: readonly number[]; sourcePreparationFrameSequences: readonly number[] }[];
    scope: { unrelatedTargetPreparationDelayMs: number; sourcePreparationSamplingWaitMs: number };
    cleanup: { processes: number; callbacks: number; sockets: number; timers: number; fixturesRemoved: boolean };
  }> };
}
function reportStartupFailure(t: TestContext, error: unknown) {
  const diagnostics = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'startupDiagnostics')?.value : undefined;
  t.diagnostic(JSON.stringify({ kind: 'cross-host-startup', diagnostics: diagnostics ?? { retained: false } }));
}

test('independently executing authenticated runtime hosts transfer native state and recover with fresh authority', async t => {
  const { runCrossHostWorkloadQualification } = await runner();
  const result = await runCrossHostWorkloadQualification({ signal: new AbortController().signal })
    .catch(error => { reportStartupFailure(t, error); throw error; });
  assert.equal(result.profile, 'loopback-node-workload-handoff/1');
  assert.equal(result.scenarios.length, 3);
  for (const scenario of result.scenarios) {
    assert.ok(new Set(scenario.hostPids).size >= 2, 'Distinct native runtime host PIDs');
    assert.ok(scenario.effects > 0, 'Confirmed native effects, not only admission');
    for (const ms of scenario.recoveryMs) assert.ok(Number.isFinite(ms) && ms >= 0);
  }
  assert.ok(result.checks.includes('compatible-native-state-continuity'));
  assert.ok(result.checks.includes('target-format-refused-before-native-stage'));
  assert.ok(result.checks.includes('owner-denial-zero-new-native-input'));
  assert.ok(result.checks.includes('lost-host-fresh-identity-and-consent'));
  assert.ok(result.checks.includes('source-native-frames-current-during-controlled-target-preparation'));
  assert.equal(result.scope.unrelatedTargetPreparationDelayMs, 650);
  assert.equal(result.scope.sourcePreparationSamplingWaitMs, 150);
  for (const [index, scenario] of result.scenarios.entries()) {
    if (index < 2) assert.equal(scenario.sourcePreparationFrameSequences.length, 0);
    else {
      assert.ok(scenario.sourcePreparationFrameSequences.length > 0, 'Controlled preparation confirms fresh native frames');
      for (const [position, sequence] of scenario.sourcePreparationFrameSequences.entries()) {
        assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
        if (position > 0) assert.ok(sequence > scenario.sourcePreparationFrameSequences[position - 1]!);
      }
    }
  }
  assert.deepEqual(result.cleanup, { processes: 0, callbacks: 0, sockets: 0, timers: 0, fixturesRemoved: true });
});

test('aborted or spoofed owner signals cannot acquire a native cross-host fixture', async () => {
  const { runCrossHostWorkloadQualification } = await runner();
  const owner = new AbortController(); owner.abort();
  Object.defineProperty(owner.signal, 'aborted', { value: false });
  await assert.rejects(runCrossHostWorkloadQualification({ signal: owner.signal }), /retired|signal/i);
  await assert.rejects(runCrossHostWorkloadQualification({ signal: { aborted: false } as AbortSignal }), /signal/i);
});

test('cancellation at the first actual bind retains ownership until native host and gateway teardown', async t => {
  const { runCrossHostWorkloadQualification } = await runner();
  const owner = new AbortController(), original = Server.prototype.listen;
  let binds = 0, failedRun: unknown;
  Server.prototype.listen = function (this: Server, ...args: Parameters<typeof original>) {
    const value = original.apply(this, args); binds++; owner.abort(); return value;
  } as typeof original;
  try {
    await assert.rejects(runCrossHostWorkloadQualification({ signal: owner.signal }).catch(error => { failedRun = error; throw error; }), /retired|cancelled/i);
    assert.equal(binds, 1, 'Abort must prevent a replacement or second fixture bind');
  } catch (error) { reportStartupFailure(t, failedRun); throw error; }
  finally { Server.prototype.listen = original; }
  const done = new AbortController(); done.abort();
  await assert.rejects(runCrossHostWorkloadQualification({ signal: done.signal }), /retired|signal/i);
});


test('fixed actual host group producer satisfies the public route-group schema', () => {
  // These are inert clock-schema inputs in the actual native producer's closed
  // format. This pure contract test does not claim an observed native clock.
  const clockSchema = { sourceClockId: 'hosted-raster:1:1', receiptClockId: 'hosted-receipt:1:0000000000000000' };
  for (const id of ['host-a', 'host-b', 'host-c']) {
    const produced = describeCrossHostGroup(id, clockSchema);
    const plan = planRouteGroup(produced.contract, produced.devices);
    assert.equal(plan.id, 'example:host-group-' + id);
    assert.equal(plan.members.length, 2);
    assert.equal(plan.requiredOperations.length, 4);
    assert.deepEqual(plan.startupOrder, ['cursor-input', 'raster-output']);
  }
});

test('unexpected actual runtime-host startup failure retains bounded clock milestones and cleanup', async () => {
  const { runCrossHostWorkloadQualification } = await runner();
  const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  assert.ok(descriptor && typeof descriptor.value === 'function');
  const original = descriptor.value as (this: ChildProcess, ...args: unknown[]) => unknown;
  const observed = new Set<ChildProcess>(); let closed = false;
  try {
    Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function (this: ChildProcess, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (!observed.size && this.spawnargs.some(value => value.endsWith('/runtime-host.mjs'))) {
        observed.add(this); this.once('close', () => { closed = true; }); this.kill('SIGKILL');
      }
      return result;
    } });
    await assert.rejects(runCrossHostWorkloadQualification({ signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /native runtime host unavailable/i);
      const diagnostic = (error as Error & { startupDiagnostics?: {
        hosts: readonly { spawnEnteredAt: number; spawnReturnedAt: number; closeAt: number; signalCode: string;
          milestones: readonly { event: string; childAt: number; receivedAt: number }[] }[];
        cleanup: { processes: number; callbacks: number; sockets: number; timers: number; fixturesRemoved: boolean };
      } }).startupDiagnostics;
      assert.ok(diagnostic, 'Actual startup rejection must retain bounded non-sensitive diagnostics');
      assert.equal(diagnostic.hosts.length, 1);
      const host = diagnostic.hosts[0]!;
      assert.ok(host.spawnEnteredAt <= host.spawnReturnedAt && host.spawnReturnedAt <= host.closeAt);
      assert.equal(host.signalCode, 'SIGKILL'); assert.ok(host.milestones.length <= 3);
      assert.deepEqual(diagnostic.cleanup, { processes: 0, callbacks: 0, sockets: 0, timers: 0, fixturesRemoved: true });
      return true;
    });
    assert.equal(observed.size, 1); assert.equal(closed, true, 'Actual owned host has closed before diagnostic rejection');
  } finally { Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor); }
});

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
