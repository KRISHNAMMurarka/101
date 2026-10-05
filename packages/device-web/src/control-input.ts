import { surfaceControlValueValid } from '@101/device-model';
import type { SurfaceControl } from '@101/device-model';

export interface SurfaceControlEvent {
  readonly id: string; readonly kind: SurfaceControl['kind']; readonly value: boolean | number | string; readonly sequence: number;
}
export interface SurfaceControlContext { readonly signal: AbortSignal }
export type SurfaceControlCallback = (event: SurfaceControlEvent, context: SurfaceControlContext) => void | Promise<void>;
export interface ControlInputState {
  readonly value: boolean | number | string; readonly enabled: boolean; readonly pending: boolean;
  readonly status: 'ready' | 'sending' | 'sent' | 'failed' | 'unavailable';
}
interface Pending { readonly generation: number; readonly controller: AbortController; timer?: ReturnType<typeof setTimeout> }
interface Entry {
  readonly node: SurfaceControl; value: ControlInputState['value']; accepted: ControlInputState['value'];
  enabled: boolean; status: ControlInputState['status']; generation: number; pending?: Pending; queued?: SurfaceControlEvent;
}

/** Private input owner. State choices coalesce; activation actions never repeat automatically. */
export function createControlInput(controls: readonly SurfaceControl[], callback: SurfaceControlCallback, timeoutMs = 2000) {
  if (typeof callback !== 'function' || controls.length > 64 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new TypeError('Invalid control input options');
  const entries = new Map<string, Entry>(); const listeners = new Set<() => void>();
  let closed = false, sequence = 0, dispatching = false, changing = 0;
  for (const node of controls) {
    if (entries.has(node.id)) throw new TypeError('Duplicate control input');
    const value = node.kind === 'button' ? false : node.initial;
    entries.set(node.id, { node, value, accepted: value, enabled: false, status: 'unavailable', generation: 0 });
  }
  function notify(): void { for (const listener of listeners) try { listener(); } catch { /* No private listener error enters UI state. */ } }
  function cancel(entry: Entry): number {
    entry.generation++; entry.queued = undefined;
    const pending = entry.pending; entry.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.controller.abort(); }
    return entry.generation;
  }
  function dispatch(entry: Entry, event: SurfaceControlEvent): void {
    const pending: Pending = { generation: ++entry.generation, controller: new AbortController() };
    entry.pending = pending; entry.value = event.value; entry.status = 'sending';
    changing++; try { notify(); } finally { changing--; }
    if (closed || !entry.enabled || entry.pending !== pending || entry.generation !== pending.generation) return;
    function settle(success: boolean): void {
      if (closed || !entry.enabled || entry.pending !== pending || entry.generation !== pending.generation) return;
      clearTimeout(pending.timer); entry.pending = undefined;
      const generation = entry.generation, queued = entry.queued; entry.queued = undefined;
      changing++;
      try {
        if (success) entry.accepted = event.value; else pending.controller.abort();
        if (closed || !entry.enabled || generation !== entry.generation) return;
        entry.status = success ? 'sent' : 'failed';
        entry.value = queued?.value ?? entry.accepted; notify();
      } finally { changing--; }
      if (queued && !closed && entry.enabled && entry.generation === generation) dispatch(entry, queued);
    }
    let returned: void | Promise<void>;
    try { dispatching = true; returned = callback(event, Object.freeze({ signal: pending.controller.signal })); }
    catch { settle(false); return; }
    finally { dispatching = false; }
    if (returned === undefined) { settle(true); return; }
    // The returned promise is always observed, even if the callback revoked its own input.
    const observed = Promise.resolve(returned);
    void observed.then(() => settle(true), () => settle(false));
    if (entry.pending === pending) pending.timer = setTimeout(() => settle(false), timeoutMs);
  }
  return Object.freeze({
    send(id: string, value: unknown): 'sent' | 'queued' | 'busy' | 'unavailable' | 'invalid' {
      const entry = entries.get(id);
      if (closed) return 'unavailable';
      if (!entry || !surfaceControlValueValid(entry.node, value)) return 'invalid';
      if (!entry.enabled) return 'unavailable';
      if (dispatching || changing || entry.node.kind === 'button' && entry.pending) return 'busy';
      const event = Object.freeze({ id, kind: entry.node.kind, value, sequence: ++sequence });
      if (entry.pending) { entry.queued = event; entry.value = value; notify(); return 'queued'; }
      dispatch(entry, event); return 'sent';
    },
    enable(id: string, enabled: boolean): boolean {
      const entry = entries.get(id); if (closed || !entry || typeof enabled !== 'boolean') return false;
      changing++;
      try {
        entry.enabled = enabled;
        const before = entry.generation + 1; cancel(entry);
        if (closed || entry.generation !== before) return false;
        entry.value = entry.accepted; entry.status = enabled ? 'ready' : 'unavailable'; notify(); return true;
      } finally { changing--; }
    },
    setValue(id: string, value: unknown): boolean {
      const entry = entries.get(id);
      if (closed || !entry || entry.node.kind === 'button' || !surfaceControlValueValid(entry.node, value)) return false;
      changing++;
      try {
        const before = entry.generation + 1; cancel(entry);
        if (closed || entry.generation !== before) return false;
        entry.accepted = entry.value = value; entry.status = entry.enabled ? 'ready' : 'unavailable'; notify(); return true;
      } finally { changing--; }
    },
    state(id: string): Readonly<ControlInputState> | undefined {
      const entry = entries.get(id);
      return entry && Object.freeze({ value: entry.value, enabled: !closed && entry.enabled,
        pending: entry.pending !== undefined, status: closed ? 'unavailable' : entry.status });
    },
    subscribe(listener: () => void): () => void {
      if (closed || listeners.size >= 8 || typeof listener !== 'function') throw new TypeError('Control listener unavailable');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    close(): void { if (closed) return; closed = true; for (const entry of entries.values()) cancel(entry); notify(); listeners.clear(); },
  });
}
