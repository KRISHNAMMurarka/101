import { AutomaticPairingHost, HttpHostSignalingClient, createHttpSignalingSession } from "@101/pairing";
import {
  BroadcastChannelTransport, MultiplexLinkTransport, createControllerPairingUrl, decodePairingTicket, encodePairingTicket,
  type ControlMessage, type LinkMessage, type LinkTransport, type PairingTicket, type RealtimeMessage,
} from "@101/protocol";
import {
  HEALTH_BYTES, LOCATION_BYTES, SESSION_BYTES, abortable, boundedQuery, boundedText, canonicalHubEndpoint,
  closedRecord, controllerOriginForPhone, endpointCandidates, isLoopback, readBoundedJson, validateHubHealth,
  type HubEndpointReview,
} from "./host-endpoint-review.ts";

export interface BrowserPairingInfo { ticket: PairingTicket; controllerUrl: string; hubEndpoint: string }
export interface BrowserPairingOptions { signal?: AbortSignal; phoneEndpoint?: string }
const sessions = new Map<string, BrowserHostTransport>();
const HOST_AUTHORITY_PREFIX = "101.hub.host.";
const desktopHostHandoffs = new Map<string, { endpoint: string; hostToken: string }>();
captureDesktopHostHandoff();

export function readBrowserHubCandidates() {
  if (typeof window === "undefined") return [];
  let saved: string | null = null;
  try { saved = localStorage.getItem("101.hub.endpoint"); } catch { /* Manual selection works without storage. */ }
  if (window.location.href && !boundedText(window.location.href, LOCATION_BYTES)) return endpointCandidates("", null, window.location.origin);
  return endpointCandidates(window.location.search, saved, window.location.origin);
}

export function getBrowserHostTransport(sessionId: string) {
  let transport = sessions.get(sessionId);
  if (!transport) { transport = new BrowserHostTransport(sessionId); sessions.set(sessionId, transport); }
  return transport;
}

export class BrowserHostTransport implements LinkTransport {
  private readonly multiplex = new MultiplexLinkTransport();
  private readonly sessionId: string;
  private readonly initialized: Promise<void>;
  private pairing?: Promise<BrowserPairingInfo>;
  private pairingKey?: string;
  private pairingExpiresAt = 0;
  private pending?: AbortController;
  private revision = 0;
  private automatic?: AutomaticPairingHost;
  private liveAuthority?: { endpoint: string; hostToken: string; expiresAt: number };
  private leaseCount = 0;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    captureDesktopHostHandoff();
    this.initialized = this.multiplex.add("same-browser", new BroadcastChannelTransport(sessionId));
  }
  async connect() {
    this.leaseCount += 1;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    await this.initialized;
    await this.serializeLifecycle(async () => { if (!this.connected) { await this.multiplex.connect(); this.connected = true; } });
  }
  async disconnect() {
    this.leaseCount = Math.max(0, this.leaseCount - 1);
    if (this.leaseCount > 0 || this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => void this.closeIfUnused(), 5_000);
  }
  sendReliable(message: ControlMessage) { this.multiplex.sendReliable(message); }
  sendRealtime(message: RealtimeMessage) { this.multiplex.sendRealtime(message); }
  onMessage(callback: (message: LinkMessage) => void) { return this.multiplex.onMessage(callback); }

  async reviewEndpoint(selected: string, options: { signal?: AbortSignal } = {}): Promise<HubEndpointReview> {
    const endpoint = canonicalHubEndpoint(selected), signal = requestSignal(options.signal);
    const response = await fixedResponse(endpoint, `${endpoint}/v1/health`, {}, signal);
    if (!response.ok) throw new Error("The connection is unavailable.");
    const review = validateHubHealth(await readBoundedJson(response, HEALTH_BYTES, signal), endpoint);
    signal.throwIfAborted();
    return review;
  }

  async preparePairing(selected: string, options: BrowserPairingOptions = {}): Promise<BrowserPairingInfo> {
    const endpoint = canonicalHubEndpoint(selected), phoneEndpoint = canonicalHubEndpoint(options.phoneEndpoint ?? endpoint);
    options.signal?.throwIfAborted();
    const key = `${endpoint}\n${phoneEndpoint}`;
    if (this.pairing && this.pairingKey === key && !this.pending && this.pairingExpiresAt > Date.now()) return this.pairing;
    const obsolete = this.pending ? this.pairing : undefined;
    this.pending?.abort();
    const pending = new AbortController(), revision = ++this.revision;
    this.pending = pending; this.pairingKey = key;
    const signal = options.signal ? AbortSignal.any([options.signal, pending.signal]) : pending.signal;
    const operation = (async () => {
      // Old peer teardown owns the same multiplex transport until its attempt has fully settled.
      await obsolete?.catch(() => undefined);
      signal.throwIfAborted();
      return this.createPairing(endpoint, phoneEndpoint, revision, signal);
    })();
    this.pairing = operation;
    try { return await operation; }
    catch (error) { if (this.revision === revision) { this.pairing = undefined; this.pairingKey = undefined; } throw error; }
    finally { if (this.revision === revision) this.pending = undefined; }
  }

  private async createPairing(endpoint: string, phoneEndpoint: string, revision: number, signal: AbortSignal): Promise<BrowserPairingInfo> {
    const current = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error("Connection canceled."); };
    current();
    const previous = this.automatic; this.automatic = undefined;
    await previous?.stop(); current();
    const review = await this.reviewEndpoint(endpoint, { signal }); current();
    if (!review.phoneEndpoints.includes(phoneEndpoint)) throw new Error("Check and select the phone address again.");
    const handoff = desktopHostHandoffs.get(this.sessionId);
    let hostToken = this.liveAuthority?.endpoint === endpoint && this.liveAuthority.expiresAt > Date.now()
      ? this.liveAuthority.hostToken : loadHostAuthority(endpoint, this.sessionId);
    const fetcher: typeof fetch = async (input, init) => {
      const activeSignal = requestSignal(signal, init?.signal);
      const response = await fixedResponse(endpoint, String(input), init ?? {}, activeSignal);
      if (!response.ok) return response;
      return Response.json(await readBoundedJson(response, SESSION_BYTES, activeSignal));
    };
    if (handoff?.endpoint === endpoint) {
      const response = await fetcher(`${endpoint}/v1/sessions`, { method: "POST", headers: { Authorization: `Bearer ${handoff.hostToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, endpoint: phoneEndpoint }) });
      current();
      if (response.ok) {
        const claimed = validateCreated(await response.json(), this.sessionId, [phoneEndpoint]); current();
        hostToken = claimed.hostToken;
        this.liveAuthority = { endpoint, hostToken, expiresAt: claimed.ticket.expiresAt };
        desktopHostHandoffs.delete(this.sessionId);
      } else if (response.status >= 400 && response.status < 500) desktopHostHandoffs.delete(this.sessionId);
      else throw new Error("The connection is unavailable.");
    }
    const created = validateCreated(await createHttpSignalingSession(endpoint, this.sessionId, {
      hostName: boundedText(document.title, 120) && document.title ? document.title : "101 Host",
      advertisedEndpoint: phoneEndpoint, ...(hostToken ? { hostToken } : {}), fetcher,
    }), this.sessionId, [phoneEndpoint]); current();
    this.liveAuthority = { endpoint, hostToken: created.hostToken, expiresAt: created.ticket.expiresAt };
    await this.connect(); this.leaseCount = Math.max(0, this.leaseCount - 1);
    let automatic: AutomaticPairingHost | undefined;
    let starting = true;
    try {
      current();
      const liveFetcher: typeof fetch = async (input, init) => fixedResponse(endpoint, String(input), init ?? {}, requestSignal(starting ? signal : undefined, init?.signal));
      automatic = new AutomaticPairingHost({ signaling: new HttpHostSignalingClient(endpoint, this.sessionId, created.hostToken, liveFetcher), transport: this.multiplex });
      await automatic.start(); current();
      const controllerOrigin = controllerOriginForPhone(window.location.origin, phoneEndpoint);
      const controllerUrl = new URL(createControllerPairingUrl(`${controllerOrigin}/controller`, created.ticket));
      controllerUrl.searchParams.set("session", this.sessionId);
      current();
      this.automatic = automatic; starting = false;
      this.pairingExpiresAt = created.ticket.expiresAt;
      storeHostAuthority(endpoint, this.sessionId, created.hostToken, created.ticket.expiresAt);
      try { localStorage.setItem("101.hub.endpoint", endpoint); } catch { /* The selected connection can remain in memory. */ }
      return { ticket: created.ticket, controllerUrl: controllerUrl.toString(), hubEndpoint: endpoint };
    } finally { if (automatic && this.automatic !== automatic) await automatic.stop(); }
  }

  private async closeIfUnused() {
    this.disconnectTimer = undefined;
    if (this.leaseCount === 0) { this.revision += 1; this.pending?.abort(); this.pending = undefined; }
    await this.serializeLifecycle(async () => {
      if (this.leaseCount > 0) return;
      const automatic = this.automatic;
      await automatic?.stop();
      if (this.leaseCount > 0) { await automatic?.start(); return; }
      await this.multiplex.disconnect(); this.connected = false;
      if (this.leaseCount > 0) { await this.multiplex.connect(); this.connected = true; await automatic?.start(); return; }
      this.automatic = undefined; this.pairing = undefined; this.pairingKey = undefined;
    });
  }
  private serializeLifecycle(action: () => Promise<void>) {
    const operation = this.lifecycle.then(action, action); this.lifecycle = operation.catch(() => undefined); return operation;
  }
}

function requestSignal(...signals: (AbortSignal | null | undefined)[]) {
  return AbortSignal.any([...signals.filter((signal): signal is AbortSignal => !!signal), AbortSignal.timeout(2_500)]);
}
async function fixedResponse(endpoint: string, input: string, init: RequestInit, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!boundedText(input, LOCATION_BYTES)) throw new Error("The connection address is too long.");
  const url = new URL(input);
  if (url.origin !== endpoint || url.username || url.password || url.hash) throw new Error("The connection address changed.");
  const response = await abortable(fetch(input, { ...init, cache: "no-store", credentials: "omit", redirect: "manual", signal }), signal);
  signal.throwIfAborted();
  if (response.redirected || (response.url && response.url !== url.toString()) || (response.status >= 300 && response.status < 400)) throw new Error("The connection address changed.");
  return response;
}
function validateCreated(value: unknown, sessionId: string, endpoints: readonly string[]) {
  if (!closedRecord(value, ["ticket", "hostToken"]) || !validToken(value.hostToken)) throw new Error("The connection reply could not be checked.");
  const ticket = value.ticket;
  const keys = ["version", "sessionId", "endpoint", "joinToken", "expiresAt", "transport"];
  if (ticket && typeof ticket === "object" && Object.hasOwn(ticket, "hostName")) keys.push("hostName");
  if (!closedRecord(ticket, keys) || ticket.sessionId !== sessionId || !endpoints.includes(canonicalHubEndpoint(ticket.endpoint))
    || ticket.endpoint !== canonicalHubEndpoint(ticket.endpoint) || (ticket.hostName !== undefined && !boundedText(ticket.hostName, 120))) throw new Error("The connection reply could not be checked.");
  const parsed = decodePairingTicket(encodePairingTicket(ticket as unknown as PairingTicket));
  return { ticket: parsed, hostToken: value.hostToken };
}
function validToken(value: unknown): value is string { return boundedText(value, 256) && /^[A-Za-z0-9_-]{32,256}$/.test(value); }
function hostAuthorityKey(endpoint: string, sessionId: string) { return `${HOST_AUTHORITY_PREFIX}${encodeURIComponent(endpoint)}.${encodeURIComponent(sessionId)}`; }

function captureDesktopHostHandoff() {
  if (typeof window === "undefined" || !window.location.hash) return;
  const raw = window.location.hash;
  const originalHref = window.location.href;
  const fragment = (!originalHref || boundedText(originalHref, LOCATION_BYTES)) && boundedText(raw, LOCATION_BYTES)
    ? new URLSearchParams(raw.slice(1)) : undefined;
  if (fragment && !["101-host-session", "101-host-token", "101-host-hub"].some(key => fragment.has(key))) return;
  try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`); } catch { return; }
  if (!fragment || (originalHref && !boundedText(originalHref, LOCATION_BYTES))) return;
  try {
    const query = boundedQuery(window.location.search);
    if (Array.from(fragment.keys()).length !== 3 || ["101-host-session", "101-host-token", "101-host-hub"].some(key => fragment.getAll(key).length !== 1)) return;
    const sessionId = fragment.get("101-host-session"), hostToken = fragment.get("101-host-token");
    const endpoint = canonicalHubEndpoint(fragment.get("101-host-hub"));
    if (!sessionId || !/^[A-Z0-9-]{4,128}$/i.test(sessionId) || query.get("session") !== sessionId || !validToken(hostToken)
      || canonicalHubEndpoint(query.get("hub")) !== endpoint || !isLoopback(new URL(endpoint).hostname)) return;
    if (desktopHostHandoffs.size >= 16 && !desktopHostHandoffs.has(sessionId)) return;
    desktopHostHandoffs.set(sessionId, { endpoint, hostToken });
  } catch { /* Malformed secret fragments are removed and never used. */ }
}
function loadHostAuthority(endpoint: string, sessionId: string) {
  if (typeof localStorage === "undefined") return undefined;
  const key = hostAuthorityKey(endpoint, sessionId);
  try {
    const raw = localStorage.getItem(key);
    if (raw && boundedText(raw, 1024)) {
      const parsed: unknown = JSON.parse(raw);
      if (closedRecord(parsed, ["hostToken", "expiresAt"]) && validToken(parsed.hostToken) && typeof parsed.expiresAt === "number"
        && Number.isSafeInteger(parsed.expiresAt) && parsed.expiresAt > Date.now()) return parsed.hostToken;
    }
    localStorage.removeItem(key);
  } catch { /* Storage is unavailable or corrupt; no stored hint becomes authority. */ }
  return undefined;
}
function storeHostAuthority(endpoint: string, sessionId: string, hostToken: string, expiresAt: number) {
  try { localStorage.setItem(hostAuthorityKey(endpoint, sessionId), JSON.stringify({ hostToken, expiresAt })); }
  catch { /* Privacy modes retain the selected live authority only in memory. */ }
}
