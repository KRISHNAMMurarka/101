// Owned software descriptor only. The qualification caller compiles this actual
// public SDK source closure; it supplies no hardware or installed-package proof.
import { AuthenticatedResourcePeer, RemoteResourcePublisher, createEphemeralWebIdentity,
  webEndpointCrypto, decodeReceiverInvitation, decodeManualPeerCode, encodeManualPeerCode,
  decodePacket } from '../packages/device-web/src/index.ts';
import { PeerDataTransport } from '../packages/transport-webrtc/src/index.ts';

export async function startSource(invitation, label) {
  const target = decodeReceiverInvitation(invitation, Date.now());
  const identity = await createEphemeralWebIdentity();
  const peer = new PeerDataTransport({ initiator: true, iceServers: [] });
  const auth = new AuthenticatedResourcePeer({ transport: peer, identity, crypto: webEndpointCrypto,
    ...target, role: 'source', now: () => performance.now(), timeoutMs: 60000 });
  const descriptor = { schemaVersion: 1, id: `software-metadata:${target.epoch}`, label, revision: 1,
    adapter: { id: 'owned:software-metadata', version: '1.0.0' }, runtime: { platform: 'owned-browser' },
    capabilities: [{ id: 'level', semantic: 'software:counter', schemaVersion: 1, kind: 'sample',
      permissions: ['subscribe'], value: { type: 'scalar', unit: '1', min: 0, max: 100 },
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } }] };
  let stopped = false, timer, started = false, binds = 0, closing;
  const raw = new Set();
  const publisher = new RemoteResourcePublisher({ peer: auth, epoch: target.epoch,
    clockId: `owned-metadata:${target.epoch}`, now: () => performance.now(), device: descriptor,
    available: () => false }); // No source approval, samples or resource grants.
  const detach = auth.onData((lane, bytes) => {
    if (decodePacket(bytes, lane)?.packet.type === 'bind') binds++;
  });
  const button = document.createElement('button'); button.textContent = 'Confirm owned source comparison';
  const confirm = () => { const digest = auth.status().comparisonDigest; if (!stopped && digest) auth.confirmEnrollment(digest); };
  button.addEventListener('click', confirm); document.body.replaceChildren(button);
  function loop() {
    if (stopped) return;
    auth.tick(); if (!started && auth.state === 'connected') started = publisher.start();
    if (started) publisher.tick();
    if (!stopped) timer = setTimeout(loop, 20);
  }
  function issued(operation) {
    const returned = Promise.resolve().then(() => { if (stopped) throw Error('Source retired'); return operation(); });
    raw.add(returned); void returned.then(() => raw.delete(returned), () => raw.delete(returned)); return returned;
  }
  globalThis.__rememberedSource = {
    accept: answer => issued(() => peer.acceptAnswer(decodeManualPeerCode(answer, 'answer', target.epoch).description)),
    comparison: () => auth.status().comparisonDigest,
    metrics: () => ({ publicKeyId: identity.keyId, binds, rawPending: raw.size, state: peer.state,
      timerArmed: timer !== undefined, stopped, sourceApproved: false, samples: 0 }),
    stop() {
      if (closing) return closing;
      stopped = true; clearTimeout(timer); timer = undefined; button.removeEventListener('click', confirm);
      publisher.stop(); detach();
      const disconnected = peer.disconnect(); auth.stop();
      closing = (async () => {
        await disconnected; while (raw.size) await Promise.allSettled([...raw]);
        return { rawPending: raw.size, timerArmed: timer !== undefined, state: peer.state, stopped, listeners: 0 };
      })(); return closing;
    },
  };
  loop();
  try { return encodeManualPeerCode(target.epoch, await issued(() => peer.createOffer())); }
  catch (cause) { await globalThis.__rememberedSource.stop(); throw cause; }
}
