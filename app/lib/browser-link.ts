import { createBrowserApplicationChannel, readBrowserHubCandidates, type ApplicationChannel, type BrowserApplicationChannel } from '@uynis-connect/connect';
export { readBrowserHubCandidates };
export interface BrowserPairingInfo { controllerUrl: string; hubEndpoint: string; expiresAt: number }
export interface BrowserPairingOptions { signal?: AbortSignal; phoneEndpoint?: string }
/** Thin Games consumer. Connection selection, identity and host authority belong to Connect. */
export function getBrowserApplicationChannel(sessionId: string): ApplicationChannel {
  let resolved: BrowserApplicationChannel | undefined;
  const ready = createBrowserApplicationChannel({ sessionId, applicationId: 'connect.controls.v1' }).then(channel => { resolved = channel; return channel; });
  void ready.catch(() => undefined);
  let closed = false;
  return {
    async connect() { const channel = await ready; if (closed) { await channel.close(); return; } await channel.connect(); },
    async close() { closed = true; await (await ready).close(); },
    send(payload, options) { return !closed && resolved ? resolved.send(payload, options) : false; },
    subscribe(callback) { let removed = false; let unsubscribe: (() => void) | undefined; void ready.then(channel => { if (!removed && !closed) unsubscribe = channel.subscribe(callback); }).catch(() => undefined); return () => { removed = true; unsubscribe?.(); }; },
    onPeerLost(callback) { let removed = false; let unsubscribe: (() => void) | undefined; void ready.then(channel => { if (!removed && !closed) unsubscribe = channel.onPeerLost(callback); }).catch(() => undefined); return () => { removed = true; unsubscribe?.(); }; },
  };
}
const reviews = new Map<string, Promise<BrowserApplicationChannel>>();
export function getBrowserHostConnection(sessionId: string) {
  let ready = reviews.get(sessionId);
  if (!ready) { ready = createBrowserApplicationChannel({ sessionId, applicationId: 'connect.controls.v1' }); reviews.set(sessionId, ready); }
  return {
    async reviewEndpoint(endpoint: string, options?: { signal?: AbortSignal }) { return (await ready!).reviewEndpoint(endpoint, options); },
    async preparePairing(endpoint: string, options?: BrowserPairingOptions): Promise<BrowserPairingInfo> { return (await ready!).preparePairing(endpoint, options); },
  };
}
