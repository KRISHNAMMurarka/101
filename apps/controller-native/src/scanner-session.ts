/** A permission request and its camera callbacks share one foreground lifetime. */
export function createScannerSession() {
  let mounted = false, foreground = false, generation = 0;
  let openGeneration: number | undefined;
  const retire = () => { generation++; openGeneration = undefined; };
  const current = (expected: number | undefined, active: boolean) =>
    mounted && foreground && active && expected !== undefined && expected === generation;
  return {
    mount(active: boolean) { retire(); mounted = true; foreground = active; },
    unmount() { retire(); mounted = false; foreground = false; },
    setForeground(active: boolean) { foreground = active; if (!active) retire(); },
    retire,
    begin(active: boolean) {
      retire();
      return mounted && foreground && active ? generation : undefined;
    },
    current,
    open(expected: number, active: boolean) {
      if (!current(expected, active)) return false;
      openGeneration = expected;
      return true;
    },
    canScan(expected: number | undefined, active: boolean) {
      return current(expected, active) && openGeneration === expected;
    },
  };
}
