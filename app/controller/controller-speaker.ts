import { Audio101, type PlayOptions, type ToneOptions } from "@101/audio";
import type { SpeakerCueMessage } from "@101/protocol";

export interface ControllerCueAudio {
  registerTone(id: string, options: ToneOptions): void;
  resume(): Promise<void>;
  play(id: string, options: PlayOptions): number;
  unload(): void;
}

/**
 * Owns the browser's opt-in audio state independently from the network transport. Cues are never
 * queued: if autoplay is still locked (or a packet arrives twice), silence is preferable to a late
 * clue that no longer describes the current game state.
 */
export class BrowserControllerSpeaker {
  private readonly audio: ControllerCueAudio;
  private readonly isVisible: () => boolean;
  private audioState: "locked" | "ready" = "locked";
  private lastSequence = -1;

  constructor(
    audio: ControllerCueAudio = new Audio101(),
    isVisible: () => boolean = () => typeof document === "undefined" || !document.hidden,
  ) {
    this.audio = audio;
    this.isVisible = isVisible;
    this.audio.registerTone("private-cue", {
      frequency: 540,
      duration: .14,
      wave: "sine",
      attack: .004,
      release: .11,
    });
  }

  get state() {
    return this.audioState === "ready" && this.isVisible() ? "ready" : "locked";
  }

  async enable() {
    if (this.audioState === "ready") return true;
    try {
      await this.audio.resume();
      this.audioState = "ready";
      return true;
    } catch {
      return false;
    }
  }

  receive(message: SpeakerCueMessage) {
    if (message.sequence <= this.lastSequence) return false;
    this.lastSequence = message.sequence;
    if (this.state !== "ready") return false;
    this.audio.play("private-cue", {
      category: "sfx",
      rate: message.pitch,
      volume: message.volume,
    });
    return true;
  }

  dispose() {
    this.audioState = "locked";
    this.audio.unload();
  }
}
