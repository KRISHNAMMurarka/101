import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePairingDescription,
  encodePairingDescription,
  encodePairingTicket,
  type PairingTicket,
} from "@101/protocol";

import {
  decodeDescription,
  decodeNativePairingTicket,
  encodeDescription,
  ticketFromInput,
} from "./pairing-code.ts";

const ticket: PairingTicket = {
  version: 2,
  sessionId: "SESSION-101",
  endpoint: "http://192.168.1.20:4175",
  joinToken: "a".repeat(43),
  expiresAt: 2_000_000_000_000,
  hostName: "Living Room",
  transport: "webrtc",
};
const now = ticket.expiresAt - 60_000;

test("native Link decodes protocol tickets from codes and controller URLs", () => {
  const code = encodePairingTicket(ticket);
  assert.deepEqual(decodeNativePairingTicket(code, now), ticket);
  assert.deepEqual(ticketFromInput(`https://host.local/controller?pair=${code}`, now), ticket);
  assert.deepEqual(ticketFromInput(`oneohone://pair?ticket=${code}`, now), ticket);
});

test("native Link rejects expired and modified tickets", () => {
  const code = encodePairingTicket(ticket);
  assert.throws(() => decodeNativePairingTicket(code, ticket.expiresAt), /expired/);
  assert.throws(() => decodeNativePairingTicket(`${code.slice(0, -1)}A`, now));
});

test("native intake rejects arbitrary link schemes, duplicates and oversized outer input", () => {
  const code = encodePairingTicket(ticket);
  for (const input of [
    `file:///controller?pair=${code}`,
    `https://host.local/other?pair=${code}`,
    `https://host.local/controller?pair=${code}&pair=${code}`,
    `oneohone://other?ticket=${code}`,
    `${" ".repeat(8193)}${code}`,
  ]) assert.throws(() => ticketFromInput(input, now));
});

test("native ticket time is finite and its remaining lifetime is bounded", () => {
  const code = encodePairingTicket(ticket);
  for (const invalidNow of [NaN, Infinity, -1, now + 0.5])
    assert.throws(() => decodeNativePairingTicket(code, invalidNow));
  assert.throws(() => decodeNativePairingTicket(code, ticket.expiresAt - 86_400_001));
});

test("native envelope rejects unknown fields even with the original producer checksum", () => {
  const code = encodePairingTicket(ticket);
  const envelope = JSON.parse(Buffer.from(code.slice(6), "base64url").toString());
  envelope.hiddenEndpoint = "https://elsewhere.invalid";
  const extra = `101L2.${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
  assert.throws(() => decodeNativePairingTicket(extra, now));
});

test("native ticket intake uses its installed codec without browser atob", () => {
  const code = encodePairingTicket(ticket);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "atob")!;
  Reflect.deleteProperty(globalThis, "atob");
  try {
    assert.deepEqual(decodeNativePairingTicket(code, now), ticket);
    assert.deepEqual(ticketFromInput(`oneohone://pair?ticket=${code}`, now), ticket);
  } finally { Object.defineProperty(globalThis, "atob", descriptor); }
});

test("native Link explains why a short room code cannot authorize pairing", () => {
  assert.throws(
    () => ticketFromInput("101WHV"),
    /room code only names the game.*full connection link/i,
  );
});

test("native Link explains malformed pasted links without raw URL errors", () => {
  assert.throws(() => ticketFromInput("https://"), /valid 101 Link pairing code/i);
  assert.throws(() => ticketFromInput("not a link"), /valid 101 Link pairing code/i);
});

test("native Link reads compressed browser offers and browser reads native answers", async () => {
  const offer = { type: "offer" as const, sdp: "v=0\r\na=setup:actpass\r\n".repeat(32) };
  const compressed = await encodePairingDescription(offer, true);
  assert.deepEqual(decodeDescription(compressed), offer);

  const answer = { type: "answer" as const, sdp: "v=0\r\na=setup:active\r\n" };
  const native = encodeDescription(answer);
  assert.deepEqual(await decodePairingDescription(native), answer);
});
