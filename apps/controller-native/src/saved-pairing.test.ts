import assert from "node:assert/strict";
import test from "node:test";
import { encodePairingTicket } from "@101/protocol";
import { createSavedPairingStore, type SavedPairingStorage } from "./saved-pairing.ts";

const NOW = 2_000_000_000_000;
const ticket = (expiresAt: number) => encodePairingTicket({ version: 2, sessionId: "SAVE-101",
  endpoint: "http://127.0.0.1:4175", joinToken: "a".repeat(43), expiresAt, transport: "webrtc" });
function memory(value: string | null) {
  const keys: string[] = [];
  const port: SavedPairingStorage = {
    async getItemAsync(key) { keys.push(key); return value; },
    async setItemAsync(key, next) { keys.push(key); value = next; },
    async deleteItemAsync(key) { keys.push(key); value = null; },
  };
  return { port, keys, value: () => value };
}

test("saved native pairing rejects and removes an expired producer ticket at next read", async () => {
  const storage = memory(ticket(NOW));
  assert.equal(await createSavedPairingStore(storage.port, () => NOW).read(), null);
  assert.equal(storage.value(), null);
  assert.ok(storage.keys.every(key => key === "101-link-last-pairing-v1"));
});

test("saved pairing returns a valid reviewed input unchanged without connecting or deleting", async () => {
  const code = `oneohone://pair?ticket=${ticket(NOW + 60_000)}`;
  const storage = memory(code);
  const store = createSavedPairingStore(storage.port, () => NOW);
  assert.deepEqual(storage.keys, []);
  assert.equal(await store.read(), code);
  assert.equal(storage.keys.length, 1);
  assert.equal(storage.value(), code);
});

test("corrupt, unbounded and unsupported saved input is removed from its one owned key", async () => {
  for (const code of ["101WHV", "not a ticket", "x".repeat(8193), `${ticket(NOW + 60_000)}A`]) {
    const storage = memory(code);
    assert.equal(await createSavedPairingStore(storage.port, () => NOW).read(), null);
    assert.equal(storage.value(), null);
  }
});

test("expiry is checked after a delayed keychain read finishes", async () => {
  let now = NOW;
  const storage = memory(ticket(NOW + 1));
  const get = storage.port.getItemAsync;
  storage.port.getItemAsync = async key => { const result = await get(key); now += 1; return result; };
  assert.equal(await createSavedPairingStore(storage.port, () => now).read(), null);
  assert.equal(storage.value(), null);
});

test("failed cleanup still rejects the credential; unavailable reads and clocks preserve bytes", async () => {
  const storage = memory(ticket(NOW));
  storage.port.deleteItemAsync = async () => { throw new Error("Keychain unavailable"); };
  assert.equal(await createSavedPairingStore(storage.port, () => NOW).read(), null);
  assert.equal(storage.value(), ticket(NOW));
  for (const now of [NaN, Infinity, -1, NOW + 0.5]) {
    const valid = memory(ticket(NOW + 60_000));
    assert.equal(await createSavedPairingStore(valid.port, () => now).read(), null);
    assert.equal(valid.keys.length, 1);
    assert.equal(valid.value(), ticket(NOW + 60_000));
  }
  const unavailable = memory(ticket(NOW + 60_000));
  unavailable.port.getItemAsync = async () => { throw new Error("Keychain unavailable"); };
  assert.equal(await createSavedPairingStore(unavailable.port, () => NOW).read(), null);
  assert.equal(unavailable.value(), ticket(NOW + 60_000));
});

test("a delayed expired read cannot erase a newer remembered credential", async () => {
  const storage = memory(ticket(NOW));
  const get = storage.port.getItemAsync;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  storage.port.getItemAsync = async key => { const result = await get(key); await blocked; return result; };
  const store = createSavedPairingStore(storage.port, () => NOW);
  const read = store.read();
  const next = ticket(NOW + 60_000);
  const write = store.remember(next);
  release();
  assert.equal(await read, null);
  await write;
  assert.equal(storage.value(), next);
  assert.equal(await store.read(), next);
});

test("unusable writes and persistence failures do not fail the live connection", async () => {
  const storage = memory(null);
  const store = createSavedPairingStore(storage.port, () => NOW);
  for (const code of [ticket(NOW), "101WHV", "x".repeat(8193)]) await store.remember(code);
  assert.equal(storage.keys.length, 0);
  storage.port.setItemAsync = async () => { throw new Error("Keychain unavailable"); };
  await store.remember(ticket(NOW + 60_000));
  await store.forget();
  assert.equal(await store.read(), null);
});

test("a stalled keychain holds at most eight operations and queue admission recovers", async () => {
  const storage = memory(ticket(NOW + 60_000));
  const get = storage.port.getItemAsync;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  storage.port.getItemAsync = async key => { await blocked; return get(key); };
  const store = createSavedPairingStore(storage.port, () => NOW);
  const pending = Array.from({ length: 8 }, () => store.read());
  assert.equal(await store.read(), null);
  release();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(ticket(NOW + 60_000)));
  assert.equal(storage.keys.length, 8);
  assert.equal(await store.read(), ticket(NOW + 60_000));
});
