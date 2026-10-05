/** Application-owned pairing: preparing or declining a candidate cannot release the owner. */
export function createConnectionOwnership<T extends { dispose(): void }>() {
  let owner: T | undefined, candidate: T | undefined;
  const dispose = (value: T | undefined) => { try { value?.dispose(); } catch { /* Ownership is already retired. */ } };
  const discard = (expected = candidate): void => {
    if (!expected || candidate !== expected) return;
    candidate = undefined; dispose(expected);
  };
  return {
    current: () => owner,
    pending: () => candidate,
    selected: () => candidate ?? owner,
    stage(value: T): void { discard(); candidate = value; },
    discard,
    retire(value: T): void {
      if (owner === value) { owner = undefined; dispose(value); }
      else discard(value);
    },
    /** Called after consent. A failed activation leaves the slot released. */
    activate(value: T, start: () => boolean): boolean {
      if (candidate !== value) return false;
      const previous = owner; owner = undefined; dispose(previous);
      if (candidate !== value) return false;
      let ready = false; try { ready = start(); } catch { /* Recover through fresh consent. */ }
      if (candidate !== value) return false;
      if (!ready) { discard(value); return false; }
      candidate = undefined; owner = value; return true;
    },
    clear(): void {
      const oldOwner = owner, oldCandidate = candidate;
      owner = undefined; candidate = undefined;
      dispose(oldCandidate); dispose(oldOwner);
    },
  };
}
