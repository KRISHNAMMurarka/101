import { prepareOperatorStartup } from './operator-configuration.ts';
import type { OperatorConfigurationIssue, OperatorStartupController } from './operator-configuration.ts';

export const OPERATOR_IDENTITY_LIFECYCLE_PROFILE = 'operator-identity-replacement/1';
export const OPERATOR_IDENTITY_LIFECYCLE_LIMITS = Object.freeze({ attempts: 16, pending: 1, startupDeadlineMs: 5000 });
type Phase = 'prepared' | 'starting' | 'running' | 'replacing' | 'failed' | 'stopped';
type Code = 'configuration-invalid' | 'busy' | 'inactive' | 'capacity' | 'startup-failed' | 'startup-timeout' | 'stopped';
export interface OperatorIdentityIssue { readonly code: Code; readonly message: string; readonly recovery: string;
  readonly startupIssue?: OperatorConfigurationIssue }
export type OperatorIdentityResult = Readonly<{ ok: true; endpoint: string; generation: number }> |
  Readonly<{ ok: false; issue: OperatorIdentityIssue }>;
export interface OperatorIdentitySnapshot { readonly profile: typeof OPERATOR_IDENTITY_LIFECYCLE_PROFILE; readonly phase: Phase;
  readonly generation: number; readonly attempts: number; readonly pending: boolean; readonly timerArmed: boolean;
  readonly endpoint?: string; readonly issue?: OperatorIdentityIssue; readonly authorityCopied: false }
export interface OperatorIdentityController {
  start(): Promise<OperatorIdentityResult>;
  /** New validated owner/endpoint. No sessions, directory visibility, bearers or grants migrate. */
  rotate(configuration: unknown): Promise<OperatorIdentityResult>;
  /** Terminal revocation; waits for real owned native teardown, including an issued replacement. */
  stop(): Promise<void>;
  snapshot(): OperatorIdentitySnapshot;
}
interface Attempt { readonly epoch: number; target?: OperatorStartupController; readonly replacing: boolean;
  promise: Promise<OperatorIdentityResult>; settle(result: OperatorIdentityResult): void;
  expired: boolean; timer?: ReturnType<typeof setTimeout> }
const issues: Record<Code, readonly [string, string]> = {
  'configuration-invalid': ['The replacement configuration is invalid. The current owner is unchanged.', 'Review the reported startup requirement, then provide a complete current identity and enrollment snapshot.'],
  busy: ['An owned startup or replacement is still settling.', 'Wait for its actual completion or stop this lifecycle.'],
  inactive: ['There is no running owner to replace, or the initial startup has failed.', 'Start the prepared owner, or prepare a fresh lifecycle after a failed startup.'],
  capacity: ['This lifecycle has reached its attempt limit.', 'Stop it, then prepare a fresh validated lifecycle.'],
  'startup-failed': ['The selected owner could not start. A running incumbent is unchanged.', 'Use a different available local port and current credentials, then explicitly retry.'],
  'startup-timeout': ['Startup exceeded its deadline and teardown was requested.', 'Wait for native teardown, then explicitly retry with valid credentials and an available port.'],
  stopped: ['This identity lifecycle has stopped.', 'Prepare a fresh lifecycle and review its new endpoint. Old authority cannot be restored.'],
};
function issue(code: Code, startupIssue?: OperatorConfigurationIssue): OperatorIdentityIssue {
  return Object.freeze({ code, message: issues[code][0], recovery: issues[code][1], ...(startupIssue ? { startupIssue } : {}) });
}
const rejected = (problem: OperatorIdentityIssue): OperatorIdentityResult => Object.freeze({ ok: false, issue: problem });

/** Host-owned replacement of the existing closed loopback mTLS startup profile.
 * Candidate startup precedes incumbent retirement. Success is published only
 * after old native sockets/session authority have actually been destroyed.
 * Static-port collision is a readable failed candidate, never an implicit stop.
 * This does not load keys, manage an OS key store, migrate tenants or grant resources. */
export function prepareOperatorIdentityLifecycle(configuration: unknown):
  Readonly<{ ok: true; controller: OperatorIdentityController }> | Readonly<{ ok: false; issue: OperatorIdentityIssue }> {
  const prepared = prepareOperatorStartup(configuration);
  if (!prepared.ok) return Object.freeze({ ok: false, issue: issue('configuration-invalid', prepared.issue) });
  let owner = prepared.controller, pending: Attempt | undefined, closed = false, epoch = 0, attempts = 0, generation = 0;
  let phase: Phase = 'prepared', endpoint: string | undefined, problem: OperatorIdentityIssue | undefined, stopping: Promise<void> | undefined;
  const current = (record: Attempt) => !closed && pending === record && epoch === record.epoch && !record.expired;
  function disarm(record: Attempt) { if (record.timer !== undefined) clearTimeout(record.timer); record.timer = undefined; }
  function reserve(replacing: boolean): Attempt {
    let settle!: (result: OperatorIdentityResult) => void;
    const completion = new Promise<OperatorIdentityResult>(resolve => { settle = resolve; });
    const record: Attempt = { epoch: ++epoch, replacing, expired: false, promise: completion, settle };
    // Reserve actual completion before preparation/clock/native event callbacks can reenter.
    pending = record; phase = replacing ? 'replacing' : 'starting'; problem = undefined;
    record.promise = completion.then(result => {
      if (!closed && !result.ok) { problem = result.issue; phase = endpoint ? 'running' : 'failed'; }
      return result;
    }).finally(() => { disarm(record); if (pending === record) pending = undefined; });
    return record;
  }
  function begin(record: Attempt, target: OperatorStartupController): Promise<OperatorIdentityResult> {
    record.target = target;
    void Promise.resolve().then(async (): Promise<OperatorIdentityResult> => {
      try {
        if (!current(record)) { await target.stop(); return rejected(issue('stopped')); }
        record.timer = setTimeout(() => {
          if (!current(record)) return;
          record.expired = true; disarm(record); problem = issue('startup-timeout');
          void target.stop();
        }, OPERATOR_IDENTITY_LIFECYCLE_LIMITS.startupDeadlineMs);
        const started = await target.start();
        if (!current(record)) {
          await target.stop(); return rejected(issue(closed ? 'stopped' : 'startup-timeout'));
        }
        if (!started.ok) {
          if (target === owner) endpoint = undefined;
          await target.stop(); return rejected(issue('startup-failed', started.issue));
        }
        // The timer bounds candidate startup. Native incumbent teardown retains
        // its real reservation until settlement; it cannot be reported as running.
        disarm(record);
        if (record.replacing) {
          // A successful candidate cannot restore any incumbent authority after stop.
          endpoint = undefined;
          await owner.stop();
          if (!current(record)) { await target.stop(); return rejected(issue(closed ? 'stopped' : 'startup-timeout')); }
          const checked = await target.start();
          if (!current(record)) { await target.stop(); return rejected(issue('stopped')); }
          if (!checked.ok) { await target.stop(); return rejected(issue('startup-failed', checked.issue)); }
        }
        owner = target; endpoint = started.endpoint; if (generation === 0 || record.replacing) generation++;
        phase = 'running'; problem = undefined;
        return Object.freeze({ ok: true, endpoint, generation });
      } catch {
        if (target === owner) endpoint = undefined;
        await target.stop(); return rejected(issue(closed ? 'stopped' : record.expired ? 'startup-timeout' : 'startup-failed'));
      }
    }).then(record.settle);
    return record.promise;
  }
  function admit(): OperatorIdentityResult | undefined {
    if (closed) return rejected(issue('stopped'));
    if (pending) return rejected(issue('busy'));
    if (attempts >= OPERATOR_IDENTITY_LIFECYCLE_LIMITS.attempts) return rejected(issue('capacity'));
    attempts++; return;
  }
  const controller: OperatorIdentityController = {
    start() {
      if (closed) return Promise.resolve(rejected(issue('stopped')));
      if (phase !== 'prepared' && !(phase === 'running' && endpoint)) return Promise.resolve(rejected(issue(pending ? 'busy' : 'inactive')));
      const denied = admit(); return denied ? Promise.resolve(denied) : begin(reserve(false), owner);
    },
    rotate(next) {
      const denied = admit(); if (denied) return Promise.resolve(denied);
      if (!endpoint || phase !== 'running') return Promise.resolve(rejected(issue('inactive')));
      const record = reserve(true);
      const replacement = prepareOperatorStartup(next);
      if (!replacement.ok) {
        record.settle(rejected(issue(closed ? 'stopped' : 'configuration-invalid', replacement.issue))); return record.promise;
      }
      return begin(record, replacement.controller);
    },
    stop() {
      if (stopping) return stopping;
      closed = true; epoch++; phase = 'stopped'; endpoint = undefined; problem = undefined;
      const record = pending; if (record) disarm(record);
      const native = [owner.stop(), ...(record?.target && record.target !== owner ? [record.target.stop()] : [])];
      stopping = Promise.all([...native, ...(record ? [record.promise] : [])]).then(() => undefined);
      return stopping;
    },
    snapshot() { return Object.freeze({ profile: OPERATOR_IDENTITY_LIFECYCLE_PROFILE, phase, generation, attempts,
      pending: pending !== undefined, timerArmed: pending?.timer !== undefined, authorityCopied: false,
      ...(endpoint ? { endpoint } : {}), ...(problem ? { issue: problem } : {}) }); },
  };
  return Object.freeze({ ok: true, controller: Object.freeze(controller) });
}
