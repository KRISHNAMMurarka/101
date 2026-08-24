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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.initialized = this.multiplex.add("same-browser", new BroadcastChannelTransport(sessionId));
  }

  async connect() {
    this.leaseCount += 1;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    await this.initialized;
    if (!this.connected) {
      await this.multiplex.connect();
      this.connected = true;
    }
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
    await this.connect();
    this.leaseCount -= 1;
    const requested = requestedHubEndpoint();
    const health = await fetch(`${requested}/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(2_500) });
    if (!health.ok) throw new Error(`Local 101 Hub is unavailable (${health.status})`);
    const details = await health.json() as { addresses?: string[] };
    const lanAddress = details.addresses?.[0];
    const advertisedEndpoint = withLanHost(requested, lanAddress);
    const created = await createHttpSignalingSession(requested, this.sessionId, {
      hostName: document.title || "101 Host",
      advertisedEndpoint,
    });
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
    if (this.leaseCount > 0) return;
    await this.automatic?.stop();
    this.automatic = undefined;
    this.pairing = undefined;
    await this.multiplex.disconnect();
    this.connected = false;
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
