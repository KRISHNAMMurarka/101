interface ThresholdConfiguration { unit: string; onAt: number; offAt: number; revision: number }

/** App-owned set-state processor. An in-band first reading leaves state unknown. */
export function createTemperatureThreshold(configuration: ThresholdConfiguration) {
  const { unit, onAt, offAt, revision } = configuration;
  if (unit !== 'Cel' || !Number.isFinite(onAt) || !Number.isFinite(offAt) || onAt <= offAt || !Number.isInteger(revision) || revision < 1) throw new RangeError('A Celsius threshold requires ordered finite limits and a positive revision');
  let state: boolean | undefined;
  const metadata = Object.freeze({ id: 'example:temperature-threshold', version: '1.0.0', configurationRevision: revision, unit, onAt, offAt });
  return {
    metadata,
    evaluate(temperature: number): boolean | undefined {
      if (!Number.isFinite(temperature)) throw new RangeError('Temperature must be finite');
      const next = temperature >= onAt ? true : temperature <= offAt ? false : state;
      if (next === state) return undefined;
      state = next;
      return next;
    },
    reset() { state = undefined; },
  };
}
