import {
  AutomaticPairingHost,
  HttpHostSignalingClient,
  createHttpSignalingSession,
} from "@101/pairing";
import {
  BroadcastChannelTransport,
  MultiplexLinkTransport,
  createControllerPairingUrl,
  type ControlMessage,
  type LinkMessage,
  type LinkTransport,
  type PairingTicket,
  type RealtimeMessage,
} from "@101/protocol";

export interface BrowserPairingInfo {
  ticket: PairingTicket;
  controllerUrl: string;
  hubEndpoint: string;
}

const sessions = new Map<string, BrowserHostTransport>();
const HOST_AUTHORITY_PREFIX = "101.hub.host.";
const desktopHostHandoffs = new Map<string, { hostToken: string; rejected: boolean; claim?: Promise<void> }>();

captureDesktopHostHandoff();

export function getBrowserHostTransport(sessionId: string) {
  let transport = sessions.get(sessionId);
  if (!transport) {
    transport = new BrowserHostTransport(sessionId);
    sessions.set(sessionId, transport);
  }
  return transport;
}

export class BrowserHostTransport implements LinkTransport {
  private readonly multiplex = new MultiplexLinkTransport();
  private readonly sessionId: string;
  private readonly initialized: Promise<void>;
  private pairing?: Promise<BrowserPairingInfo>;
  private automatic?: AutomaticPairingHost;
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
    await this.serializeLifecycle(async () => {
      if (this.connected) return;
      await this.multiplex.connect();
      this.connected = true;
    });
  }

  async disconnect() {
    this.leaseCount = Math.max(0, this.leaseCount - 1);
    if (this.leaseCount > 0 || this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => void this.closeIfUnused(), 5_000);
  }

  sendReliable(message: ControlMessage) { this.multiplex.sendReliable(message); }
  sendRealtime(message: RealtimeMessage) { this.multiplex.sendRealtime(message); }
  onMessage(callback: (message: LinkMessage) => void) { return this.multiplex.onMessage(callback); }

  async preparePairing() {
    if (!this.pairing) this.pairing = this.createPairing().catch((error) => { this.pairing = undefined; throw error; });
    return this.pairing;
  }

  private async createPairing(): Promise<BrowserPairingInfo> {
    const handedOffHostToken = await takeDesktopHostHandoff(this.sessionId);
    await this.connect();
    this.leaseCount -= 1;
    const requested = requestedHubEndpoint();
    const health = await fetch(`${requested}/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(2_500) });
    if (!health.ok) throw new Error(`Local 101 Hub is unavailable (${health.status})`);
    const details = await health.json() as { addresses?: string[] };
    const lanAddress = details.addresses?.[0];
    const advertisedEndpoint = withLanHost(requested, lanAddress);
    const storedHostToken = handedOffHostToken ?? loadHostAuthority(requested, this.sessionId);
    const created = await createHttpSignalingSession(requested, this.sessionId, {
      hostName: document.title || "101 Host",
      advertisedEndpoint,
      ...(storedHostToken ? { hostToken: storedHostToken } : {}),
    });
    storeHostAuthority(requested, this.sessionId, created.hostToken, created.ticket.expiresAt);
    desktopHostHandoffs.delete(this.sessionId);
    this.automatic = new AutomaticPairingHost({
      signaling: new HttpHostSignalingClient(requested, this.sessionId, created.hostToken),
      transport: this.multiplex,
    });
    await this.automatic.start();
    const controllerBase = withLanHost(new URL("/controller", window.location.origin).toString(), lanAddress);
    const controllerUrl = new URL(createControllerPairingUrl(controllerBase, created.ticket));
    controllerUrl.searchParams.set("session", this.sessionId);
    return { ticket: created.ticket, controllerUrl: controllerUrl.toString(), hubEndpoint: advertisedEndpoint };
  }

  private async closeIfUnused() {
    this.disconnectTimer = undefined;
    await this.serializeLifecycle(async () => {
      if (this.leaseCount > 0) return;
      const automatic = this.automatic;
      await automatic?.stop();
      if (this.leaseCount > 0) {
        await automatic?.start();
        return;
      }
      await this.multiplex.disconnect();
      this.connected = false;
      if (this.leaseCount > 0) {
        await this.multiplex.connect();
        this.connected = true;
        await automatic?.start();
        return;
      }
      this.automatic = undefined;
      this.pairing = undefined;
    });
  }

  private serializeLifecycle(action: () => Promise<void>) {
    const operation = this.lifecycle.then(action, action);
    this.lifecycle = operation.catch(() => undefined);
    return operation;
  }
}

function requestedHubEndpoint() {
  const query = new URLSearchParams(window.location.search).get("hub");
  if (query) localStorage.setItem("101.hub.endpoint", query.replace(/\/$/, ""));
  const configured = query || localStorage.getItem("101.hub.endpoint");
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(window.location.origin);
  url.port = "10101";
  return url.toString().replace(/\/$/, "");
}

function withLanHost(value: string, lanAddress?: string) {
  const url = new URL(value);
  if (lanAddress && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")) url.hostname = lanAddress;
  return url.toString().replace(/\/$/, "");
}

function hostAuthorityKey(endpoint: string, sessionId: string) {
  return `${HOST_AUTHORITY_PREFIX}${encodeURIComponent(endpoint)}.${encodeURIComponent(sessionId)}`;
}

function captureDesktopHostHandoff() {
  if (typeof window === "undefined" || !window.location.hash) return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("101-host-session") && !fragment.has("101-host-token")) return;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    return;
  }
  const requestedSession = new URLSearchParams(window.location.search).get("session")?.trim();
  const requestedHub = new URLSearchParams(window.location.search).get("hub")?.trim();
  const fragmentSession = fragment.get("101-host-session")?.trim();
  const hostToken = fragment.get("101-host-token")?.trim();
  const fragmentHub = fragment.get("101-host-hub")?.trim();
  const normalizedHub = normalizeDesktopHandoffHub(requestedHub);
  if (!requestedSession || fragmentSession !== requestedSession || !/^[A-Z0-9-]{4,128}$/i.test(fragmentSession)
    || !hostToken || !/^[A-Za-z0-9_-]{32,256}$/.test(hostToken)
    || !normalizedHub || normalizeDesktopHandoffHub(fragmentHub) !== normalizedHub) return;
  const handoff: { hostToken: string; rejected: boolean; claim?: Promise<void> } = { hostToken, rejected: false };
  desktopHostHandoffs.set(fragmentSession, handoff);
  handoff.claim = claimDesktopHostHandoff(normalizedHub, fragmentSession, hostToken).then((result) => {
    if (result.hostToken) handoff.hostToken = result.hostToken;
    handoff.rejected = result.rejected;
  }).finally(() => { handoff.claim = undefined; });
}

async function takeDesktopHostHandoff(sessionId: string) {
  captureDesktopHostHandoff();
  const handoff = desktopHostHandoffs.get(sessionId);
  if (!handoff) return undefined;
  await handoff.claim;
  return handoff.rejected ? undefined : handoff.hostToken;
}

function normalizeDesktopHandoffHub(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

async function claimDesktopHostHandoff(endpoint: string, sessionId: string, hostToken: string): Promise<{ hostToken?: string; rejected: boolean }> {
  try {
    const response = await fetch(`${endpoint}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      cache: "no-store",
    });
    if (!response.ok) return { rejected: response.status >= 400 && response.status < 500 };
    const created = await response.json() as { hostToken?: unknown; ticket?: { sessionId?: unknown; expiresAt?: unknown } };
    if (typeof created.hostToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(created.hostToken)
      || created.ticket?.sessionId !== sessionId || typeof created.ticket.expiresAt !== "number"
      || !Number.isSafeInteger(created.ticket.expiresAt) || created.ticket.expiresAt <= Date.now()) return { rejected: true };
    storeHostAuthority(endpoint, sessionId, created.hostToken, created.ticket.expiresAt);
    return { hostToken: created.hostToken, rejected: false };
  } catch {
    return { rejected: false };
  }
}

function loadHostAuthority(endpoint: string, sessionId: string) {
  if (typeof localStorage === "undefined") return undefined;
  const key = hostAuthorityKey(endpoint, sessionId);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as { hostToken?: unknown; expiresAt?: unknown } | null;
    if (parsed && typeof parsed.hostToken === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(parsed.hostToken)
      && typeof parsed.expiresAt === "number" && Number.isSafeInteger(parsed.expiresAt) && parsed.expiresAt > Date.now()) {
      return parsed.hostToken;
    }
    localStorage.removeItem(key);
  } catch {
    try { localStorage.removeItem(key); } catch { /* Storage is unavailable in this browser mode. */ }
  }
  return undefined;
}

function storeHostAuthority(endpoint: string, sessionId: string, hostToken: string, expiresAt: number) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(hostAuthorityKey(endpoint, sessionId), JSON.stringify({ hostToken, expiresAt }));
  } catch {
    // Storage can be unavailable in privacy modes; the current page still retains live authority.
  }
}
