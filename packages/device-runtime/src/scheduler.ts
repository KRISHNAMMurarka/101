export type OperationState = "accepted" | "dispatched" | "target-acknowledged" | "observed"
  | "unverified" | "failed" | "cancelled" | "expired";
export type Evidence = "dispatched" | "target-acknowledged" | "observed" | "unverified";
export type HandlerResult = "not-started" | "running" | "returned" | "failed";
export type EffectEvidence = "none" | "dispatched" | "target-acknowledged" | "observed";
export interface OperationRecord { id: string; deadline: number; state: OperationState;
  handlerResult: HandlerResult; effectEvidence: EffectEvidence }
export type Result<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };
export const success = <T = undefined>(value = undefined as T): Result<T> => ({ ok: true, value });
export const failure = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export class LatestSlot<T> {
  private pending?: { value: T; receivedAt: number };
  get size(): number { return this.pending ? 1 : 0; }
  offer(value: T, receivedAt: number): void { this.pending = { value, receivedAt }; }
  take(now: number, maxAgeMs: number): T | undefined {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || now < pending.receivedAt || now - pending.receivedAt > maxAgeMs) return undefined;
    return pending.value;
  }
  clear(): void { this.pending = undefined; }
}

interface Entry<T> extends OperationRecord { value?: T; settled: boolean; pinned: boolean; retainUntil: number }
const EVIDENCE_RANK: Record<Evidence, number> = {
  dispatched: 1, unverified: 2, "target-acknowledged": 3, observed: 4,
};
const EFFECT_RANK: Record<EffectEvidence, number> = {
  none: 0, dispatched: 1, "target-acknowledged": 2, observed: 3,
};

/** Decimal monotonic IDs permit bounded replay protection even after history expires. */
export class OperationQueue<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private watermark = 0;
  private readonly capacity: number;

  constructor(capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) throw new RangeError("Invalid operation capacity");
    this.capacity = capacity;
  }

  get pending(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (!entry.settled) count++;
    return count;
  }

  admit(id: string, deadline: number, value: T, now: number): Result {
    this.purge(now);
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== id) return failure("invalid-operation-id");
    if (!Number.isFinite(deadline) || deadline <= now) return failure("expired");
    if (this.entries.has(id)) return failure("duplicate-operation");
    if (number <= this.watermark) return failure("stale-operation");
    if (this.entries.size >= this.capacity) {
      // Settled, unpinned records are diagnostic history, not queued work.
      // The monotonic watermark still rejects replay after a record is retired.
      for (const [previousId, entry] of this.entries) {
        if (entry.settled && !entry.pinned) {
          this.entries.delete(previousId);
          break;
        }
      }
      if (this.entries.size >= this.capacity) return failure("capacity");
    }
    this.watermark = number;
    this.entries.set(id, { id, deadline, value, state: "accepted", handlerResult: "not-started",
      effectEvidence: "none", settled: false, pinned: false, retainUntil: deadline + 1000 });
    return success();
  }

  next(now: number): { id: string; deadline: number; value: T } | undefined {
    this.expire(now);
    for (const entry of this.entries.values()) {
      if (!entry.settled && entry.state === "accepted") {
        entry.state = "dispatched";
        const value = entry.value as T;
        entry.value = undefined;
        return { id: entry.id, deadline: entry.deadline, value };
      }
    }
  }

  started(id: string): void {
    const entry = this.entries.get(id);
    if (entry && !entry.settled && entry.handlerResult === "not-started") entry.handlerResult = "running";
  }

  evidence(id: string, evidence: Evidence): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const previous = EVIDENCE_RANK[entry.state as Evidence] ?? 0;
    // A late issued/returned report preserves history, not renewed work. Stronger
    // target acknowledgement/observation can still update actual effect evidence.
    const retired = entry.settled && !(entry.state in EVIDENCE_RANK);
    if (EVIDENCE_RANK[evidence] > previous && (!retired || evidence === "target-acknowledged" || evidence === "observed")) entry.state = evidence;
    if (evidence !== "unverified" && EFFECT_RANK[evidence] > EFFECT_RANK[entry.effectEvidence])
      entry.effectEvidence = evidence;
  }

  settle(id: string, state: OperationState): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.handlerResult === "running") {
      if (state === "failed") entry.handlerResult = "failed";
      else if (state === "unverified") entry.handlerResult = "returned";
    }
    if (entry.settled) return;
    if (state in EVIDENCE_RANK) this.evidence(id, state as Evidence);
    else if (entry.state !== "observed") entry.state = state;
    entry.settled = true;
    entry.value = undefined;
  }

  pin(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.pinned = true;
  }

  unpin(id: string, now: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.pinned = false;
    entry.retainUntil = Math.max(entry.retainUntil, now + 1000);
  }

  expire(now: number): readonly string[] {
    const expired: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.settled && entry.deadline <= now) {
        this.settle(entry.id, "expired");
        expired.push(entry.id);
      }
    }
    return expired;
  }

  purge(now: number): void {
    this.expire(now);
    for (const [id, entry] of this.entries) {
      if (entry.settled && !entry.pinned && entry.retainUntil <= now) this.entries.delete(id);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) if (!entry.settled) this.settle(entry.id, "cancelled");
  }

  records(): readonly OperationRecord[] {
    return Object.freeze([...this.entries.values()].map(({ id, deadline, state, handlerResult, effectEvidence }) =>
      Object.freeze({ id, deadline, state, handlerResult, effectEvidence })));
  }
}
