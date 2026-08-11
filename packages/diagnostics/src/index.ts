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

export interface NetworkSnapshot {
  roundTripMs: number;
  jitterMs: number;
  droppedPercent: number;
  receivedPackets: number;
  sentPings: number;
}

export class NetworkDiagnostics {
  private readonly roundTrips: number[] = [];
  private readonly lastSequence = new Map<string, number>();
  private received = 0;
  private dropped = 0;
  private pings = 0;

  sentPing() {
    this.pings += 1;
  }

  observeRoundTrip(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.roundTrips.push(milliseconds);
    if (this.roundTrips.length > 120) this.roundTrips.shift();
  }

  observeFrame(frame: Pick<InputFrame, "deviceId" | "sequence">) {
    const previous = this.lastSequence.get(frame.deviceId);
    if (previous !== undefined && frame.sequence > previous + 1) {
      this.dropped += frame.sequence - previous - 1;
    }
    if (previous === undefined || frame.sequence > previous) {
      this.received += 1;
      this.lastSequence.set(frame.deviceId, frame.sequence);
    }
  }

  snapshot(): NetworkSnapshot {
    const average = this.roundTrips.length
      ? this.roundTrips.reduce((sum, value) => sum + value, 0) / this.roundTrips.length
      : 0;
    const jitter = this.roundTrips.length > 1
      ? this.roundTrips.slice(1).reduce((sum, value, index) => sum + Math.abs(value - this.roundTrips[index]!), 0) / (this.roundTrips.length - 1)
      : 0;
    const packets = this.received + this.dropped;
    return {
      roundTripMs: roundOne(average),
      jitterMs: roundOne(jitter),
      droppedPercent: packets ? roundOne((this.dropped / packets) * 100) : 0,
      receivedPackets: this.received,
      sentPings: this.pings,
    };
  }
}

const roundOne = (value: number) => Math.round(value * 10) / 10;
