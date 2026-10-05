/** Independent pure processor: the host owns all resources and lifecycle. */
export function createTemperatureBand(configuration) {
  const { onAt, offAt } = configuration;
  if (!Number.isFinite(onAt) || !Number.isFinite(offAt) || onAt <= offAt)
    throw new RangeError('Temperature band requires ordered finite limits');
  let state;
  return {
    process(inputs) {
      const value = inputs.temperature;
      const next = value >= onAt ? true : value <= offAt ? false : state;
      if (next === state) return undefined;
      state = next;
      return { switch: next };
    },
    reset() { state = undefined; },
  };
}
