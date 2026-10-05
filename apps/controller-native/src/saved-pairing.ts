export interface SavedPairingStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const KEY = "101-link-last-pairing-v1";

/** Own this key through one store per process. Reading never connects or approves a ticket. */
export function createSavedPairingStore(storage: SavedPairingStorage, now = Date.now) {
  let tail = Promise.resolve();
  let pending = 0;
  function run<T>(work: () => Promise<T>, unavailable: T): Promise<T> {
    if (pending >= 8) return Promise.resolve(unavailable);
    pending += 1;
    const result = tail.then(work).catch(() => unavailable);
    tail = result.then(() => { pending -= 1; });
    return result;
  }
  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Unavailable pairing clock");
    return value;
  }
  return {
    remember(ticket: string): Promise<void> {
      // Keep queued input bounded. Validate again when its write reaches the keychain.
      if (typeof ticket !== "string" || ticket.length > 8192) return Promise.resolve();
      return run(async () => {
        ticketFromInput(ticket, clock());
        await storage.setItemAsync(KEY, ticket);
      }, undefined);
    },
    forget(): Promise<void> {
      return run(() => storage.deleteItemAsync(KEY), undefined);
    },
    read(): Promise<string | null> {
      return run(async () => {
        const saved = await storage.getItemAsync(KEY);
        if (saved === null) return null;
        const currentTime = clock();
        try { ticketFromInput(saved, currentTime); }
        catch {
          // Serialized with this owner's writes so a delayed read cannot erase a new ticket.
          try { await storage.deleteItemAsync(KEY); } catch { /* Still reject unusable credentials. */ }
          return null;
        }
        return saved;
      }, null);
    },
  };
}
import { ticketFromInput } from "./pairing-code.ts";
