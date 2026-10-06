import { HAPTIC_OUTPUT_LIMITS } from '@101/connect';
import type { HapticBackend, HapticBackendOutcome, HapticOutcome, HapticPreset } from '@101/connect';
import type { ImpactFeedbackStyle, NotificationFeedbackType } from 'expo-haptics';

/** Exact subset of installed Expo Haptics57.0.1. No duration/intensity/cancel API is invented. */
export interface ControllerHapticsPort {
  selectionAsync?(): Promise<void>;
  impactAsync?(style: ImpactFeedbackStyle.Heavy): Promise<void>;
  notificationAsync?(type: NotificationFeedbackType.Warning): Promise<void>;
  ImpactFeedbackStyle: { readonly Heavy: ImpactFeedbackStyle.Heavy };
  NotificationFeedbackType: { readonly Warning: NotificationFeedbackType.Warning };
}
export interface ControllerHaptics {
  /** A trusted actual Expo port for a separately granted SDK command sink. */
  readonly backend: HapticBackend;
  /** Legacy/local feedback only; this method does not establish an SDK grant. */
  play(preset: HapticPreset): Promise<HapticOutcome>;
  setActive(active: boolean): void;
  cancel(): void;
  close(): void;
}

// App remounts reuse the installed Expo module. An issued request outlives a
// helper's logical lifetime, so only its native settlement releases this port.
const reservedPorts = new WeakSet<ControllerHapticsPort>();

/** One native API invocation at a time; retirement cannot undo an already issued Expo request. */
export function createControllerHaptics(port: ControllerHapticsPort, options: { now?: () => number } = {}): ControllerHaptics {
  const selection = port.selectionAsync, impact = port.impactAsync, notification = port.notificationAsync;
  const heavy = port.ImpactFeedbackStyle.Heavy, warning = port.NotificationFeedbackType.Warning;
  const supported = typeof selection === 'function' && typeof impact === 'function' && typeof notification === 'function' && heavy === 'heavy' && warning === 'warning';
  let active = false, closed = false, busy = false, generation = 0, previous = -1, dispatchedAt = -Infinity;
  let invocation: { cancel(): void } | undefined;
  const backend: HapticBackend = Object.freeze({ profileId: 'app:expo-haptic-presets/1', supported,
    invoke(preset: HapticPreset): HapticBackendOutcome | Promise<HapticBackendOutcome> {
      if (!supported || !active || closed || preset !== 'tap' && preset !== 'impact' && preset !== 'warning') return 'unavailable';
      if (reservedPorts.has(port)) return 'busy';
      reservedPorts.add(port);
      const epoch = generation;
      let resolve!: (value: HapticBackendOutcome) => void, reject!: (reason: unknown) => void, settled = false;
      const result = new Promise<HapticBackendOutcome>((done, fail) => { resolve = done; reject = fail; });
      const entry = { cancel() { if (settled) return; settled = true; resolve('cancelled'); if (invocation === entry) invocation = undefined; } };
      invocation = entry;
      function finish(failed: boolean) {
        reservedPorts.delete(port);
        if (settled) return;
        settled = true; if (invocation === entry) invocation = undefined;
        if (closed || !active || generation !== epoch) resolve('cancelled');
        else if (failed) reject(new Error('Haptic API rejected the request'));
        else resolve('api-returned');
      }
      try {
        const returned = preset === 'tap' ? selection.call(port) : preset === 'impact' ? impact.call(port, heavy) : notification.call(port, warning);
        Promise.resolve(returned).then(() => finish(false), () => finish(true));
      } catch { finish(true); }
      return result;
    },
  });
  const clock = options.now ?? (() => performance.now());
  let pending: { finish(outcome: HapticOutcome): void } | undefined;
  function cancel() { generation++; pending?.finish('cancelled'); invocation?.cancel(); }
  function close() { if (closed) return; closed = true; active = false; cancel(); }
  function now(): number | undefined {
    let value: number;
    try { value = clock(); } catch { close(); return undefined; }
    if (closed) return undefined;
    if (!Number.isFinite(value) || value < 0 || value < previous || value > Number.MAX_SAFE_INTEGER) { close(); return undefined; }
    previous = value; return value;
  }
  return Object.freeze({ backend,
    async play(preset: HapticPreset): Promise<HapticOutcome> {
      if (closed || !active) return 'cancelled';
      if (!supported || preset !== 'tap' && preset !== 'impact' && preset !== 'warning') return 'unavailable';
      if (busy || reservedPorts.has(port)) return 'busy';
      busy = true;
      const epoch = generation, startedAt = now();
      if (startedAt === undefined || closed || !active || epoch !== generation) { busy = false; return 'cancelled'; }
      const start = startedAt;
      if (startedAt - dispatchedAt < 1000 / HAPTIC_OUTPUT_LIMITS.maxHz) { busy = false; return 'rate-limited'; }
      let resolve!: (outcome: HapticOutcome) => void, settled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const result = new Promise<HapticOutcome>(done => { resolve = done; });
      const entry = { finish(outcome: HapticOutcome) {
        if (settled) return;
        settled = true; if (timer !== undefined) clearTimeout(timer);
        if (pending === entry) pending = undefined;
        resolve(outcome);
      } };
      pending = entry;
      const created = setTimeout(() => entry.finish('expired'), HAPTIC_OUTPUT_LIMITS.maxAgeMs);
      if (settled || closed || !active || epoch !== generation) clearTimeout(created); else timer = created;
      if (settled || closed || !active || epoch !== generation) { entry.finish('cancelled'); busy = false; return result; }
      dispatchedAt = startedAt;
      function complete(outcome: HapticOutcome) {
        busy = false;
        if (settled) return;
        const finishedAt = now();
        if (settled) return;
        if (finishedAt === undefined || closed || !active || epoch !== generation) entry.finish('cancelled');
        else if (finishedAt - start >= HAPTIC_OUTPUT_LIMITS.maxAgeMs) entry.finish('expired');
        else entry.finish(outcome);
      }
      // Both branches consume platform failures. App's void callbacks cannot leak a rejection.
      Promise.resolve(backend.invoke(preset)).then(complete, () => complete('api-rejected'));
      return result;
    },
    setActive(value: boolean) { if (typeof value !== 'boolean') throw new TypeError('Invalid active state'); if (closed) return;
      active = value; if (!active) cancel(); }, cancel, close,
  });
}
