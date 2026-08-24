import { Howler } from "howler";
import type { ToneOptions } from "./index.ts";

export interface TimelinePlayOptions {
  volume?: number;
}

export interface AudioTimelineOptions {
  /** Injectable for deterministic tests; production shares Howler's Web Audio clock. */
  context?: AudioContext;
  /** Defaults to Howler's master gain so master volume still applies. */
  destination?: AudioNode;
}

export interface ScheduledTone {
  /** The exact Web Audio time passed to `AudioScheduledSourceNode.start`. */
  at: number;
  cancel(): void;
}

/**
 * A small Web Audio timeline for cues that must not inherit render-loop jitter.
 *
 * Howler remains the owner of the shared AudioContext and master gain. The timeline only creates
 * short oscillator nodes, schedules their starts against `AudioContext.currentTime`, and routes
 * them through an instance-local visibility/mute gain before Howler's shared master volume.
 */
export class AudioTimeline101 {
  private readonly tones = new Map<string, ToneOptions>();
  private readonly context?: AudioContext;
  private readonly destination?: AudioNode;
  private readonly output?: GainNode;
  private readonly active = new Set<() => void>();
  private manuallyMuted = false;
  private disposed = false;
  private readonly onVisibilityChange = () => this.applyMuteState();

  constructor(options: AudioTimelineOptions = {}) {
    const howler = Howler as typeof Howler & {
      ctx: AudioContext | null;
      masterGain: GainNode | null;
    };
    this.context = options.context
      ?? (Howler.usingWebAudio ? howler.ctx ?? undefined : undefined);
    this.destination = options.destination
      ?? (options.context ? this.context?.destination : howler.masterGain ?? this.context?.destination);
    if (this.context && this.destination) {
      this.output = this.context.createGain();
      this.output.connect(this.destination);
      this.applyMuteState();
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  get supported() {
    return Boolean(this.context && this.output);
  }

  get currentTime() {
    return this.context?.currentTime ?? 0;
  }

  get running() {
    return this.context?.state === "running";
  }

  registerTone(id: string, options: ToneOptions) {
    if (this.disposed) throw new Error("Cannot register a tone on a disposed 101 audio timeline");
    this.tones.set(id, { ...options });
  }

  async resume() {
    if (this.context?.state !== "running") await this.context?.resume();
  }

  setMuted(muted: boolean) {
    this.manuallyMuted = muted;
    this.applyMuteState();
  }

  schedule(id: string, at: number, options: TimelinePlayOptions = {}): ScheduledTone | undefined {
    if (this.disposed) throw new Error("Cannot schedule on a disposed 101 audio timeline");
    const definition = this.tones.get(id);
    if (!definition) throw new Error(`Unknown 101 timeline tone: ${id}`);
    const context = this.context;
    const output = this.output;
    if (!context || !output) return undefined;

    const startAt = Math.max(context.currentTime, Number.isFinite(at) ? at : context.currentTime);
    const duration = clamp(definition.duration ?? .12, .02, 2);
    const endAt = startAt + duration;
    const attack = clamp(definition.attack ?? .008, 0, duration / 2);
    const release = clamp(definition.release ?? .04, 0, duration / 2);
    const level = clamp(definition.volume ?? 1) * clamp(options.volume ?? 1);
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = definition.wave ?? "sine";
    oscillator.frequency.setValueAtTime(clamp(definition.frequency, 30, 4_000), startAt);
    gain.gain.cancelScheduledValues(startAt);
    if (attack > 0) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(level, startAt + attack);
    } else {
      gain.gain.setValueAtTime(level, startAt);
    }
    const releaseAt = Math.max(startAt + attack, endAt - release);
    gain.gain.setValueAtTime(level, releaseAt);
    if (release > 0) gain.gain.linearRampToValueAtTime(0, endAt);
    else gain.gain.setValueAtTime(0, endAt);

    oscillator.connect(gain);
    gain.connect(output);

    let connected = true;
    const cleanup = () => {
      if (!connected) return;
      connected = false;
      this.active.delete(cancel);
      oscillator.onended = null;
      oscillator.disconnect();
      gain.disconnect();
    };
    const cancel = () => {
      if (!connected) return;
      try {
        oscillator.stop(context.currentTime);
      } catch {
        // The source may already have ended between the caller deciding to cancel and this turn.
      }
      cleanup();
    };
    oscillator.onended = cleanup;
    this.active.add(cancel);

    try {
      oscillator.start(startAt);
      oscillator.stop(endAt);
    } catch (error) {
      cleanup();
      throw error;
    }

    return { at: startAt, cancel };
  }

  cancelAll() {
    for (const cancel of [...this.active]) cancel();
  }

  dispose() {
    if (this.disposed) return;
    this.cancelAll();
    this.tones.clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.output?.disconnect();
    this.disposed = true;
  }

  private applyMuteState() {
    const context = this.context;
    const output = this.output;
    if (!context || !output) return;
    output.gain.cancelScheduledValues(context.currentTime);
    output.gain.setValueAtTime(
      this.manuallyMuted || (typeof document !== "undefined" && document.hidden) ? 0 : 1,
      context.currentTime,
    );
  }
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
