import { Audio101, type PlayOptions, type ToneOptions } from "@101/audio";
import type { SpeakerCueMessage } from "@101/protocol";

export interface ControllerCueAudio {
  registerTone(id: string, options: ToneOptions): void;
  resume(): Promise<void>;
  play(id: string, options: PlayOptions): number;
  unload(): void;
  /** Optional so a minimal test double need not implement it; Audio101 does. */
  onPlaybackError?(listener: (id: string) => void): () => void;
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
  private readonly onLocked?: () => void;
  private readonly stopWatchingErrors?: () => void;

  constructor(
    audio: ControllerCueAudio = new Audio101(),
    isVisible: () => boolean = () => typeof document === "undefined" || !document.hidden,
    onLocked?: () => void,
  ) {
    this.audio = audio;
    this.isVisible = isVisible;
    this.onLocked = onLocked;
    // Telling the host "ready" makes it stop playing this role's cues through the television. If
    // playback then fails silently the player hears nothing from either source, so a failure has to
    // demote us back to locked and re-announce, exactly as native Link does on a rejected play.
    this.stopWatchingErrors = this.audio.onPlaybackError?.(() => this.demote());
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

  /** Drops back to locked so the host resumes its own audio for this role. */
  private demote() {
    if (this.audioState === "locked") return;
    this.audioState = "locked";
    this.onLocked?.();
  }

  dispose() {
    this.stopWatchingErrors?.();
    this.audioState = "locked";
    this.audio.unload();
  }
}
