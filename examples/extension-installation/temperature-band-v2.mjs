/** Reviewed v2 uses strict boundaries, making update and rollback observable at exactly 30 Cel. */
export function createTemperatureBand({ onAt, offAt }) {
  if (!Number.isFinite(onAt) || !Number.isFinite(offAt) || offAt >= onAt) throw new TypeError('temperature-thresholds');
  let state;
  return {
    process({ temperature }) {
      const next = temperature > onAt ? true : temperature <= offAt ? false : state;
      if (next === undefined || next === state) return undefined;
      state = next; return { switch: state };
    },
    reset() { state = undefined; },
  };
}
