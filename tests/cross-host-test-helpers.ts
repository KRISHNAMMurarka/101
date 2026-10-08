import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

const location = new URL('../examples/cross-host-workload/cross-host-workload.ts', import.meta.url);
export async function runner() {
  const value = await import(location.href);
  assert.equal(typeof value.runCrossHostWorkloadQualification, 'function', 'Actual cross-host orchestration runner is required');
  return value as { runCrossHostWorkloadQualification(options: { signal: AbortSignal }): Promise<{
    profile: string; checks: readonly string[]; scenarios: readonly { hostPids: readonly number[]; effects: number; recoveryMs: readonly number[]; sourcePreparationFrameSequences: readonly number[] }[];
    scope: { unrelatedTargetPreparationDelayMs: number; sourcePreparationSamplingWaitMs: number };
    cleanup: { processes: number; callbacks: number; sockets: number; timers: number; fixturesRemoved: boolean };
  }> };
}
export function reportStartupFailure(t: TestContext, error: unknown) {
  const diagnostics = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'startupDiagnostics')?.value : undefined;
  t.diagnostic(JSON.stringify({ kind: 'cross-host-startup', diagnostics: diagnostics ?? { retained: false } }));
}
