import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { ChildProcess } from 'node:child_process';
import { planRouteGroup } from '@101/connect';
import { describeCrossHostGroup } from '../examples/cross-host-workload/runtime-host.mjs';

import { runner, reportStartupFailure } from './cross-host-test-helpers.ts';

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
