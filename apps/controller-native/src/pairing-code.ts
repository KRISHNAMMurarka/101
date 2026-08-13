import { fromByteArray, toByteArray } from "base64-js";
import { inflate } from "pako";

import { PROTOCOL_VERSION, type PairingTicket } from "@101/protocol";

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
  const trimmed = input.trim();
  let code = trimmed;
  if (!trimmed.startsWith("101L2.")) {
    const url = new URL(trimmed);
    code = url.searchParams.get("pair") ?? (url.protocol === "oneohone:" ? url.searchParams.get("ticket") ?? "" : "");
  }
  return decodeNativePairingTicket(code, now);
}

export function decodeNativePairingTicket(code: string, now = Date.now()): PairingTicket {
  const normalized = code.trim();
  if (normalized.length > 4096 || !normalized.startsWith("101L2.")) {
    throw new Error("Paste or scan a valid 101 Link pairing code");
  }
  const envelope = JSON.parse(new TextDecoder().decode(fromBase64Url(normalized.slice(6)))) as Partial<TicketEnvelope>;
  const { checksum: received, ...candidate } = envelope;
  const ticket = validateTicket(candidate);
  if (received !== checksum(JSON.stringify(ticket))) throw new Error("Pairing ticket failed integrity validation");
  if (ticket.expiresAt <= now) throw new Error("Pairing ticket has expired");
  return ticket;
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
  if (!value.sessionId || !/^[A-Z0-9-]{4,128}$/i.test(value.sessionId)) throw new Error("Invalid pairing session");
  if (!value.joinToken || !/^[A-Za-z0-9_-]{32,256}$/.test(value.joinToken)) throw new Error("Invalid pairing authorization");
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0) throw new Error("Invalid pairing expiration");
  if (!value.endpoint) throw new Error("Invalid pairing endpoint");
  const endpoint = new URL(value.endpoint);
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Invalid pairing endpoint");
  }
  const hostName = typeof value.hostName === "string" && value.hostName.length <= 128 ? value.hostName : undefined;
  return {
    version: PROTOCOL_VERSION,
    sessionId: value.sessionId,
    endpoint: endpoint.toString().replace(/\/$/, ""),
    joinToken: value.joinToken,
    expiresAt: Number(value.expiresAt),
    ...(hostName ? { hostName } : {}),
    transport: "webrtc",
  };
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
