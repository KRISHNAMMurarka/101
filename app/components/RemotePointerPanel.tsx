'use client';

import { AuthenticatedResourcePeer, createReceiverInvitation, decodeManualPeerCode, encodeManualPeerCode,
  encodeReceiverInvitation, receiverInvitationCurrent, webEndpointCrypto, PeerDataTransport } from '@101/connect';
import type { ReceiverInvitation } from '@101/connect';
import type { InputFrame } from '@101/input';
import { createGamePointerReceiver, INPUT_LAB_POINTER_MANIFEST } from '@/examples/device-pipelines/game-pointer-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEndpointIdentity } from './use-endpoint-identity';
import { createConnectionOwnership } from '@/app/lib/connection-ownership';
import { copyInvitationLink } from '@/app/lib/invitation-copy';

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
  const connection = useRef(createConnectionOwnership<Connection>());
  const [hasCandidate, setHasCandidate] = useState(false);
  const [hasOwner, setHasOwner] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false), copyReserved = useRef(false);
  const [copying, setCopying] = useState(false);
  const copyCode = async (value: string, copied: string, manual: string) => {
    if (copyReserved.current || !value) return;
    const revision = generation.current;
    copyReserved.current = true; setCopying(true);
    setMessage('Waiting for permission to copy. You can select and copy the field yourself.');
    try {
      const current = () => mounted.current && generation.current === revision;
      const phase = await copyInvitationLink({ url: value, isCurrent: current,
        writeText: text => navigator.clipboard?.writeText(text) });
      if (current() && phase !== 'stopped') setMessage(phase === 'copied' ? copied : manual);
    } finally {
      copyReserved.current = false;
      if (mounted.current) setCopying(false);
    }
  };
  const stop = useCallback((update = true) => {
    generation.current++;
    connection.current.clear(); setHasCandidate(false); setHasOwner(false);
    invitation.current = undefined;
    if (update) { setBusy(false); setAnswer(''); setInvitationCode(''); setSnapshot({ ...EMPTY, stopped: true }); setMessage('Stopped. Aim is neutral and trigger is released. Create a fresh invitation to continue.'); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const blur = () => { if (connection.current.current()?.receiver.bridge.state().approved) stop(); };
    const hidden = () => { if (document.hidden) stop(); };
    const leave = () => stop(false);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); stop(false); };
  }, [stop, sessionId]);

  const createInvitation = () => {
    generation.current++; connection.current.discard(); setHasCandidate(false); setSnapshot(EMPTY); setAnswer(''); setOffer('');
    if (!identity.identity) { setMessage('Create or reload your local identity first.'); return; }
    try {
      const value = createReceiverInvitation({ applicationId: INPUT_LAB_POINTER_MANIFEST.game, sessionId, now: Date.now(), randomBytes: webEndpointCrypto.randomBytes });
      invitation.current = value; setInvitationCode(encodeReceiverInvitation(value));
      setMessage('Copy this five-minute invitation to the source and review its application and session there.');
    } catch { setMessage('Could not create an invitation. Reload the local identity and try again.'); }
  };
  const acceptOffer = async () => {
    const target = invitation.current, key = identity.identity;
    generation.current++; connection.current.discard(); setHasCandidate(false); setSnapshot(EMPTY); setAnswer(''); setBusy(true);
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
      const selected: Connection = { peer, auth, receiver, invitation: target, confirmed: false, admitted: false, dispose() { clearInterval(timer); detach(); receiver.stop(); auth.stop(); void selectedPeer.disconnect(); } };
      const owned = () => connection.current.current() === selected || connection.current.pending() === selected;
      const retire = (reason: string) => {
        const wasSelected = connection.current.selected() === selected;
        connection.current.retire(selected); setHasOwner(!!connection.current.current()); setHasCandidate(!!connection.current.pending());
        if (wasSelected) { setSnapshot({ ...EMPTY, stopped: true }); setMessage(reason); }
      };
      const refresh = () => {
        if (!owned()) return;
        if (!selected.admitted && !receiverInvitationCurrent(target, Date.now())) {
          retire('Invitation expired. Create a fresh invitation and repeat comparison.'); return;
        }
        auth.tick();
        if (!owned()) return;
        receiver.tick();
        const enrollment = auth.status();
        if (!selected.admitted && !receiverInvitationCurrent(target, Date.now())) {
          retire('Invitation expired. Create a fresh invitation and repeat comparison.'); return;
        }
        const state = receiver.receiver.status(), bridge = receiver.bridge.state();
        if (state.stopped || bridge.stopped || enrollment.phase === 'stopped' || selectedPeer.state === 'failed' || selectedPeer.state === 'disconnected') {
          retire('Connection ended. Use a fresh offer.'); return;
        }
        if (connection.current.selected() !== selected) return;
        const next: Snapshot = { described: !!receiver.receiver.description(), clockReady: state.clockReady, active: state.active,
          comparison: enrollment.comparisonDigest, confirmed: selected.confirmed, enrolled: enrollment.phase === 'active', stopped: false };
        setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (state.active === 2) setMessage('Allowed for one minute: player 1, Classic Controller; aim and trigger only.');
        else if (enrollment.phase === 'awaiting-enrollment') setMessage(next.confirmed ? 'Waiting for the source to confirm the matching code.' : 'Compare every character of the verified code on both screens, then confirm only if they match.');
        else if (enrollment.phase === 'active') setMessage('Connection verified. Review the mapping and allow aim and trigger.');
      };
      const detach = auth.onStateChange(state => {
        if (!owned()) return;
        if (state === 'failed' || state === 'disconnected') { retire('Connection lost. Use a fresh offer.'); }
        else if (state === 'connected') {
          if (!receiverInvitationCurrent(target, Date.now())) { retire('Invitation expired before enrollment completed. Create a fresh invitation.'); return; }
          selected.admitted = true;
          setMessage('Connection verified. Review the mapping and allow the two resources.');
        }
      });
      const timer = window.setInterval(refresh, 10);
      connection.current.stage(selected); setHasCandidate(true);
      setInvitationCode('');
      setMessage('Preparing a local answer…');
      const description = await peer.acceptOffer(code.description);
      if (generation.current !== id) return;
      setAnswer(encodeManualPeerCode(code.epoch, description));
      setMessage('Copy the answer to the source, then compare the verified connection code on both screens.');
    } catch {
      if (generation.current === id) { connection.current.discard(); setHasCandidate(false); void peer?.disconnect(); setMessage('Could not use this offer. The current pointer is unchanged. Create a fresh invitation and use its matching complete offer.'); }
    }
    finally { if (generation.current === id) setBusy(false); }
  };
  const confirm = () => {
    const selected = connection.current.selected(), displayed = snapshot.comparison;
    if (selected && !selected.admitted && !receiverInvitationCurrent(selected.invitation, Date.now())) { connection.current.discard(selected); setHasCandidate(false); setMessage('Invitation expired. Create a fresh invitation.'); return; }
    if (!selected || !displayed || !selected.auth.confirmEnrollment(displayed)) { setMessage('The comparison expired. Create a fresh invitation.'); return; }
    selected.confirmed = true; setSnapshot(previous => ({ ...previous, confirmed: true }));
    setMessage('Confirmed here. Waiting for the source to confirm.');
  };
  const allow = () => {
    const selected = connection.current.pending();
    if (!selected) return;
    if (!connection.current.activate(selected, () => selected.receiver.select())) {
      setHasOwner(!!connection.current.current()); setHasCandidate(!!connection.current.pending()); setSnapshot({ ...EMPTY, stopped: true });
      setMessage('Resources could not be allowed. Control is released. Create a fresh invitation and try again.'); return;
    }
    setHasOwner(true); setHasCandidate(false); setMessage('Resources approved for player 1 / Classic Controller.');
  };
  const cancelCandidate = () => {
    generation.current++; connection.current.discard(); setHasCandidate(false); setBusy(false); setSnapshot(EMPTY);
    invitation.current = undefined; setInvitationCode(''); setAnswer(''); setOffer('');
    setMessage(connection.current.current() ? 'New request cancelled. The current pointer remains active.' : 'Request cancelled. Create a fresh invitation to continue.');
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
      <button className='outline-button' disabled={copying} onClick={() => void copyCode(invitationCode, 'Invitation copied.', 'Select and copy the invitation from its field.')}>Copy invitation</button>
    </> : null}
    <label htmlFor='input-lab-pointer-offer'>Offer from source</label>
    <textarea id='input-lab-pointer-offer' value={offer} onChange={event => setOffer(event.target.value)} maxLength={65536}
      spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
    <button className='outline-button' onClick={() => void acceptOffer()} disabled={!identity.identity || busy || !offer}>Use offer</button>
    {answer ? <>
      <label htmlFor='input-lab-pointer-answer'>Answer to copy to source</label>
      <textarea id='input-lab-pointer-answer' value={answer} readOnly spellCheck={false} rows={3} style={{ width: '100%', minWidth: 0 }} />
      <button className='outline-button' disabled={copying} onClick={() => void copyCode(answer,
        'Answer copied. Paste it into the source.', 'Select and copy the answer from its field.')}>Copy answer</button>
    </> : null}
    {snapshot.comparison ? <>
      <label htmlFor='input-lab-pointer-comparison'>Verified connection code — compare every character on both screens</label>
      <textarea id='input-lab-pointer-comparison' value={snapshot.comparison} readOnly spellCheck={false} rows={2} style={{ width: '100%', minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'monospace' }} />
      <p>A matching code verifies this connection; it does not identify a person or account.</p>
      <button className='outline-button' onClick={confirm} disabled={snapshot.confirmed || snapshot.enrolled || snapshot.stopped}>Codes match — allow connection</button>
    </> : null}
    <button className='outline-button' onClick={allow} disabled={!hasCandidate || !snapshot.described || !snapshot.clockReady || snapshot.active > 0 || snapshot.stopped}>{hasOwner ? 'Transfer aim and trigger for one minute' : 'Allow aim and trigger for one minute'}</button>
    {hasCandidate || invitationCode ? <button className='outline-button' onClick={cancelCandidate}>Cancel new request</button> : null}
    {hasOwner && (hasCandidate || invitationCode) ? <p>Current pointer remains active while you review the new request. Transfer releases it before allowing the new source.</p> : null}
    <button className='outline-button' onClick={() => stop()}>Stop remote pointer</button>
    <p role='status' aria-live='polite' data-testid='game-pointer-status'>{message}</p>
  </details>;
}
