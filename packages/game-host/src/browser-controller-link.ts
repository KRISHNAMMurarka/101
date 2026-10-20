import { createControllerApplicationChannel, type DeviceCapabilities, type PairingTicket } from '@uynis-connect/connect';
import { createGameApplicationLink } from './game-application-channel.ts';
import type { ControlMessage, LinkMessage, LinkTransport, RealtimeMessage } from './game-protocol.ts';
/** Synchronous game facade; asynchronous SDK connection ownership stays behind it. */
export function createBrowserGameControllerLink(options: { sessionId: string; deviceId: string; label: string; capabilities: DeviceCapabilities; ticket?: PairingTicket }): LinkTransport {
  const listeners = new Set<(message: LinkMessage) => void>();
  let link: LinkTransport | undefined, closed = false;
  const ready = createControllerApplicationChannel({ sessionId: options.sessionId, applicationId: 'connect.controls.v1',
    device: { deviceId: options.deviceId, label: options.label, capabilities: options.capabilities }, ticket: options.ticket })
    .then(async channel => {
      if (closed) { await channel.close(); return; }
      link = createGameApplicationLink(channel, { controllerDeviceId: options.deviceId });
      link.onMessage(message => { for (const listener of listeners) listener(message); });
    });
  // Creation can fail before React reaches connect; retain rejection for the caller without a stray rejection.
  void ready.catch(() => undefined);
  return {
    async connect() { await ready; if (closed) return; await link?.connect(); },
    async disconnect() { closed = true; await ready.catch(() => undefined); await link?.disconnect(); listeners.clear(); },
    sendReliable(message: ControlMessage) { link?.sendReliable(message); },
    sendRealtime(message: RealtimeMessage) { link?.sendRealtime(message); },
    onMessage(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
}
