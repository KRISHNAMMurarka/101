import { parseWorkloadRequirements, snapshotJson } from '@101/device-model';
import type { JsonValue } from '@101/device-model';
import { createApplicationSnapshot, restoreApplicationSnapshot } from './application-snapshot.ts';

export interface HandoffEpoch {
  readonly hostId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  /** Gate every simulation turn and command dispatch, including queued work. */
  isCurrent(): boolean;
}
export interface HandoffHost {
  readonly id: string;
  readonly assets: unknown;
  /** Quiesce simulation and pending commands, then return application-owned state. */
  pause(epoch: HandoffEpoch, signal: AbortSignal): JsonValue | Promise<JsonValue>;
  /** Stage restored state and routes without issuing effects. */
  stage(state: JsonValue, epoch: HandoffEpoch): void | Promise<void>;
  /** Begin gated simulation only when epoch.isCurrent() is true. */
  resume(epoch: HandoffEpoch): void | Promise<void>;
  /** Retire the prior host after target staging. */
  stop(epoch: HandoffEpoch): void | Promise<void>;
  /** Idempotently discard an uncommitted or revoked epoch. */
  abort(epoch: HandoffEpoch): void | Promise<void>;
}
export type HandoffResult = Readonly<{ ok: true; hostId: string; epoch: number }> |
  Readonly<{ ok: false; reason: 'cancelled' | 'invalid-target' | 'invalid-snapshot' | 'transfer-failed' |
    'recovery-failed'; recovered: boolean }>;
export interface WorkloadHandoff {
  /** During transfer or after failed recovery, this token is already revoked. */
  authority(): HandoffEpoch;
  status(): Readonly<{ state: 'active' | 'transferring' | 'paused'; hostId?: string; epoch: number }>;
  transfer(target: HandoffHost): Promise<HandoffResult>;
  cancel(): boolean;
}
export interface WorkloadHandoffOptions {
  readonly workload: unknown;
  readonly context: unknown;
  readonly source: HandoffHost;
  readonly validateState: (state: JsonValue) => boolean;
}

interface OwnedEpoch { host: HandoffHost; token: HandoffEpoch; controller: AbortController }
const cancelled = Symbol('cancelled');
function validHost(value: unknown): value is HandoffHost {
  if (!value || typeof value !== 'object') return false;
  const host = value as Partial<HandoffHost>;
  return typeof host.id === 'string' && host.id.length > 0 && host.id.length <= 128 &&
    host.id.trim() === host.id && !Array.from(host.id).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    Array.isArray(host.assets) && host.assets.length <= 64 &&
    ['pause', 'stage', 'resume', 'stop', 'abort'].every(method => typeof host[method as keyof HandoffHost] === 'function');
}
function interrupted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancelled); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/** Trusted host adapter protocol with local epoch fencing; transport and host trust belong to the caller. */
export function createWorkloadHandoff(options: WorkloadHandoffOptions): WorkloadHandoff {
  if (!options || !validHost(options.source) || typeof options.validateState !== 'function')
    throw new TypeError('A trusted source host and state validator are required');
  const workload = snapshotJson(options.workload), context = snapshotJson(options.context);
  if (parseWorkloadRequirements(workload, context).restart.mode !== 'snapshot')
    throw new TypeError('Handoff requires a snapshot-capable workload');
  let sequence = 0;
  let current: OwnedEpoch | undefined;
  let lastToken!: HandoffEpoch;
  let state: 'active' | 'transferring' | 'paused' = 'active';
  let attempt: AbortController | undefined;
  function epoch(host: HandoffHost): OwnedEpoch {
    const controller = new AbortController(), number = ++sequence;
    const token: HandoffEpoch = Object.freeze({ hostId: host.id, epoch: number, signal: controller.signal,
      isCurrent: () => current?.token === token && !controller.signal.aborted });
    lastToken = token;
    return { host, token, controller };
  }
  current = epoch(options.source);
  const result = (reason: Extract<HandoffResult, { ok: false }>['reason'], recovered: boolean): HandoffResult =>
    Object.freeze({ ok: false, reason, recovered });
  return Object.freeze({
    authority: () => lastToken,
    status: () => Object.freeze({ state, ...(current && state === 'active' ? { hostId: current.host.id } : {}), epoch: sequence }),
    cancel(): boolean {
      if (state !== 'transferring' || !attempt) return false;
      attempt.abort();
      return true;
    },
    async transfer(target: HandoffHost): Promise<HandoffResult> {
      if (state !== 'active' || !current) return result('transfer-failed', false);
      if (!validHost(target) || target.id === current.host.id) return result('invalid-target', true);
      const source = current;
      const candidate = epoch(target);
      attempt = candidate.controller;
      state = 'transferring';
      source.controller.abort();
      current = undefined;
      let captured: JsonValue | undefined;
      let snapshot: ReturnType<typeof createApplicationSnapshot> | undefined;
      let reason: Extract<HandoffResult, { ok: false }>['reason'] = 'transfer-failed';
      try {
        captured = await source.host.pause(source.token, candidate.controller.signal);
        if (candidate.controller.signal.aborted) throw cancelled;
        snapshot = createApplicationSnapshot(workload, context, captured);
        const restored = await interrupted(restoreApplicationSnapshot(workload, context, snapshot, target.assets,
          options.validateState), candidate.controller.signal);
        if (!restored.ok) { reason = 'invalid-snapshot'; throw new Error(restored.reason); }
        const staged = Promise.resolve().then(() => target.stage(restored.state, candidate.token));
        void staged.then(async () => {
          if (candidate.controller.signal.aborted) await target.abort(candidate.token);
        }).catch(() => {});
        await interrupted(staged, candidate.controller.signal);
        // A late source stop could retire a recovered epoch. Wait for its acknowledgement.
        await source.host.stop(source.token);
        if (candidate.controller.signal.aborted) throw cancelled;
        current = candidate;
        // Do not recover source while a late target resume could still start simulation.
        await target.resume(candidate.token);
        if (candidate.controller.signal.aborted) throw cancelled;
        state = 'active'; attempt = undefined;
        return Object.freeze({ ok: true, hostId: target.id, epoch: candidate.token.epoch });
      } catch (error) {
        if (error === cancelled || candidate.controller.signal.aborted) reason = 'cancelled';
        candidate.controller.abort();
        current = undefined;
        try { await target.abort(candidate.token); }
        catch {
          state = 'paused'; attempt = undefined;
          return result('recovery-failed', false);
        }
        const rollback = epoch(source.host);
        try {
          if (snapshot) {
            const restored = await restoreApplicationSnapshot(workload, context, snapshot, source.host.assets,
              options.validateState);
            if (!restored.ok) throw new Error(restored.reason);
            await source.host.stage(restored.state, rollback.token);
          }
          current = rollback;
          await source.host.resume(rollback.token);
          state = 'active'; attempt = undefined;
          return Object.freeze(result(reason, true));
        } catch {
          rollback.controller.abort(); current = undefined;
          try { await source.host.abort(rollback.token); } catch { /* Both epochs remain fenced. */ }
          state = 'paused'; attempt = undefined;
          return result('recovery-failed', false);
        }
      }
    },
  });
}
