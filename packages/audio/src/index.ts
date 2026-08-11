import { Howl, Howler } from "howler";

export interface SoundOptions {
  src: string[];
  loop?: boolean;
  volume?: number;
  pool?: number;
  preload?: boolean;
}

export interface ToneOptions {
  frequency: number;
  duration?: number;
  volume?: number;
  wave?: "sine" | "square" | "triangle";
  attack?: number;
  release?: number;
}

export interface PlayOptions {
  category?: "music" | "sfx";
  volume?: number;
  rate?: number;
  pan?: number;
}

export class Audio101 {
  private readonly sounds = new Map<string, Howl>();
  private readonly baseVolumes = new Map<string, number>();
  private musicVolume = 0.8;
  private sfxVolume = 1;
  private manuallyMuted = false;
  private readonly onVisibilityChange = () => this.applyMuteState();

  constructor() {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  register(id: string, options: SoundOptions) {
    this.sounds.get(id)?.unload();
    this.baseVolumes.set(id, clamp(options.volume ?? 1));
    this.sounds.set(id, new Howl({ ...options, preload: options.preload ?? true }));
  }

  registerTone(id: string, options: ToneOptions) {
    this.register(id, {
      src: [toneDataUri(options)],
      volume: clamp(options.volume ?? 1),
      pool: 8,
    });
  }

  play(id: string, categoryOrOptions: "music" | "sfx" | PlayOptions = "sfx") {
    const sound = this.requireSound(id);
    const options = typeof categoryOrOptions === "string" ? { category: categoryOrOptions } : categoryOrOptions;
    const category = options.category ?? "sfx";
    const categoryVolume = category === "music" ? this.musicVolume : this.sfxVolume;
    const instance = sound.play();
    sound.volume(clamp(options.volume ?? 1) * categoryVolume * (this.baseVolumes.get(id) ?? 1), instance);
    if (options.rate !== undefined) sound.rate(clamp(options.rate, .25, 4), instance);
    if (options.pan !== undefined) sound.stereo(clamp(options.pan, -1, 1), instance);
    return instance;
  }

  stop(id?: string) {
    if (id) this.requireSound(id).stop();
    else Howler.stop();
  }

  setPan(id: string, value: number, instance?: number) {
    this.requireSound(id).stereo(clamp(value, -1, 1), instance);
  }

  setMasterVolume(value: number) {
    Howler.volume(clamp(value));
  }

  setCategoryVolume(category: "music" | "sfx", value: number) {
    const normalized = clamp(value);
    if (category === "music") this.musicVolume = normalized;
    else this.sfxVolume = normalized;
  }

  setMuted(muted: boolean) {
    this.manuallyMuted = muted;
    this.applyMuteState();
  }

  unload() {
    this.sounds.forEach((sound) => sound.unload());
    this.sounds.clear();
    this.baseVolumes.clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private applyMuteState() {
    Howler.mute(this.manuallyMuted || (typeof document !== "undefined" && document.hidden));
  }

  private requireSound(id: string) {
    const sound = this.sounds.get(id);
    if (!sound) throw new Error(`Unknown 101 sound: ${id}`);
    return sound;
  }
}

export function toneDataUri(options: ToneOptions) {
  if (typeof btoa === "undefined") throw new Error("Tone generation requires a browser-compatible base64 encoder");
  const sampleRate = 22_050;
  const duration = clamp(options.duration ?? .12, .02, 2);
  const sampleCount = Math.max(1, Math.round(sampleRate * duration));
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  writeText(bytes, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(bytes, 36, "data");
  view.setUint32(40, sampleCount * 2, true);
  const frequency = clamp(options.frequency, 30, 4_000);
  const attack = clamp(options.attack ?? .008, 0, duration / 2);
  const release = clamp(options.release ?? .04, 0, duration / 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const phase = time * frequency;
    const raw = options.wave === "square"
      ? Math.sign(Math.sin(phase * Math.PI * 2))
      : options.wave === "triangle"
        ? 2 * Math.abs(2 * (phase - Math.floor(phase + .5))) - 1
        : Math.sin(phase * Math.PI * 2);
    const envelope = Math.min(1, attack === 0 ? 1 : time / attack, release === 0 ? 1 : (duration - time) / release);
    view.setInt16(44 + index * 2, Math.round(raw * Math.max(0, envelope) * 32_000), true);
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function writeText(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
