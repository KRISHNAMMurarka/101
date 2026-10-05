import { SecureWebSocketTransport, AuthenticatedResourcePeer, webEndpointCrypto } from '@101/connect';
import type { SecureWebSocketOptions, EndpointIdentity, EndpointCrypto } from '@101/connect';

export interface SecureWebSocketPeerOptions {
  transport: SecureWebSocketOptions; identity: EndpointIdentity; crypto?: EndpointCrypto;
  epoch: string; applicationId: string; sessionId: string; role: 'source' | 'receiver'; now: () => number;
  timeoutMs?: number; expectedRemoteKeyId?: string;
}
/** Explicit direct fallback. Each replacement needs a new instance, epoch and resource approval. */
export function createSecureWebSocketPeer(options: SecureWebSocketPeerOptions) {
  const transport = new SecureWebSocketTransport(options.transport);
  const peer = new AuthenticatedResourcePeer({ transport, identity: options.identity, crypto: options.crypto ?? webEndpointCrypto,
    epoch: options.epoch, applicationId: options.applicationId, sessionId: options.sessionId, role: options.role, now: options.now,
    timeoutMs: options.timeoutMs, expectedRemoteKeyId: options.expectedRemoteKeyId });
  let stopped = false;
  return {
    transport, peer,
    async start(): Promise<boolean> {
      if (stopped) return false;
      await transport.connect();
      return !stopped && (transport.state === 'connecting' || transport.state === 'connected');
    },
    tick(): void { if (!stopped) { transport.tick(); peer.tick(); } },
    stop(): void { if (!stopped) { stopped = true; peer.stop(); } },
  };
}
