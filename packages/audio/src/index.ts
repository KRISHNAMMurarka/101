import { Howl, Howler } from "howler";

export interface SoundOptions {
  src: string[];
  loop?: boolean;
  volume?: number;
  pool?: number;
}

export class Audio101 {
  private readonly sounds = new Map<string, Howl>();
  private musicVolume = 0.8;
  private sfxVolume = 1;

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        Howler.mute(document.hidden);
      });
    }
  }

  register(id: string, options: SoundOptions) {
    this.sounds.get(id)?.unload();
    this.sounds.set(id, new Howl(options));
  }

  play(id: string, category: "music" | "sfx" = "sfx") {
    const sound = this.sounds.get(id);
    if (!sound) throw new Error(`Unknown 101 sound: ${id}`);
    sound.volume(category === "music" ? this.musicVolume : this.sfxVolume);
    return sound.play();
  }

  setMasterVolume(value: number) {
    Howler.volume(Math.max(0, Math.min(1, value)));
  }

  setCategoryVolume(category: "music" | "sfx", value: number) {
    const normalized = Math.max(0, Math.min(1, value));
    if (category === "music") this.musicVolume = normalized;
    else this.sfxVolume = normalized;
  }

  unload() {
    this.sounds.forEach((sound) => sound.unload());
    this.sounds.clear();
  }
}
