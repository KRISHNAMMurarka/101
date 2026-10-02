export interface RemoteClockOptions {
  localClockId: string;
  remoteClockId: string;
  maxRttMs?: number;
  maxUncertaintyMs?: number;
  maxDriftPpm?: number;
  maxAgeMs?: number;
}

export interface RemoteClockObservation {
  localSentAt: number;
  remoteReceivedAt: number;
  remoteSentAt: number;
  localReceivedAt: number;
}

export type RemoteClockTranslation = Readonly<{
  earliest: number;
  latest: number;
  uncertaintyMs: number;
  localClockId: string;
  remoteClockId: string;
}>;

type OffsetInterval = { low: number; high: number; anchor: number };

function validTimestamp(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function clockId(value: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value.trim() !== value || Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  })) {
    throw new RangeError('Invalid clock identity');
  }
  return value;
}

function boundedOption(value: number, maximum: number, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (positive && value === 0)) {
    throw new RangeError('Invalid clock mapping option');
  }
  return value;
}

/** Conservative clock-domain translation; does not certify capture latency or freshness. */
export class RemoteClockMap {
  private readonly localClockId: string;
  private readonly remoteClockId: string;
  private readonly maxRttMs: number;
  private readonly maxUncertaintyMs: number;
  private readonly drift: number;
  private readonly driftCeilingPpm: number;
  private readonly maxAgeMs: number;
  private interval: OffsetInterval | undefined;
  private lastLocalReceipt: number | undefined;
  private lastRemoteSent: number | undefined;
  private lastLocalNow: number | undefined;

  constructor(options: RemoteClockOptions) {
    this.localClockId = clockId(options.localClockId);
    this.remoteClockId = clockId(options.remoteClockId);
    if (this.localClockId === this.remoteClockId) throw new RangeError('Clock identities must be distinct');
    this.maxRttMs = boundedOption(options.maxRttMs === undefined ? 200 : options.maxRttMs, 60000);
    this.maxUncertaintyMs = boundedOption(options.maxUncertaintyMs === undefined ? 20 : options.maxUncertaintyMs, 60000);
    this.driftCeilingPpm = boundedOption(options.maxDriftPpm === undefined ? 100 : options.maxDriftPpm, 10000);
    this.drift = this.driftCeilingPpm / 1000000;
    this.maxAgeMs = boundedOption(options.maxAgeMs === undefined ? 5000 : options.maxAgeMs, 60000, true);
  }

  /** The assumed maximum relative clock drift used in interval expansion. */
  driftPpm(): number { return this.driftCeilingPpm; }

  observe(observation: RemoteClockObservation): boolean {
    const { localSentAt, remoteReceivedAt, remoteSentAt, localReceivedAt } = observation;
    const localElapsed = localReceivedAt - localSentAt;
    const remoteElapsed = remoteSentAt - remoteReceivedAt;
    if (![localSentAt, remoteReceivedAt, remoteSentAt, localReceivedAt].every(validTimestamp)
      || localElapsed < 0 || remoteElapsed < 0 || remoteElapsed > localElapsed || localElapsed > this.maxRttMs
      || (this.lastLocalReceipt !== undefined && localSentAt < this.lastLocalReceipt)
      || (this.lastRemoteSent !== undefined && remoteReceivedAt < this.lastRemoteSent)
      || (this.lastLocalNow !== undefined && localReceivedAt < this.lastLocalNow)) {
      this.interval = undefined;
      return false;
    }

    // The raw bounds occur within the exchange; widen them to the receipt anchor.
    const padding = this.drift * localElapsed;
    let low = localSentAt - remoteReceivedAt - padding;
    let high = localReceivedAt - remoteSentAt + padding;
    const current = this.interval;
    if (current && localReceivedAt - current.anchor <= this.maxAgeMs) {
      const elapsedPadding = this.drift * (localReceivedAt - current.anchor);
      low = Math.max(low, current.low - elapsedPadding);
      high = Math.min(high, current.high + elapsedPadding);
      if (low > high) {
        this.interval = undefined;
        return false;
      }
    }

    this.interval = { low, high, anchor: localReceivedAt };
    this.lastLocalReceipt = localReceivedAt;
    this.lastRemoteSent = remoteSentAt;
    this.lastLocalNow = localReceivedAt;
    return true;
  }

  translate(remoteAt: number, localNow: number): RemoteClockTranslation | undefined {
    const current = this.interval;
    if (!current || !validTimestamp(localNow)) return undefined;
    if (localNow < current.anchor || (this.lastLocalNow !== undefined && localNow < this.lastLocalNow)) {
      this.interval = undefined;
      return undefined;
    }
    this.lastLocalNow = localNow;
    const age = localNow - current.anchor;
    if (age > this.maxAgeMs || !validTimestamp(remoteAt)) return undefined;

    const baseEarliest = remoteAt + current.low;
    const baseLatest = remoteAt + current.high;
    // Divide by the minimum clock rate to bound the distance to the unknown
    // local instant represented by remoteAt, including historical timestamps.
    const elapsed = Math.max(age, Math.abs(baseEarliest - current.anchor) / (1 - this.drift), Math.abs(baseLatest - current.anchor) / (1 - this.drift));
    const padding = this.drift * elapsed;
    const earliest = baseEarliest - padding;
    const latest = baseLatest + padding;
    const uncertaintyMs = (latest - earliest) / 2;
    if (!validTimestamp(earliest) || !validTimestamp(latest) || uncertaintyMs > this.maxUncertaintyMs) return undefined;
    return Object.freeze({ earliest, latest, uncertaintyMs, localClockId: this.localClockId, remoteClockId: this.remoteClockId });
  }

  reset(): void {
    this.interval = undefined;
    this.lastLocalReceipt = undefined;
    this.lastRemoteSent = undefined;
    this.lastLocalNow = undefined;
  }
}
