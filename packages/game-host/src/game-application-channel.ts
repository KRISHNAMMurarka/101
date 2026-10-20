import { parseControlApplicationMessage, encodeControlApplicationMessage, type ApplicationChannel, type ApplicationMessage,
  type ApplicationPeer, type ControlApplicationMessage } from '@uynis-connect/connect';
import type { ControlMessage, LinkMessage, LinkTransport, RealtimeMessage } from './game-protocol.ts';
interface PeerBinding {
  peer: ApplicationPeer;
  wireId: string;
  bindingId?: string;
  assignment?: Extract<ControlMessage, { type: 'player.assign' }>;
  revision?: number;
  gameId?: string;
}
/** Games translates its assignments to opaque, supplied native control bindings. */
export function createGameApplicationLink(channel: ApplicationChannel, options: { controllerDeviceId?: string } = {}): LinkTransport {
  const peers = new Map<string, PeerBinding>();
  const listeners = new Set<(message: LinkMessage) => void>();
  const losses = new Set<(deviceId: string) => void>();
  let removeMessage: (() => void) | undefined, removeLoss: (() => void) | undefined;
  let active = false;
  const emitControl = (payload: ControlMessage) => { for (const listener of listeners) listener({ channel: 'control', payload }); };
  const emitRealtime = (payload: RealtimeMessage) => { for (const listener of listeners) listener({ channel: 'realtime', payload }); };
  const send = (message: ControlApplicationMessage, delivery: 'reliable' | 'disposable', targetDeviceId?: string) =>
    channel.send(encodeControlApplicationMessage(message), { delivery, ...(targetDeviceId ? { targetDeviceId } : {}) });
  const receive = (event: ApplicationMessage) => {
    if (!active || typeof event.payload !== 'string') return;
    try {
      const message = parseControlApplicationMessage(JSON.parse(event.payload));
      let peer = peers.get(event.peer.deviceId);
      if (options.controllerDeviceId) {
        if (!peer) { peer = { peer: event.peer, wireId: options.controllerDeviceId }; peers.set(event.peer.deviceId, peer); }
        const deviceId = options.controllerDeviceId;
        if (message.type === 'controls.configure') {
          peer.bindingId = message.bindingId;
          // These presentation aliases are local to the game controller. Host-side assignment is authoritative.
          emitControl({ type: 'player.assign', deviceId, playerId: message.bindingId, role: 'controller', gameId: message.applicationId });
          emitControl({ type: 'controller.configure', deviceId, gameId: message.applicationId, role: 'controller', revision: message.revision, layout: message.layout });
        } else if (message.type === 'controls.wait') {
          peer.bindingId = undefined; emitControl({ type: 'player.wait', deviceId, gameId: 'application', reason: 'no-open-role' });
        } else if (message.type === 'controls.state' && message.bindingId === peer.bindingId) {
          emitControl({ type: 'controller.state', deviceId, values: message.values, message: message.message, tone: message.tone });
        } else if (message.type === 'controls.haptic' && message.bindingId === peer.bindingId) emitRealtime({ type: 'haptic', deviceId, pattern: message.pattern });
        else if (message.type === 'controls.speaker' && message.bindingId === peer.bindingId) emitRealtime({ type: 'speaker.cue', deviceId, cue: 'pulse-v1', sequence: message.sequence, pitch: message.pitch, volume: message.volume });
        else if (message.type === 'pong') emitControl({ type: 'pong', sentAt: message.sentAt, receivedAt: message.receivedAt });
        return;
      }
      if (message.type === 'controls.hello') {
        if (event.delivery !== 'reliable' || (event.peer.trust === 'paired' && message.deviceId !== event.peer.wireDeviceId)) return;
        if (peer && peer.wireId !== message.deviceId) return;
        if (!peer) { peer = { peer: event.peer, wireId: message.deviceId }; peers.set(event.peer.deviceId, peer); }
        emitControl({ type: 'hello', version: 2, deviceId: event.peer.deviceId, device: message.label,
          capabilities: message.capabilities, features: { speakerAudio: message.speakerAudio } });
      } else if (peer && message.type === 'input.snapshot') {
        if (!peer.bindingId || message.bindingId !== peer.bindingId || !peer.assignment) return;
        emitRealtime({ deviceId: peer.peer.deviceId, playerId: peer.assignment.playerId, sequence: message.sequence,
          timestamp: message.timestamp, source: gameSource(message.source), actions: message.actions, axes: message.axes, vectors: message.vectors });
      } else if (peer && message.type === 'ping') emitControl({ type: 'ping', deviceId: peer.peer.deviceId, sentAt: message.sentAt });
    } catch { /* Invalid application packets never affect game assignment or held controls. */ }
  };
  return {
    async connect() {
      if (active) return;
      active = true; removeMessage = channel.subscribe(receive);
      removeLoss = channel.onPeerLost(peer => { if (peers.delete(peer.deviceId)) for (const listener of losses) listener(peer.deviceId); });
      try { await channel.connect(); } catch (error) { active = false; removeMessage(); removeLoss(); removeMessage = undefined; removeLoss = undefined; throw error; }
    },
    async disconnect() {
      active = false; removeMessage?.(); removeLoss?.(); removeMessage = undefined; removeLoss = undefined;
      for (const id of peers.keys()) for (const listener of losses) listener(id);
      peers.clear(); await channel.close();
    },
    sendReliable(message) {
      if (options.controllerDeviceId) {
        if (message.type === 'hello') send({ type: 'controls.hello', deviceId: options.controllerDeviceId, label: message.device, capabilities: message.capabilities, speakerAudio: message.features?.speakerAudio ?? 'locked' }, 'reliable');
        else if (message.type === 'ping') send({ type: 'ping', sentAt: message.sentAt }, 'reliable');
        return;
      }
      const target = 'deviceId' in message ? message.deviceId : undefined;
      const entries = target ? (peers.has(target) ? [peers.get(target)!] : []) : [...peers.values()];
      for (const peer of entries) {
        if (message.type === 'player.assign') {
          if (peer.assignment?.playerId !== message.playerId || peer.assignment?.role !== message.role || peer.assignment?.gameId !== message.gameId) { peer.bindingId = undefined; peer.revision = undefined; }
          peer.assignment = message;
        } else if (message.type === 'controller.configure') {
          if (!peer.assignment) continue;
          if (peer.revision !== message.revision || peer.gameId !== message.gameId || !peer.bindingId) peer.bindingId = crypto.randomUUID();
          peer.revision = message.revision; peer.gameId = message.gameId;
          send({ type: 'controls.configure', bindingId: peer.bindingId, applicationId: '101.game-controller', revision: message.revision,
            layout: message.layout, clock: message.gameId === 'echomaze' ? 'wall' : 'monotonic' }, 'reliable', peer.peer.deviceId);
        } else if (message.type === 'player.wait') { peer.bindingId = undefined; peer.assignment = undefined; send({ type: 'controls.wait' }, 'reliable', peer.peer.deviceId); }
        else if (message.type === 'controller.state' && peer.bindingId) send({ type: 'controls.state', bindingId: peer.bindingId, values: message.values, message: message.message, tone: message.tone }, 'reliable', peer.peer.deviceId);
        else if (message.type === 'pong') send({ type: 'pong', sentAt: message.sentAt, receivedAt: message.receivedAt }, 'reliable', peer.peer.deviceId);
      }
    },
    sendRealtime(message: RealtimeMessage) {
      if (options.controllerDeviceId && !('type' in message)) {
        for (const peer of peers.values()) if (peer.bindingId) send({ type: 'input.snapshot', bindingId: peer.bindingId, source: message.source,
          sequence: message.sequence, timestamp: message.timestamp, actions: message.actions, axes: message.axes, vectors: message.vectors }, 'disposable', peer.peer.deviceId);
        return;
      }
      if (!('type' in message)) return;
      const peer = peers.get(message.deviceId); if (!peer?.bindingId) return;
      if (message.type === 'haptic') send({ type: 'controls.haptic', bindingId: peer.bindingId, pattern: message.pattern }, 'disposable', peer.peer.deviceId);
      else send({ type: 'controls.speaker', bindingId: peer.bindingId, sequence: message.sequence, timestamp: Date.now(), pitch: message.pitch, volume: message.volume }, 'disposable', peer.peer.deviceId);
    },
    onMessage(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    onDeviceLost(callback) { losses.add(callback); return () => { losses.delete(callback); }; },
  };
}
function gameSource(source: string): import('@101/input').InputSource {
  if (['keyboard','mouse','touch','gamepad','phone-motion','watch-motion','camera-hand','camera-pose','camera-face','hid','bluetooth','serial','custom'].includes(source)) return source as import('@101/input').InputSource;
  throw new Error('Unsupported controller input source');
}
