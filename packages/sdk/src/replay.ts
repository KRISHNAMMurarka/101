import type { InputFrame } from "@101/input";

export interface Replay101 {
  schema: 1;
  gameId: string;
  gameVersion: string;
  seed: string;
  startedAt: number;
  frames: InputFrame[];
  events: Array<{ timestamp: number; type: string; data?: unknown }>;
}

export class ReplayRecorder {
  private readonly replay: Replay101;

  constructor(gameId: string, gameVersion: string, seed: string) {
    this.replay = {
      schema: 1,
      gameId,
      gameVersion,
      seed,
      startedAt: Date.now(),
      frames: [],
      events: [],
    };
  }

  recordFrame(frame: InputFrame) {
    this.replay.frames.push(structuredClone(frame));
  }

  recordEvent(type: string, data?: unknown) {
    this.replay.events.push({ timestamp: performance.now(), type, data });
  }

  snapshot(): Readonly<Replay101> {
    return structuredClone(this.replay);
  }
}
