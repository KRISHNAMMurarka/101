'use client';

import { AuthenticatedResourcePeer, createReceiverInvitation, decodeManualPeerCode, encodeManualPeerCode,
  encodeReceiverInvitation, receiverInvitationCurrent, webEndpointCrypto, PeerDataTransport } from '@101/connect';
import type { ReceiverInvitation } from '@101/connect';
import type { InputFrame } from '@101/input';
import { createGamePointerReceiver, INPUT_LAB_POINTER_MANIFEST } from '@/examples/device-pipelines/game-pointer-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEndpointIdentity } from './use-endpoint-identity';

type Receiver = ReturnType<typeof createGamePointerReceiver>;
type Connection = { peer: PeerDataTransport; auth: AuthenticatedResourcePeer; receiver: Receiver; invitation: ReceiverInvitation; confirmed: boolean; admitted: boolean; dispose: () => void };
type Snapshot = { described: boolean; clockReady: boolean; active: number; stopped: boolean; comparison?: string; confirmed?: boolean; enrolled?: boolean };
const EMPTY: Snapshot = { described: false, clockReady: false, active: 0, stopped: false };

/** Application-owned consent and explicit classic/player-1 mapping for this developer diagnostic. */
export default function RemotePointerPanel({ sessionId, acceptFrame, removeDevice }: {
  sessionId: string; acceptFrame: (frame: InputFrame) => boolean; removeDevice: (deviceId: string, playerId: string) => void;
}) {
  const [offer, setOffer] = useState('');
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('Create an invitation for a pointer source you control.');
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [invitationCode, setInvitationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const invitation = useRef<ReceiverInvitation | undefined>(undefined);
  const identity = useEndpointIdentity('101.endpoint-identity.v1:input-lab-receiver');
  const connection = useRef<Connection | null>(null);
  const generation = useRef(0);
  const stop = useCallback((update = true) => {
    generation.current++;
    const previous = connection.current; connection.current = null; previous?.dispose();
    invitation.current = undefined;
    if (update) { setBusy(false); setAnswer(''); setInvitationCode(''); setSnapshot({ ...EMPTY, stopped: true }); setMessage('Stopped. Aim is neutral and trigger is released. Create a fresh invitation to continue.'); }
  }, []);
  useEffect(() => {
    const blur = () => { if (connection.current?.receiver.bridge.state().approved) stop(); };
    const hidden = () => { if (document.hidden) stop(); };
    const leave = () => stop(false);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); stop(false); };
  }, [stop, sessionId]);

  const createInvitation = () => {
    stop(false); setSnapshot(EMPTY); setAnswer(''); setOffer('');
    if (!identity.identity) { setMessage('Create or reload your local identity first.'); return; }
    try {
      const value = createReceiverInvitation({ applicationId: INPUT_LAB_POINTER_MANIFEST.game, sessionId, now: Date.now(), randomBytes: webEndpointCrypto.randomBytes });
      invitation.current = value; setInvitationCode(encodeReceiverInvitation(value));
      setMessage('Copy this five-minute invitation to the source and review its application and session there.');
    } catch { setMessage('Could not create an invitation. Reload the local identity and try again.'); }
  };
  const acceptOffer = async () => {
    const target = invitation.current, key = identity.identity;
    stop(false); setSnapshot(EMPTY); setAnswer(''); setBusy(true);
    const id = generation.current;
    let peer: PeerDataTransport | undefined;
    try {
      if (!target || !key || !receiverInvitationCurrent(target, Date.now()) || target.applicationId !== INPUT_LAB_POINTER_MANIFEST.game || target.sessionId !== sessionId) throw new Error();
      const code = decodeManualPeerCode(offer, 'offer', target.epoch);
      peer = new PeerDataTransport({ initiator: false });
      const selectedPeer = peer;
      const auth = new AuthenticatedResourcePeer({ transport: peer, identity: key, crypto: webEndpointCrypto, ...target,
        role: 'receiver', now: () => performance.now() });
      const receiver = createGamePointerReceiver({ peer: auth, epoch: target.epoch, manifest: INPUT_LAB_POINTER_MANIFEST,
        scope: { applicationId: target.applicationId, sessionId: target.sessionId, playerId: 'player-1', roleId: 'classic',
          deviceId: `remote-pointer-${code.epoch}`, clockDomain: `input-lab:${code.epoch}` },
        mapping: { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed', source: 'custom' },
        emit: acceptFrame, removeDevice, now: () => performance.now() });
      const refresh = () => {
        if (connection.current?.peer !== selectedPeer) return;
        if (!connection.current.admitted && !receiverInvitationCurrent(target, Date.now())) {
          stop(); setMessage('Invitation expired. Create a fresh invitation and repeat comparison.'); return;
        }
        auth.tick();
        if (connection.current?.peer !== selectedPeer) return;
        receiver.tick();
        const enrollment = auth.status();
        if (!connection.current.admitted && !receiverInvitationCurrent(target, Date.now())) {
          stop(); setMessage('Invitation expired. Create a fresh invitation and repeat comparison.'); return;
        }
        const state = receiver.receiver.status(), bridge = receiver.bridge.state();
        if (state.stopped || bridge.stopped || enrollment.phase === 'stopped' || selectedPeer.state === 'failed' || selectedPeer.state === 'disconnected') {
          stop(); setMessage('Connection ended. Aim is neutral and trigger is released. Use a fresh offer.'); return;
        }
        const next: Snapshot = { described: !!receiver.receiver.description(), clockReady: state.clockReady, active: state.active,
          comparison: enrollment.comparisonDigest, confirmed: connection.current?.confirmed, enrolled: enrollment.phase === 'active', stopped: false };
        setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (state.active === 2) setMessage('Allowed for one minute: player 1, Classic Controller; aim and trigger only.');
        else if (enrollment.phase === 'awaiting-enrollment') setMessage(next.confirmed ? 'Waiting for the source to confirm the matching code.' : 'Compare every character of the verified code on both screens, then confirm only if they match.');
        else if (enrollment.phase === 'active') setMessage('Connection verified. Review the mapping and allow aim and trigger.');
      };
      const detach = auth.onStateChange(state => {
        if (connection.current?.peer !== selectedPeer) return;
        if (state === 'failed' || state === 'disconnected') { stop(); setMessage('Connection lost. Aim is neutral and trigger is released. Use a fresh offer.'); }
        else if (state === 'connected') {
          if (!receiverInvitationCurrent(target, Date.now())) { stop(); setMessage('Invitation expired before enrollment completed. Create a fresh invitation.'); return; }
          connection.current.admitted = true;
          setMessage('Connection verified. Review the mapping and allow the two resources.');
        }
      });
      const timer = window.setInterval(refresh, 10);
      connection.current = { peer, auth, receiver, invitation: target, confirmed: false, admitted: false, dispose() { clearInterval(timer); detach(); receiver.stop(); auth.stop(); void selectedPeer.disconnect(); } };
      setInvitationCode('');
      setMessage('Preparing a local answer…');
      const description = await peer.acceptOffer(code.description);
      if (generation.current !== id) return;
      setAnswer(encodeManualPeerCode(code.epoch, description));
      setMessage('Copy the answer to the source, then compare the verified connection code on both screens.');
    } catch {
      if (generation.current === id) { stop(); void peer?.disconnect(); setMessage('Could not use this offer. Create a fresh invitation and transfer its matching complete offer.'); }
    }
    finally { if (generation.current === id) setBusy(false); }
  };
  const confirm = () => {
    const selected = connection.current, displayed = snapshot.comparison;
    if (selected && !selected.admitted && !receiverInvitationCurrent(selected.invitation, Date.now())) { stop(); setMessage('Invitation expired. Create a fresh invitation.'); return; }
    if (!selected || !displayed || !selected.auth.confirmEnrollment(displayed)) { setMessage('The comparison expired. Create a fresh invitation.'); return; }
    selected.confirmed = true; setSnapshot(previous => ({ ...previous, confirmed: true }));
    setMessage('Confirmed here. Waiting for the source to confirm.');
  };
  const allow = () => {
    try {
      if (!connection.current?.receiver.select()) { stop(); setMessage('Resources could not be allowed. Use a fresh offer.'); return; }
      setMessage('Resources approved for player 1 / Classic Controller.');
    } catch { stop(); setMessage('Resources could not be allowed. Use a fresh offer.'); }
  };
  return <details className='linked-card'>
    <summary>Remote pointer resources</summary>
    <p>Source: native pointer lab or browser <a href='/pointer-lab'>Pointer lab</a> in Send pointer mode.</p>
    <p>Application scope: <strong>player 1 · Classic Controller</strong>. Position maps to aim with x = 2x − 1 and y = 2y − 1. Contact maps to trigger. This software resource uses the custom input source. Movement controls remain available locally.</p>
    <p>Create a receiver invitation, exchange offer and answer, then compare the full verified code on both screens. Resource permission is a separate action.</p>
    <p>{identity.phase === 'ready' ? 'Local identity saved. New connections require comparison again.' : identity.phase === 'missing' ? 'No saved local identity. Create one before connecting.' : identity.phase === 'loading' ? 'Loading local identity…' : 'Identity storage is unavailable or invalid. Reload it or remove the saved identity to recover.'}</p>
    {identity.phase === 'missing' ? <button className='outline-button' onClick={() => { stop(); void identity.create(); }}>Create local identity</button> : null}
    {identity.phase === 'ready' || identity.phase === 'error' ? <>
      <button className='outline-button' onClick={() => { stop(); void identity.reload(); }}>Reload local identity</button>
      <button className='outline-button' onClick={() => { stop(); void identity.remove(); }}>Remove saved identity</button>
    </> : null}
    <button className='outline-button' onClick={createInvitation} disabled={!identity.identity || busy}>Create invitation</button>
    {invitationCode ? <>
      <label htmlFor='input-lab-pointer-invitation'>Invitation to copy to source</label>
      <textarea id='input-lab-pointer-invitation' value={invitationCode} readOnly spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
      <button className='outline-button' onClick={() => void navigator.clipboard.writeText(invitationCode).then(() => setMessage('Invitation copied.')).catch(() => setMessage('Select and copy the invitation from its field.'))}>Copy invitation</button>
    </> : null}
    <label htmlFor='input-lab-pointer-offer'>Offer from source</label>
    <textarea id='input-lab-pointer-offer' value={offer} onChange={event => setOffer(event.target.value)} maxLength={65536}
      spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
    <button className='outline-button' onClick={() => void acceptOffer()} disabled={!identity.identity || busy || !offer}>Use offer</button>
    {answer ? <>
      <label htmlFor='input-lab-pointer-answer'>Answer to copy to source</label>
      <textarea id='input-lab-pointer-answer' value={answer} readOnly spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
      <button className='outline-button' onClick={() => void navigator.clipboard.writeText(answer)
        .then(() => setMessage('Answer copied. Paste it into the source.'))
        .catch(() => setMessage('Select and copy the answer from its field.'))}>Copy answer</button>
    </> : null}
    {snapshot.comparison ? <>
      <label htmlFor='input-lab-pointer-comparison'>Verified connection code — compare every character on both screens</label>
      <textarea id='input-lab-pointer-comparison' value={snapshot.comparison} readOnly spellCheck={false} rows={2} style={{ width: '100%', minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'monospace' }} />
      <p>A matching code verifies this connection; it does not identify a person or account.</p>
      <button className='outline-button' onClick={confirm} disabled={snapshot.confirmed || snapshot.enrolled || snapshot.stopped}>Codes match — allow connection</button>
    </> : null}
    <button className='outline-button' onClick={allow} disabled={!snapshot.described || !snapshot.clockReady || snapshot.active > 0 || snapshot.stopped}>Allow aim and trigger for one minute</button>
    <button className='outline-button' onClick={() => stop()}>Stop remote pointer</button>
    <p role='status' aria-live='polite' data-testid='game-pointer-status'>{message}</p>
  </details>;
}
