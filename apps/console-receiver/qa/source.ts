import { AuthenticatedResourcePeer, PeerDataTransport, PointerResourceProvider, createEphemeralWebIdentity,
  decodeReceiverInvitationInput, decodeManualPeerCode, encodeManualPeerCode, webEndpointCrypto } from '@101/connect';
import type { ReceiverInvitation } from '@101/connect';
const field = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let peer: PeerDataTransport | undefined, auth: AuthenticatedResourcePeer | undefined, provider: PointerResourceProvider | undefined;
let epoch = '', timer: ReturnType<typeof setInterval> | undefined;
let reviewed: ReceiverInvitation | undefined;
function stop() { if (timer !== undefined) clearInterval(timer); timer = undefined; provider?.stop(); auth?.stop(); void peer?.disconnect(); button('move').disabled = true; button('press').disabled = true; }
button('review').onclick = () => {
  reviewed = decodeReceiverInvitationInput(field('invitation').value, Date.now());
  document.getElementById('scope')!.textContent = `${reviewed.applicationId}\n${reviewed.sessionId}`;
  button('connect').disabled = false;
};
button('connect').onclick = async () => {
  stop();
  field('offer').value = ''; field('comparison').value = ''; field('answer').value = '';
  const target = reviewed!; epoch = target.epoch; button('connect').disabled = true;
  peer = new PeerDataTransport({ initiator: true });
  auth = new AuthenticatedResourcePeer({ transport: peer, identity: await createEphemeralWebIdentity(), crypto: webEndpointCrypto,
    ...target, role: 'source', now: () => performance.now() });
  provider = new PointerResourceProvider({ peer: auth, epoch, clockId: 'owned-console-qa-source', now: () => performance.now(), platform: 'owned-browser-controller', available: () => true });
  timer = setInterval(() => { auth!.tick(); provider!.tick(); const state = auth!.status();
    field('comparison').value = state.comparisonDigest ?? ''; button('confirm').disabled = state.phase !== 'awaiting-enrollment';
    button('move').disabled = button('press').disabled = !provider!.status().ready;
    document.getElementById('state')!.textContent = provider!.status().ready ? 'ready' : state.phase;
  }, 10);
  field('offer').value = encodeManualPeerCode(epoch, await peer.createOffer());
};
button('use-answer').onclick = () => { void peer!.acceptAnswer(decodeManualPeerCode(field('answer').value, 'answer', epoch).description); };
button('confirm').onclick = () => { auth!.confirmEnrollment(field('comparison').value); };
button('move').onclick = () => provider?.driver()?.nudge(.1, 0);
button('press').onclick = () => provider?.driver()?.setContact(true);
button('stop').onclick = stop;
window.addEventListener('pagehide', stop);
