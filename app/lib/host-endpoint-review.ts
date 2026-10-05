const encoder = new TextEncoder();
export const ENDPOINT_BYTES = 2048;
export const LOCATION_BYTES = 8192;
export const HEALTH_BYTES = 8192;
export const SESSION_BYTES = 4096;

export interface HubEndpointReview { endpoint: string; phoneEndpoints: readonly string[] }
export interface HubCandidate { endpoint: string; source: "link" | "saved" | "this device" }

export function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length <= bytes && encoder.encode(value).byteLength <= bytes;
}

export function canonicalHubEndpoint(value: unknown): string {
  if (!boundedText(value, ENDPOINT_BYTES) || !/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)
    || Array.from(value).some(character => character.charCodeAt(0) <= 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) || character === "%")) throw new Error("Choose a complete connection address.");
  const url = new URL(value);
  if (value.includes("@") || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !boundedText(url.origin, ENDPOINT_BYTES)
    || !["http:", "https:"].includes(url.protocol)) throw new Error("Choose a complete connection address.");
  return url.origin;
}

export function boundedQuery(search: string) {
  if (!boundedText(search, LOCATION_BYTES)) throw new Error("The address in this link is too long.");
  const query = new URLSearchParams(search);
  if (query.getAll("hub").length > 1 || query.getAll("session").length > 1) throw new Error("The link has more than one connection address.");
  return query;
}

export function endpointCandidates(search: string, saved: unknown, origin: string): readonly HubCandidate[] {
  const candidates: HubCandidate[] = [];
  const add = (value: unknown, source: HubCandidate["source"]) => {
    try { const endpoint = canonicalHubEndpoint(value); if (!candidates.some(candidate => candidate.endpoint === endpoint)) candidates.push({ endpoint, source }); }
    catch { /* An unverified hint may be unusable; manual address entry remains available. */ }
  };
  try { add(boundedQuery(search).get("hub"), "link"); } catch { /* Reject the complete ambiguous or oversized query. */ }
  add(saved, "saved");
  try { const url = new URL(canonicalHubEndpoint(origin)); url.port = "10101"; add(url.origin, "this device"); } catch { /* No browser origin during server rendering. */ }
  return candidates;
}

export function isLoopback(host: string) { return host === "localhost" || host === "[::1]" || (ipv4(host) && host.startsWith("127.")); }

function ipv4(value: unknown): value is string {
  return boundedText(value, 15) && value.split(".").length === 4 && value.split(".").every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}
function shareableAddress(value: string) { return !isLoopback(value) && !value.startsWith("169.254.") && Number(value.split(".")[0]) > 0 && Number(value.split(".")[0]) < 224; }
export function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validateHubHealth(value: unknown, selected: string): HubEndpointReview {
  const endpoint = canonicalHubEndpoint(selected), connection = new URL(endpoint);
  const legacyFields = ["service", "version", "endpoint", "addresses"];
  const nativeFields = [...legacyFields, "mdns", "sessionCount", "peerCount"];
  const native = closedRecord(value, nativeFields) && value.version === 2;
  if (!closedRecord(value, native ? nativeFields : legacyFields) || value.service !== "101-hub" || (!native && value.version !== 1)
    || (native && (typeof value.mdns !== "boolean" || !boundedCount(value.sessionCount, 128) ||
      !boundedCount(value.peerCount, 8192) || value.peerCount > value.sessionCount * 64))
    || !Array.isArray(value.addresses) || value.addresses.length > 32 || !value.addresses.every(ipv4)) throw new Error("The connection could not be checked.");
  const advertised = new URL(canonicalHubEndpoint(value.endpoint));
  if (advertised.protocol !== connection.protocol || advertised.port !== connection.port
    || (advertised.hostname !== connection.hostname && !isLoopback(advertised.hostname) && !ipv4(advertised.hostname))) throw new Error("The connection could not be checked.");
  const phoneEndpoints = [endpoint];
  const add = (address: string) => {
    if (!shareableAddress(address)) return;
    const candidate = new URL(endpoint); candidate.hostname = address;
    if (!phoneEndpoints.includes(candidate.origin)) phoneEndpoints.push(candidate.origin);
  };
  if (ipv4(advertised.hostname)) add(advertised.hostname);
  value.addresses.forEach(add);
  return { endpoint, phoneEndpoints };
}

function boundedCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function controllerOriginForPhone(browserOrigin: string, phoneEndpoint: string) {
  const url = new URL(canonicalHubEndpoint(browserOrigin)), phone = new URL(canonicalHubEndpoint(phoneEndpoint));
  if (isLoopback(url.hostname) && !isLoopback(phone.hostname)) url.hostname = phone.hostname;
  return url.origin;
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Connection canceled."));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readBoundedJson(response: Response, bytes: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const length = response.headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > bytes)) throw new Error("The connection reply is too large.");
  if (!response.body) throw new Error("The connection reply is incomplete.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > bytes) throw new Error("The connection reply is too large.");
      chunks.push(value);
    }
    const joined = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } finally { if (!complete) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
