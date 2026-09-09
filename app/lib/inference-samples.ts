/** A short rolling window keeps a performance receipt useful without retaining a session history. */
export const INFERENCE_SAMPLE_WINDOW = 120;

export interface InferenceSampleSummary {
  readonly count: number;
  readonly minimumMs: number;
  readonly meanMs: number;
  readonly medianMs: number;
  /** Nearest-rank 95th percentile, so a short capture never claims a fractional frame. */
  readonly p95Ms: number;
  readonly maximumMs: number;
}

export function appendInferenceSample(samples: readonly number[], durationMs: number, windowSize = INFERENCE_SAMPLE_WINDOW): readonly number[] {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new RangeError("Inference sample window must be a positive integer");
  if (!Number.isFinite(durationMs) || durationMs < 0) return samples.slice(-windowSize);
  return [...samples.slice(-(windowSize - 1)), durationMs];
}

export function summarizeInferenceSamples(samples: readonly number[]): InferenceSampleSummary | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const midpoint = Math.floor(count / 2);
  const medianMs = count % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!;
  const meanMs = sorted.reduce((total, sample) => total + sample, 0) / count;
  return {
    count,
    minimumMs: sorted[0]!,
    meanMs,
    medianMs,
    p95Ms: sorted[Math.ceil(count * .95) - 1]!,
    maximumMs: sorted[count - 1]!,
  };
}
