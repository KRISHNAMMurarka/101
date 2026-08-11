import type { InputFrame } from "@101/input";

export interface LatencySnapshot {
  inputHz: number;
  frameAgeMs: number;
  droppedPercent: number;
  samples: number;
}

export class InputDiagnostics {
  private firstAt = 0;
  private lastAt = 0;
  private lastSequence = new Map<string, number>();
  private received = 0;
  private dropped = 0;
  private age = 0;

  observe(frame: InputFrame, now = performance.now()) {
    if (!this.firstAt) this.firstAt = now;
    this.lastAt = now;
    this.received += 1;
    this.age = Math.max(0, now - frame.timestamp);
    const previous = this.lastSequence.get(frame.deviceId);
    if (previous !== undefined && frame.sequence > previous + 1) {
      this.dropped += frame.sequence - previous - 1;
    }
    this.lastSequence.set(frame.deviceId, frame.sequence);
  }

  snapshot(): LatencySnapshot {
    const seconds = Math.max(0.001, (this.lastAt - this.firstAt) / 1000);
    const total = this.received + this.dropped;
    return {
      inputHz: this.received > 1 ? Math.round((this.received - 1) / seconds) : 0,
      frameAgeMs: Math.round(this.age * 10) / 10,
      droppedPercent: total ? Math.round((this.dropped / total) * 1000) / 10 : 0,
      samples: this.received,
    };
  }
}
