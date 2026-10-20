import { AuthenticatedResourcePeer, PeerDataTransport, createEphemeralWebIdentity, createReceiverInvitation,
  encodeReceiverInvitation, decodeManualPeerCode, encodeManualPeerCode, receiverInvitationCurrent, webEndpointCrypto } from '@101/connect';
import type { EndpointIdentity, ReceiverInvitation } from '@101/connect';
import { createRemotePointerSurface } from '../../../examples/device-pipelines/remote-pointer.ts';

export const RECEIVER_APPLICATION = '101-console-pointer-surface';
export const RECEIVER_ORIGIN = 'https://101-receiver.invalid';

/** The native host serves its own packaged files at this reserved, non-network origin. */
export function allowedReceiverLocation(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.username || url.password || !['/', '/index.html'].includes(url.pathname)) return false;
    return url.origin === RECEIVER_ORIGIN || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
export function receiverAvailability(probe: { href: string; secure: boolean; rtc: boolean; crypto: boolean }): 'ready' | 'unavailable' {
  return allowedReceiverLocation(probe.href) && probe.secure && probe.rtc && probe.crypto ? 'ready' : 'unavailable';
}
type Surface = ReturnType<typeof createRemotePointerSurface>;
type Session = { peer: PeerDataTransport; auth: AuthenticatedResourcePeer; surface: Surface; detach: () => void; confirmed: boolean; admitted: boolean };
export interface ReceiverState {
  phase: 'idle' | 'preparing' | 'invitation' | 'connecting' | 'comparison' | 'connected' | 'active' | 'stopped' | 'unavailable';
  invitation: string; answer: string; comparison: string; confirmed: boolean; canAllow: boolean;
  contact: boolean; position?: { x: number; y: number }; releases: number; message: string;
}
const initial = (): ReceiverState => ({ phase: 'idle', invitation: '', answer: '', comparison: '', confirmed: false,
  canAllow: false, contact: false, position: undefined, releases: 0, message: 'Create an invitation for the controller you want to use.' });

/** Owns one application-only receiver. No native input, discovery, relay or automatic reconnect. */
export function createConsoleReceiver(options: { now?: () => number; wallNow?: () => number; onChange?: (state: ReceiverState) => void } = {}) {
  const now = options.now ?? (() => performance.now()), wallNow = options.wallNow ?? Date.now;
  let state = initial(), generation = 0, session: Session | undefined, identity: EndpointIdentity | undefined;
  let invitation: ReceiverInvitation | undefined, size = { width: 1, height: 1 }, timer: ReturnType<typeof setInterval> | undefined;
  const publish = (next: Partial<ReceiverState>) => { state = { ...state, ...next }; options.onChange?.({ ...state, position: state.position && { ...state.position } }); };
  function release() {
    generation++;
    if (timer !== undefined) clearInterval(timer); timer = undefined;
    const old = session; session = undefined; invitation = undefined; identity = undefined;
    if (old) { old.detach(); old.surface.stop(); old.auth.stop(); void old.peer.disconnect(); }
  }
  function stop(message = 'Stopped. Create a fresh invitation to continue.') {
    const releases = state.releases + (session ? 1 : 0); release();
    publish({ ...initial(), phase: 'stopped', releases, message });
  }
  function tick() {
    if (!invitation) return;
    if ((!session || !session.admitted) && !receiverInvitationCurrent(invitation, wallNow())) { stop('Invitation expired. Create a fresh invitation.'); return; }
    const current = session; if (!current) return;
    current.auth.tick(); current.surface.tick();
    if (session !== current) return;
    const auth = current.auth.status(), resource = current.surface.receiver.status(), effect = current.surface.state();
    if (auth.phase === 'stopped' || resource.stopped || ['expired', 'overload', 'unavailable', 'incompatible'].includes(resource.reason)) {
      stop('Connection ended. Control is released. Create a fresh invitation to continue.'); return;
    }
    const canAllow = auth.phase === 'active' && !!current.surface.receiver.description() && resource.clockReady && resource.active === 0;
    const phase = resource.active === 2 ? 'active' : auth.phase === 'active' ? 'connected' : auth.comparisonDigest ? 'comparison' : 'connecting';
    publish({ phase, comparison: auth.comparisonDigest ?? '', confirmed: current.confirmed, canAllow,
      contact: effect.contact, position: effect.position, releases: effect.releases,
      message: phase === 'active' ? 'Pointer allowed for one minute. Stop releases it immediately.'
        : phase === 'connected' ? 'Connection allowed. Choose Allow pointer for one minute.'
          : phase === 'comparison' ? 'Compare every character on both screens, then allow this connection only if the codes match.'
            : 'Copy the complete answer to the controller, then compare the codes on both screens.' });
  }
  return {
    state: () => ({ ...state, position: state.position && { ...state.position } }),
    async createInvitation() {
      release(); const revision = generation;
      publish({ ...initial(), phase: 'preparing', message: 'Preparing an invitation…' });
      try {
        const created = await createEphemeralWebIdentity();
        if (revision !== generation) return;
        identity = created;
        const random = [...webEndpointCrypto.randomBytes(16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        invitation = createReceiverInvitation({ applicationId: RECEIVER_APPLICATION, sessionId: `console-${random}`, now: wallNow(), randomBytes: webEndpointCrypto.randomBytes });
        timer = setInterval(tick, 20);
        publish({ phase: 'invitation', invitation: encodeReceiverInvitation(invitation), message: 'Copy this invitation to the controller and review the application and session there. It lasts five minutes.' });
      } catch { if (revision === generation) { stop('This screen could not create a connection. Try again, or use another supported screen.'); } }
    },
    async acceptOffer(input: string) {
      if (!identity || !invitation || session || !receiverInvitationCurrent(invitation, wallNow())) { stop('Create a fresh invitation before using an offer.'); return; }
      const revision = generation, target = invitation, key = identity;
      try {
        const code = decodeManualPeerCode(input, 'offer', target.epoch);
        const peer = new PeerDataTransport({ initiator: false });
        const auth = new AuthenticatedResourcePeer({ transport: peer, identity: key, crypto: webEndpointCrypto, ...target,
          role: 'receiver', now });
        const surface = createRemotePointerSurface({ peer: auth, epoch: target.epoch, principalId: 'console-surface-owner',
          applicationId: target.applicationId, sessionId: target.sessionId, clockId: `console-surface:${target.epoch}`, now, ...size });
        const current: Session = { peer, auth, surface, detach: () => {}, confirmed: false, admitted: false };
        session = current;
        current.detach = auth.onStateChange(value => {
          if (session !== current) return;
          if (value === 'connected') current.admitted = true;
          if (value === 'failed' || value === 'disconnected') stop('Connection lost. Control is released. Create a fresh invitation.');
        });
        publish({ phase: 'connecting', invitation: '', message: 'Preparing an answer…' });
        const answer = await peer.acceptOffer(code.description);
        if (revision !== generation || session !== current) { surface.stop(); auth.stop(); await peer.disconnect(); return; }
        publish({ answer: encodeManualPeerCode(target.epoch, answer) }); tick();
      } catch { if (revision === generation) stop('This offer could not connect. Create a fresh invitation and transfer its complete matching offer.'); }
    },
    confirm(displayed: string) {
      if (!session || displayed !== state.comparison || !displayed || !session.auth.confirmEnrollment(displayed)) return false;
      session.confirmed = true; tick(); return true;
    },
    allow() {
      if (!session || !state.canAllow || !session.confirmed || !session.surface.select()) return false;
      tick(); return true;
    },
    resize(width: number, height: number) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      size = { width, height }; session?.surface.resize(width, height); tick();
    },
    tick,
    stop,
    unavailable() { stop('This screen cannot receive a controller. Use a supported screen with a secure connection.'); publish({ phase: 'unavailable' }); },
    close() { release(); state = { ...initial(), phase: 'stopped' }; },
  };
}
