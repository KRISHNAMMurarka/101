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

test("native Link decodes protocol tickets from codes and controller URLs", () => {
  const code = encodePairingTicket(ticket);
  assert.deepEqual(decodeNativePairingTicket(code, 1_900_000_000_000), ticket);
  assert.deepEqual(ticketFromInput(`https://host.local/controller?pair=${code}`, 1_900_000_000_000), ticket);
  assert.deepEqual(ticketFromInput(`oneohone://pair?ticket=${code}`, 1_900_000_000_000), ticket);
});

test("native Link rejects expired and modified tickets", () => {
  const code = encodePairingTicket(ticket);
  assert.throws(() => decodeNativePairingTicket(code, ticket.expiresAt), /expired/);
  assert.throws(() => decodeNativePairingTicket(`${code.slice(0, -1)}A`, 1_900_000_000_000));
});

test("native Link reads compressed browser offers and browser reads native answers", async () => {
  const offer = { type: "offer" as const, sdp: "v=0\r\na=setup:actpass\r\n".repeat(32) };
  const compressed = await encodePairingDescription(offer, true);
  assert.deepEqual(decodeDescription(compressed), offer);

  const answer = { type: "answer" as const, sdp: "v=0\r\na=setup:active\r\n" };
  const native = encodeDescription(answer);
  assert.deepEqual(await decodePairingDescription(native), answer);
});
