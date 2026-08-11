export type TimingGrade = "perfect" | "great" | "good" | "miss";

export interface TimingWindows {
  perfect: number;
  great: number;
  good: number;
}

export interface TimingResult {
  grade: TimingGrade;
  offsetSeconds: number;
  scoreMultiplier: number;
}

export const DEFAULT_TIMING_WINDOWS: TimingWindows = {
  perfect: .065,
  great: .12,
  good: .19,
};

export function beatDurationSeconds(bpm: number) {
  return 60 / clamp(bpm, 20, 400);
}

export function beatAtTime(timeSeconds: number, bpm: number, offsetSeconds = 0) {
  return (timeSeconds - offsetSeconds) / beatDurationSeconds(bpm);
}

export function timeAtBeat(beat: number, bpm: number, offsetSeconds = 0) {
  return offsetSeconds + beat * beatDurationSeconds(bpm);
}

export function quantizeBeat(beat: number, subdivision = 4) {
  const safeSubdivision = Math.max(1, Math.round(subdivision));
  return Math.round(beat * safeSubdivision) / safeSubdivision;
}

export function judgeTiming(offsetSeconds: number, windows: TimingWindows = DEFAULT_TIMING_WINDOWS): TimingResult {
  validateWindows(windows);
  const absolute = Math.abs(offsetSeconds);
  const grade: TimingGrade = absolute <= windows.perfect
    ? "perfect"
    : absolute <= windows.great
      ? "great"
      : absolute <= windows.good
        ? "good"
        : "miss";
  return {
    grade,
    offsetSeconds,
    scoreMultiplier: grade === "perfect" ? 1 : grade === "great" ? .75 : grade === "good" ? .45 : 0,
  };
}

function validateWindows(windows: TimingWindows) {
  if (!(windows.perfect > 0 && windows.great >= windows.perfect && windows.good >= windows.great)) {
    throw new Error("101 timing windows must be positive and ordered");
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
