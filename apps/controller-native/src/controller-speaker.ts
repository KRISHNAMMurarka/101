import type { SpeakerCueMessage } from "@101/protocol";

/** The small subset of Expo Audio used by private controller cues. */
export interface ControllerSpeakerPlayer {
  volume: number;
  playbackRate: number;
  shouldCorrectPitch: boolean;
  seekTo(position: number): Promise<void> | void;
  play(): void;
}

/**
 * Reuses one bundled sound as a tiny private voice on the controller.
 *
 * Speaker cues use the disposable realtime lane. A delayed packet is worse than a missed clue,
 * so sequence numbers are deliberately monotonic and a newer seek cancels an older in-flight one.
 */
export class ControllerSpeaker {
  private lastSequence = -1;
  private generation = 0;
  private readonly player: ControllerSpeakerPlayer;
  private readonly now: () => number;
  private operation: Promise<void> = Promise.resolve();

  constructor(player: ControllerSpeakerPlayer, now: () => number = Date.now) {
    this.player = player;
    this.now = now;
    player.shouldCorrectPitch = false;
  }

  async play(message: SpeakerCueMessage) {
    if (message.sequence <= this.lastSequence) return false;
    this.lastSequence = message.sequence;
    const generation = ++this.generation;
    const receivedAt = this.now();
    const operation = this.operation.then(async () => {
      if (generation !== this.generation || this.now() - receivedAt > 120) return false;
      this.player.volume = clamp(message.volume, 0, 1);
      this.player.playbackRate = clamp(message.pitch, 0.5, 2);
      await this.player.seekTo(0);
      if (generation !== this.generation || this.now() - receivedAt > 120) return false;
      this.player.play();
      return true;
    });
    this.operation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** A locked/background cue is consumed for ordering but deliberately makes no sound. */
  discard(message: SpeakerCueMessage) {
    if (message.sequence <= this.lastSequence) return false;
    this.lastSequence = message.sequence;
    this.cancel();
    return true;
  }

  /** A disconnected transport cannot carry an old cue into the next pairing. */
  reset() {
    this.lastSequence = -1;
    this.cancel();
  }

  /** Stops a queued/in-flight cue without weakening stale protection inside the same pairing. */
  cancel() {
    this.generation += 1;
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
