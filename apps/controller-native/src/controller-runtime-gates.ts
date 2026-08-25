import type { ControlMessage, SpeakerCueMessage } from "@101/protocol";

type ControllerConfiguration = Extract<ControlMessage, { type: "controller.configure" }>;

/** Makes the host's repeated capability hello/configure exchange idempotent for held input. */
export class ControllerConfigurationGate {
  private identity = "";

  accept(message: ControllerConfiguration) {
    const identity = `${message.deviceId}:${message.gameId}:${message.role}:${message.revision}`;
    if (identity === this.identity) return false;
    this.identity = identity;
    return true;
  }

  reset() {
    this.identity = "";
  }
}

/** Keeps disposable private audio out of an unavailable/background native player. */
export class ControllerSpeakerGate {
  private available = false;

  get ready() {
    return this.available;
  }

  setReady(ready: boolean, onUnavailable: () => void) {
    if (ready === this.available) return false;
    this.available = ready;
    if (!ready) onUnavailable();
    return true;
  }

  deliver(
    message: SpeakerCueMessage,
    listener: (message: SpeakerCueMessage) => void,
    discard: (message: SpeakerCueMessage) => void,
  ) {
    if (!this.available) {
      discard(message);
      return false;
    }
    listener(message);
    return true;
  }
}
