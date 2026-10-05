import { getInputProfile, parseDeviceDescriptor, parseSignalValue } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';

export interface KeyTransition {
  readonly code: string; readonly key: string; readonly phase: 'down' | 'up'; readonly repeat: boolean;
  readonly location: number; readonly composing: boolean;
  readonly modifiers: Readonly<{ shift: boolean; control: boolean; alt: boolean; meta: boolean }>;
}
export interface TextComposition {
  readonly compositionId: string; readonly phase: 'start' | 'update' | 'end' | 'commit'; readonly text: string;
}
export interface KeyboardTextSourceOptions {
  now: () => number;
  /** Admission only. The host must release its sink when a route disconnects. */
  publish: (capability: 'key' | 'composition', value: KeyTransition | TextComposition, metadata: Readonly<{ capturedAt: number }>) => boolean;
}
const keySchema = getInputProfile('app:keyboard/1').capabilities[0]!.value;
const textSchema = getInputProfile('app:text/1').capabilities[0]!.value;
const releasedModifiers = Object.freeze({ shift: false, control: false, alt: false, meta: false });

export function keyboardTextSourceDescriptor(platform = 'browser-selected-by-host'): DeviceDescriptor {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'keyboard-text-source', label: 'Keyboard and text', revision: 1,
    adapter: { id: 'app:keyboard-text', version: '1.0.0' }, runtime: { platform },
    capabilities: [...getInputProfile('app:keyboard/1').capabilities, ...getInputProfile('app:text/1').capabilities] });
}

/** Bounded reliable events; no timers, DOM globals, editing operations or key-to-text inference. */
export class KeyboardTextSourceDriver {
  private readonly options: KeyboardTextSourceOptions;
  private readonly held = new Map<string, KeyTransition>();
  private active?: { id: string; committed: boolean };
  private ended?: { id: string; committed: boolean };
  private sequence = 0;
  private lastTime = 0;
  private stopped = false;
  private busy = false;
  private releasing = false;
  private releasePending = false;
  constructor(options: KeyboardTextSourceOptions) {
    if (typeof options.now !== 'function' || typeof options.publish !== 'function') throw new TypeError('Keyboard/text callbacks required');
    this.options = { ...options };
  }
  state(): Readonly<{ heldKeys: number; composing: boolean; stopped: boolean }> {
    return Object.freeze({ heldKeys: this.held.size, composing: !!this.active, stopped: this.stopped });
  }
  key(input: unknown): boolean {
    return this.operation(() => {
      const value = parseSignalValue(input, keySchema) as unknown as KeyTransition;
      const id = `${value.location}:${value.code}`;
      if (!value.composing && value.phase === 'down') this.ended = undefined;
      if (value.phase === 'down') {
        if (!this.held.has(id) && this.held.size >= 64) throw new RangeError('Held key limit');
        this.held.set(id, value);
      } else this.held.delete(id);
      return this.emit('key', value);
    });
  }
  composition(phase: 'start' | 'update' | 'end', text: string): boolean {
    return this.operation(() => {
      if (phase === 'start') {
        if (this.active) throw new RangeError('Composition already active');
        this.active = { id: this.id(), committed: false }; this.ended = undefined;
      } else if (!this.active) throw new RangeError('No active composition');
      const active = this.active!;
      const value = this.text(active.id, phase, text);
      if (phase === 'end') { this.active = undefined; this.ended = text ? active : undefined; }
      return this.emit('composition', value);
    });
  }
  /** Called for actual input events. Composition updates and deletion are never commits. */
  input(inputType: string, data: string | null, composing: boolean): boolean {
    return this.operation(() => {
      if (typeof inputType !== 'string' || (data !== null && typeof data !== 'string') || typeof composing !== 'boolean')
        throw new TypeError('Invalid input event');
      const finalComposition = inputType === 'insertFromComposition';
      if ((!finalComposition && composing) || !['insertText', 'insertFromComposition', 'insertFromPaste', 'insertFromDrop', 'insertReplacementText'].includes(inputType) || data === null || data === '') return true;
      const session = this.active ?? this.ended;
      if (finalComposition && session?.committed) return true;
      const id = session && !session.committed ? session.id : this.id();
      const value = this.text(id, 'commit', data);
      if (session) session.committed = true;
      if (!this.active) this.ended = finalComposition && session ? session : undefined;
      return this.emit('composition', value);
    });
  }
  /** Blur/hide cancels uncommitted composition; ending does not synthesize a commit. */
  release(): void {
    if (this.releasing) return;
    this.releasePending = true;
    if (!this.busy && !this.releasing && (this.held.size || this.active)) {
      this.busy = true;
      try { this.readTime(); } catch { this.stopped = true; }
      finally { this.busy = false; }
    }
    this.flushRelease();
  }
  stop(): void { if (this.stopped) return; this.stopped = true; this.release(); }
  private id(): string {
    if (!Number.isSafeInteger(++this.sequence)) throw new RangeError('Composition identity exhausted');
    return `composition:${this.sequence}`;
  }
  private text(compositionId: string, phase: TextComposition['phase'], text: string): TextComposition {
    return parseSignalValue({ compositionId, phase, text }, textSchema) as unknown as TextComposition;
  }
  private operation(action: () => boolean): boolean {
    if (this.stopped || this.busy || this.releasing) return false;
    this.busy = true;
    let admitted = false;
    try {
      this.readTime();
      if (this.stopped) return false;
      admitted = action();
      if (!admitted) this.stop();
    } catch { this.stop(); }
    finally { this.busy = false; this.flushRelease(); }
    return admitted && !this.stopped;
  }
  private readTime(): void {
    const time = this.options.now();
    if (!Number.isFinite(time) || time < this.lastTime) throw new RangeError('Invalid source clock');
    this.lastTime = time;
  }
  private emit(capability: 'key' | 'composition', value: KeyTransition | TextComposition): boolean {
    return this.options.publish(capability, value, Object.freeze({ capturedAt: this.lastTime })) === true;
  }
  private flushRelease(): void {
    if (!this.releasePending || this.busy || this.releasing) return;
    this.releasePending = false; this.releasing = true;
    const held = [...this.held.values()], active = this.active;
    this.held.clear(); this.active = undefined; this.ended = undefined;
    // Cleanup uses the last validated capture time even when the clock/publisher has failed.
    for (const value of held) {
      try { if (!this.emit('key', Object.freeze({ ...value, phase: 'up', repeat: false, composing: false, modifiers: releasedModifiers }))) this.stopped = true; }
      catch { this.stopped = true; }
    }
    if (active) {
      try { if (!this.emit('composition', this.text(active.id, 'end', ''))) this.stopped = true; }
      catch { this.stopped = true; }
    }
    this.releasing = false;
  }
}

/** Explicitly selected surface only. Native DOM behavior and focus remain owned by the caller. */
export function mountKeyboardTextSource(target: HTMLElement, driver: KeyboardTextSourceDriver): () => void {
  const document = target.ownerDocument, window = document.defaultView;
  if (!window) throw new TypeError('An attached browser document is required');
  let disposed = false;
  const key = (phase: KeyTransition['phase']) => (event: KeyboardEvent) => driver.key({
    code: event.code || 'Unidentified', key: event.key || 'Unidentified', phase, repeat: phase === 'down' && event.repeat,
    location: event.location, composing: event.isComposing,
    modifiers: { shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey } });
  const down = key('down'), up = key('up');
  const start = (event: CompositionEvent) => driver.composition('start', event.data);
  const update = (event: CompositionEvent) => driver.composition('update', event.data);
  const end = (event: CompositionEvent) => driver.composition('end', event.data);
  const input = (event: Event) => {
    // Native text controls deliver InputEvent; plain Event carries no committed data.
    if (event instanceof window.InputEvent) driver.input(event.inputType, event.data, event.isComposing);
  };
  const release = () => driver.release();
  const focusout = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof window.Node) || !target.contains(event.relatedTarget)) release();
  };
  const visibility = () => { if (document.visibilityState !== 'visible') release(); };
  target.addEventListener('keydown', down); target.addEventListener('keyup', up);
  target.addEventListener('compositionstart', start); target.addEventListener('compositionupdate', update);
  target.addEventListener('compositionend', end); target.addEventListener('input', input);
  target.addEventListener('focusout', focusout);
  window.addEventListener('blur', release); window.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    if (disposed) return; disposed = true;
    target.removeEventListener('keydown', down); target.removeEventListener('keyup', up);
    target.removeEventListener('compositionstart', start); target.removeEventListener('compositionupdate', update);
    target.removeEventListener('compositionend', end); target.removeEventListener('input', input);
    target.removeEventListener('focusout', focusout);
    window.removeEventListener('blur', release); window.removeEventListener('pagehide', release);
    document.removeEventListener('visibilitychange', visibility); driver.stop();
  };
}
