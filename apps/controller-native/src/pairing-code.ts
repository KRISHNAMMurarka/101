import { fromByteArray, toByteArray } from "base64-js";
import { inflate } from "pako";

import { PROTOCOL_VERSION, pairingCodeFromInput, type PairingTicket } from "@101/protocol";

interface TicketEnvelope extends PairingTicket {
  checksum: string;
}

interface PairingEnvelope {
  v: typeof PROTOCOL_VERSION;
  type: "offer" | "answer";
  sdp: string;
  checksum: string;
}

export function ticketFromInput(input: string, now = Date.now()) {
  if (typeof input !== "string" || input.length > 8192) throw new Error("Paste or scan a valid 101 Link pairing code");
  const trimmed = input.trim();
  if (/^[A-Z0-9]{6}$/i.test(trimmed)) {
    throw new Error("This room code only names the game. Scan or paste the full connection link.");
  }
  let code: string;
  try { code = pairingCodeFromInput(input); }
  catch { throw new Error("Paste or scan a valid 101 Link pairing code"); }
  return decodeNativePairingTicket(code, now);
}

export function decodeNativePairingTicket(code: string, now = Date.now()): PairingTicket {
  if (typeof code !== "string" || code.length > 4096 || !Number.isSafeInteger(now) || now < 0)
    throw new Error("Paste or scan a valid 101 Link pairing code");
  const normalized = code.trim();
  if (normalized.length > 4096 || !normalized.startsWith("101L2.")) {
    throw new Error("Paste or scan a valid 101 Link pairing code");
  }
  const encoded = normalized.slice(6);
  const bytes = fromBase64Url(encoded);
  if (toBase64Url(bytes) !== encoded) throw new Error("Invalid pairing encoding");
  const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<TicketEnvelope>;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).some(key => !["version", "sessionId", "endpoint", "joinToken", "expiresAt", "hostName", "transport", "checksum"].includes(key)))
    throw new Error("Unsupported or malformed 101 pairing ticket");
  const { checksum: received, ...candidate } = envelope;
  const ticket = validateTicket(candidate);
  if (received !== checksum(JSON.stringify(ticket))) throw new Error("Pairing ticket failed integrity validation");
  if (ticket.expiresAt <= now) throw new Error("Pairing ticket has expired");
  if (ticket.expiresAt - now > 86_400_000) throw new Error("Pairing ticket has an invalid lifetime");
  return Object.freeze(ticket);
}

export function decodeDescription(code: string): { type: "offer" | "answer"; sdp: string } {
  const normalized = code.trim();
  if (normalized.length > 400_000) throw new Error("Pairing code is too large");
  const [prefix, encoded, extra] = normalized.split(".");
  if (extra !== undefined || !encoded || (prefix !== "101J2" && prefix !== "101C2")) {
    throw new Error("Invalid 101 WebRTC pairing code");
  }
  const compressed = fromBase64Url(encoded);
  const bytes = prefix === "101C2" ? inflate(compressed) : compressed;
  if (bytes.byteLength > 300_000) throw new Error("Pairing code expands beyond the allowed size");
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PairingEnvelope>;
  if (envelope.v !== PROTOCOL_VERSION || (envelope.type !== "offer" && envelope.type !== "answer") || !envelope.sdp) {
    throw new Error("Unsupported or malformed 101 pairing code");
  }
  if (envelope.checksum !== checksum(`${envelope.type}\n${envelope.sdp}`)) {
    throw new Error("Pairing code failed integrity validation");
  }
  return { type: envelope.type, sdp: envelope.sdp };
}

export function encodeDescription(description: { type: string; sdp?: string | null }) {
  if ((description.type !== "offer" && description.type !== "answer") || !description.sdp) {
    throw new Error("Incomplete WebRTC description");
  }
  const envelope: PairingEnvelope = {
    v: PROTOCOL_VERSION,
    type: description.type,
    sdp: description.sdp,
    checksum: checksum(`${description.type}\n${description.sdp}`),
  };
  return `101J2.${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`;
}

function validateTicket(value: Partial<PairingTicket>): PairingTicket {
  if (value.version !== PROTOCOL_VERSION || value.transport !== "webrtc") throw new Error("Unsupported 101 pairing ticket");
  if (typeof value.sessionId !== "string" || !/^[A-Z0-9-]{4,128}$/i.test(value.sessionId)) throw new Error("Invalid pairing session");
  if (typeof value.joinToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value.joinToken)) throw new Error("Invalid pairing authorization");
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0) throw new Error("Invalid pairing expiration");
  if (typeof value.endpoint !== "string" || !value.endpoint || value.endpoint.length > 2048
    || unsafeText(value.endpoint, true) || value.endpoint.includes("\\")) throw new Error("Invalid pairing endpoint");
  const endpoint = new URL(value.endpoint);
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.hash
    || endpoint.search || endpoint.pathname !== "/") {
    throw new Error("Invalid pairing endpoint");
  }
  if (value.hostName !== undefined && (typeof value.hostName !== "string" || !value.hostName || value.hostName.length > 128
    || unsafeText(value.hostName))) throw new Error("Invalid host name");
  const hostName = value.hostName;
  return {
    version: PROTOCOL_VERSION,
    sessionId: value.sessionId,
    endpoint: endpoint.origin,
    joinToken: value.joinToken,
    expiresAt: Number(value.expiresAt),
    ...(hostName ? { hostName } : {}),
    transport: "webrtc",
  };
}

function unsafeText(value: string, spaces = false) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= (spaces ? 32 : 31) || code >= 127 && code <= 159) return true;
  }
  return false;
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid pairing encoding");
  return toByteArray(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

function toBase64Url(bytes: Uint8Array) {
  return fromByteArray(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function checksum(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
