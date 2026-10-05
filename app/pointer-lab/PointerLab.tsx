'use client';
import { AuthenticatedResourcePeer, PeerDataTransport, PointerResourceProvider, createReceiverInvitation,
  decodeReceiverInvitationInput, encodeReceiverInvitation, encodeReceiverInvitationLink,
  receiverInvitationCurrent, webEndpointCrypto,
  decodeManualPeerCode, encodeManualPeerCode } from '@101/connect';
import type { PointerSourceDriver, Observation, ReceiverInvitation } from '@101/connect';
import { createRemotePointerSurface } from '@/examples/device-pipelines/remote-pointer';
import { useEndpointIdentity } from '@/app/components/use-endpoint-identity';
import { createConnectionOwnership } from '@/app/lib/connection-ownership';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import styles from './pointer-lab.module.css';

type Surface = ReturnType<typeof createRemotePointerSurface>;
type Capture = { sequence: number; earliest: number; latest: number; receivedAt: number; uncertaintyMs: number };
type Session = { peer: PeerDataTransport; auth: AuthenticatedResourcePeer; invitation: ReceiverInvitation; confirmed: boolean; admitted: boolean;
  epoch: string; provider?: PointerResourceProvider; surface?: Surface; capture?: () => Capture | undefined; dispose: () => void };
type Snapshot = { position?: { x: number; y: number }; capture?: Capture; contact: boolean; described: boolean; active: number; clockReady: boolean;
  ready: boolean; stopped: boolean; comparison?: string; confirmed?: boolean; enrolled?: boolean };
const EMPTY: Snapshot = { contact: false, described: false, active: 0, clockReady: false, ready: false, stopped: false };
const directions: Record<string, [number, number]> = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] };
const newSessionId = () => `pointer-${[...webEndpointCrypto.randomBytes(16)].map(value => value.toString(16).padStart(2, '0')).join('')}`;

export default function PointerLab() {
  const [role, setRole] = useState<'receiver' | 'source'>('receiver');
  const [message, setMessage] = useState('Create an invitation for the source you want to use.');
  const [localCode, setLocalCode] = useState('');
  const [remoteCode, setRemoteCode] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [invitationCode, setInvitationCode] = useState('');
  const [invitationLink, setInvitationLink] = useState('');
  const [invitationQr, setInvitationQr] = useState('');
  const [sourceInvitation, setSourceInvitation] = useState('');
  const [reviewed, setReviewed] = useState<ReceiverInvitation>();
  const [busy, setBusy] = useState(false);
  const invitation = useRef<ReceiverInvitation | undefined>(undefined);
  const identity = useEndpointIdentity(`101.endpoint-identity.v1:pointer-${role}`);
  const ownership = useRef(createConnectionOwnership<Session>());
  const [ownerSnapshot, setOwnerSnapshot] = useState<Snapshot>(EMPTY);
  const [hasCandidate, setHasCandidate] = useState(false);
  const generation = useRef(0);
  const padRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const receiverSize = useRef({ width: 1, height: 1 });

  const stop = useCallback((update = true) => {
    generation.current++;
    ownership.current.clear(); setHasCandidate(false); setOwnerSnapshot(EMPTY);
    invitation.current = undefined;
    if (update) { setBusy(false); setSnapshot({ ...EMPTY, stopped: true }); setLocalCode(''); setInvitationCode('');
      setInvitationLink(''); setInvitationQr(''); setReviewed(undefined); setMessage('Stopped. Create a fresh invitation to continue.'); }
  }, []);
  useEffect(() => {
    const acceptLink = () => {
      if (!window.location.hash.startsWith('#invite=')) return;
      const incoming = window.location.href;
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      if (ownership.current.current()) {
        setSourceInvitation(incoming); setMessage('An invitation arrived. Stop the current pointer and choose Send pointer to review it.'); return;
      }
      stop(); setRole('source'); setSourceInvitation(incoming); setSnapshot(EMPTY);
      setMessage('Review the receiver application and session before connecting.');
    };
    acceptLink(); window.addEventListener('hashchange', acceptLink);
    return () => window.removeEventListener('hashchange', acceptLink);
  }, [stop]);
  useEffect(() => {
    if (!invitationLink) return;
    let current = true;
    void QRCode.toDataURL(invitationLink, { width: 512, margin: 4, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' } }).then(image => {
      if (current) setInvitationQr(image);
    }).catch(() => { if (current) setInvitationQr(''); });
    return () => { current = false; };
  }, [invitationLink]);
  useEffect(() => {
    const blur = () => { ownership.current.current()?.provider?.driver()?.release(); };
    const visibility = () => { if (document.hidden) stop(); };
    const leave = () => stop(false);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leave); stop(false); };
  }, [stop]);
  useEffect(() => {
    const element = padRef.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width <= 0 || height <= 0) return;
      receiverSize.current = { width, height };
      for (const session of [ownership.current.current(), ownership.current.pending()]) session?.surface?.resize(width, height);
      const surface = ownership.current.current()?.surface;
      if (surface) setOwnerSnapshot(current => ({ ...current, ...surface.state() }));
    });
    observer.observe(element); return () => observer.disconnect();
  }, [role]);
  useLayoutEffect(() => {
    // Receiver-clock DOM commit callback. This is not physical display/photon timing.
    if (markerRef.current && ownerSnapshot.capture) markerRef.current.dataset.renderedAt = String(performance.now());
  }, [ownerSnapshot]);

  const install = (peer: PeerDataTransport, auth: AuthenticatedResourcePeer, target: ReceiverInvitation, provider?: PointerResourceProvider, surface?: Surface, capture?: () => Capture | undefined): Session => {
    const session: Session = { peer, auth, invitation: target, confirmed: false, admitted: false, epoch: target.epoch, provider, surface, capture, dispose() {
      clearInterval(timer); detachInput(); detach(); provider?.stop(); surface?.stop(); auth.stop(); void peer.disconnect();
    } };
    const owned = () => ownership.current.current() === session || ownership.current.pending() === session;
    const retire = (reason: string) => {
      const wasSelected = ownership.current.selected() === session;
      ownership.current.retire(session);
      setHasCandidate(!!ownership.current.pending());
      if (!ownership.current.current()) setOwnerSnapshot(EMPTY);
      if (wasSelected) { setSnapshot({ ...EMPTY, stopped: true }); setMessage(reason); }
    };
    const update = () => {
      if (!owned()) return;
      const receiver = surface?.receiver.status(), source = provider?.status(), input = provider?.driver()?.state();
      const authentication = auth.status();
      if (!session.admitted && !receiverInvitationCurrent(target, Date.now())) { retire('Invitation expired. Create a fresh invitation on the receiver.'); return; }
      const next: Snapshot = { ...EMPTY, ...(surface?.state() ?? {}), ...(input ? { contact: input.contact } : {}), ...(surface?.state().position ? { capture: capture?.() } : {}),
        described: !!surface?.receiver.description(), active: receiver?.active ?? 0, clockReady: receiver?.clockReady ?? false,
        comparison: authentication.comparisonDigest, confirmed: session.confirmed, enrolled: authentication.phase === 'active',
        ready: source?.ready ?? false, stopped: authentication.phase === 'stopped' || (receiver?.stopped ?? source?.stopped ?? false) || !!receiver && ['expired', 'overload', 'unavailable', 'incompatible'].includes(receiver.reason) };
      if (next.stopped) { retire('Connection stopped. Start a fresh connection to continue.'); return; }
      // The source owner already chose this reviewed target when creating its offer.
      // Wait for independently granted resources before moving the local input pad.
      if (provider && source?.ready && ownership.current.pending() === session) {
        if (!ownership.current.activate(session, () => true)) return;
        setHasCandidate(false);
      }
      if (ownership.current.current() === session) setOwnerSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (ownership.current.selected() !== session) return;
      setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (source?.ready) setMessage('Move on the pad. Arrows move; hold Space to press.');
      else if (receiver?.active === 2) setMessage('Pointer allowed for one minute. Stop releases it immediately.');
      else if (authentication.phase === 'awaiting-enrollment') setMessage(next.confirmed ? 'Waiting for the other screen to confirm the matching code.' : 'Compare every character of the code on both screens, then confirm only if they match.');
      else if (authentication.phase === 'active') setMessage(provider ? 'Connection verified. Allow pointer on the receiving screen.' : 'Connection verified. Choose Allow pointer to use this source.');
    };
    const detach = auth.onStateChange(state => {
      if (!owned()) return;
      if (state === 'failed' || state === 'disconnected') { setMessage('Connection lost. Start a fresh connection.'); update(); }
      else if (state === 'connected') {
        if (!receiverInvitationCurrent(target, Date.now())) { retire('Invitation expired before enrollment completed. Create a fresh invitation.'); return; }
        session.admitted = true;
        setMessage('Connection verified. The receiver can now select its resources.');
      }
    });
    // The receiver queues validated observations before this subscription runs.
    // Deliver and render immediately; the timer still owns pending/rate-limited
    // delivery, clock probes and expiry when no packets arrive.
    const detachInput = surface ? auth.onData(() => {
      if (!owned()) return;
      surface.tick(); update();
    }) : () => {};
    const timer = window.setInterval(() => {
      if (!owned()) return;
      if (!session.admitted && !receiverInvitationCurrent(target, Date.now())) { retire('Invitation expired. Create a fresh invitation.'); return; }
      auth.tick(); if (!owned()) return;
      provider?.tick(); surface?.tick(); update();
    }, 10);
    ownership.current.stage(session); setHasCandidate(true); return session;
  };
  const cancelCandidate = () => {
    generation.current++; ownership.current.discard(); setHasCandidate(false); setBusy(false);
    invitation.current = undefined; setInvitationCode(''); setInvitationLink(''); setInvitationQr(''); setLocalCode(''); setRemoteCode('');
    setSnapshot(ownership.current.current() ? ownerSnapshot : EMPTY);
    setMessage(ownership.current.current() ? 'New request cancelled. The current pointer remains active.' : 'Request cancelled. Create a fresh invitation to continue.');
  };
  const createInvitation = () => {
    generation.current++; ownership.current.discard(); setHasCandidate(false); setSnapshot(ownership.current.current() ? ownerSnapshot : EMPTY); setLocalCode(''); setRemoteCode('');
    if (!identity.identity) { setMessage('Create or reload your local identity first.'); return; }
    try {
      const value = createReceiverInvitation({ applicationId: 'independent-pointer-surface', sessionId: newSessionId(), now: Date.now(), randomBytes: webEndpointCrypto.randomBytes });
      invitation.current = value; setInvitationCode(encodeReceiverInvitation(value));
      setInvitationQr(''); setInvitationLink(encodeReceiverInvitationLink(value, `${window.location.origin}/pointer-lab`));
      setMessage('Share the link, scan the code, or copy the manual invitation. It lasts five minutes.');
    } catch { setMessage('Could not create an invitation. Reload your local identity and try again.'); }
  };
  const reviewInvitation = () => {
    try { setReviewed(decodeReceiverInvitationInput(sourceInvitation, Date.now())); setMessage('Review the receiver application and session below before connecting.'); }
    catch { setReviewed(undefined); setMessage('Use a complete fresh receiver invitation. Check that both device clocks agree.'); }
  };
  const createOffer = async () => {
    generation.current++; ownership.current.discard(); setHasCandidate(false); setSnapshot(EMPTY); setLocalCode(''); setBusy(true); setMessage('Preparing a local offer…');
    const id = generation.current, target = reviewed, key = identity.identity;
    try {
      if (!target || !key || !receiverInvitationCurrent(target, Date.now())) throw new Error();
      const peer = new PeerDataTransport({ initiator: true });
      const auth = new AuthenticatedResourcePeer({ transport: peer, identity: key, crypto: webEndpointCrypto, ...target,
        role: 'source', now: () => performance.now() });
      const provider = new PointerResourceProvider({ peer: auth, epoch: target.epoch, clockId: `browser-source:${target.epoch}`, now: () => performance.now(),
        platform: 'browser-pointer-events', available: () => !document.hidden });
      install(peer, auth, target, provider);
      const description = await peer.createOffer(); if (generation.current !== id) return;
      setLocalCode(encodeManualPeerCode(target.epoch, description)); setMessage('Copy the offer to the receiving screen, then paste its answer here.');
    } catch { if (generation.current === id) { ownership.current.discard(); setHasCandidate(false); setSnapshot(ownership.current.current() ? ownerSnapshot : EMPTY); setMessage('Could not prepare an offer. The current pointer is unchanged. Review a fresh invitation and try again.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const acceptOffer = async () => {
    const target = invitation.current, key = identity.identity;
    generation.current++; ownership.current.discard(); setHasCandidate(false); setSnapshot(EMPTY); setLocalCode(''); setBusy(true);
    const id = generation.current;
    try {
      if (!target || !key || !receiverInvitationCurrent(target, Date.now())) throw new Error();
      const code = decodeManualPeerCode(remoteCode, 'offer', target.epoch);
      const peer = new PeerDataTransport({ initiator: false });
      const auth = new AuthenticatedResourcePeer({ transport: peer, identity: key, crypto: webEndpointCrypto, ...target,
        role: 'receiver', now: () => performance.now() });
      let captured: Capture | undefined;
      const onObservation = (observation: Observation) => {
        if (observation.source.capabilityId !== 'position') return;
        const latest = observation.provenance?.captureLatest, uncertainty = observation.provenance?.uncertaintyMs;
        if (typeof latest === 'number' && typeof uncertainty === 'number') captured = { sequence: observation.sequence,
          earliest: observation.timestamp, latest, receivedAt: observation.receivedAt, uncertaintyMs: uncertainty };
      };
      const surface = createRemotePointerSurface({ peer: auth, epoch: target.epoch, clockId: `browser-surface:${target.epoch}`, now: () => performance.now(),
        principalId: 'local-lab-owner', applicationId: target.applicationId, sessionId: target.sessionId, onObservation, ...receiverSize.current });
      install(peer, auth, target, undefined, surface, () => captured); setInvitationCode(''); setInvitationLink('');
      setInvitationQr(''); setMessage('Preparing a local answer…');
      const answer = await peer.acceptOffer(code.description); if (generation.current !== id) return;
      setLocalCode(encodeManualPeerCode(code.epoch, answer)); setMessage('Copy this answer to the source, then compare the connection codes on both screens.');
    } catch { if (generation.current === id) { ownership.current.discard(); setHasCandidate(false); setSnapshot(ownership.current.current() ? ownerSnapshot : EMPTY); setMessage('Could not use this offer. The current pointer is unchanged. Create a fresh invitation and use its matching complete offer.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const acceptAnswer = async () => {
    const session = ownership.current.pending(), id = generation.current;
    if (!session?.provider) return;
    setBusy(true);
    try {
      const code = decodeManualPeerCode(remoteCode, 'answer', session.epoch);
      await session.peer.acceptAnswer(code.description); if (generation.current !== id) return;
      setMessage('Answer accepted. Wait for the verified comparison code on both screens.');
    } catch { if (generation.current === id) { ownership.current.discard(session); setHasCandidate(false); setSnapshot(ownership.current.current() ? ownerSnapshot : EMPTY); setMessage('Could not use this answer. The current pointer is unchanged. Review a fresh invitation and transfer its complete codes.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const confirm = () => {
    const selected = ownership.current.selected(), displayed = snapshot.comparison;
    if (selected && !selected.admitted && !receiverInvitationCurrent(selected.invitation, Date.now())) { ownership.current.discard(selected); setHasCandidate(false); setMessage('Invitation expired. Create a fresh invitation.'); return; }
    if (!selected || !displayed || !selected.auth.confirmEnrollment(displayed)) { setMessage('The comparison expired. Create a fresh invitation.'); return; }
    selected.confirmed = true; setSnapshot(previous => ({ ...previous, confirmed: true }));
    setMessage('Confirmed here. Waiting for the other screen to confirm.');
  };
  const select = () => {
    const selected = ownership.current.pending();
    if (!selected?.surface) return;
    setOwnerSnapshot(EMPTY);
    if (!ownership.current.activate(selected, () => selected.surface!.select())) {
      setHasCandidate(!!ownership.current.pending()); setOwnerSnapshot(EMPTY); setSnapshot({ ...EMPTY, stopped: true }); setMessage('Pointer could not be allowed. Control is released. Create a fresh invitation and try again.'); return;
    }
    setHasCandidate(false);
    setMessage('Pointer allowed for one minute.');
  };
  const driver = (): PointerSourceDriver | undefined => ownership.current.current()?.provider?.driver();
  const touch = (event: PointerEvent<HTMLDivElement>, phase: 'begin' | 'move' | 'end') => {
    const input = driver(); if (!input) return;
    const pad = event.currentTarget, rect = pad.getBoundingClientRect();
    if (phase === 'begin') {
      if (event.button !== 0) return;
      pad.focus(); pad.setPointerCapture(event.pointerId);
      input.begin(event.pointerId, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    } else if (phase === 'move') input.move(event.pointerId, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    else input.end(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, down: boolean) => {
    const input = driver(); if (!input) return;
    const delta = directions[event.key];
    if (delta) { event.preventDefault(); if (down) input.nudge(...delta); }
    if (event.code === 'Space') { event.preventDefault(); input.setContact(down); }
    if (event.key === 'Escape') { event.preventDefault(); input.release(); }
  };
  const choose = (next: 'receiver' | 'source') => {
    stop(false); setBusy(false); setRole(next); setSnapshot(EMPTY); setLocalCode(''); setRemoteCode('');
    setInvitationCode(''); setInvitationLink(''); setInvitationQr(''); setSourceInvitation(''); setReviewed(undefined);
    setMessage(next === 'receiver' ? 'Create an invitation for the source you want to use.' : 'Paste a receiver invitation and review its application and session.');
  };
  return <main className={styles.lab}>
    <header className={styles.header}><Link href='/studio'>101 Studio</Link><button onClick={() => stop()}>Stop</button></header>
    <div className={styles.title}><h1>Pointer lab</h1><p>A touch pad and an independent application surface.</p></div>
    <div className={styles.roles} aria-label='Choose this screen’s role'>
      <button aria-pressed={role === 'receiver'} onClick={() => choose('receiver')}>Receive pointer</button>
      <button aria-pressed={role === 'source'} onClick={() => choose('source')}>Send pointer</button>
    </div>
    <p role='status' aria-live='polite' className={styles.status}>{message}</p>
    <div className={styles.identity}>
      <p>{identity.phase === 'ready' ? 'Local identity saved. Each new connection still requires comparison on both screens.' : identity.phase === 'missing' ? 'No saved local identity. Create one before connecting.' : identity.phase === 'loading' ? 'Loading local identity…' : 'Local identity storage is unavailable or invalid. Reload it or remove the saved identity to recover.'}</p>
      {identity.phase === 'missing' ? <button onClick={() => { stop(); void identity.create(); }}>Create local identity</button> : null}
      {identity.phase === 'error' || identity.phase === 'ready' ? <button onClick={() => { stop(); void identity.reload(); }}>Reload local identity</button> : null}
      {identity.phase === 'ready' || identity.phase === 'error' ? <button onClick={() => { stop(); void identity.remove(); }}>Remove saved identity</button> : null}
    </div>
    {snapshot.comparison ? <div className={styles.comparison}>
      <label htmlFor='endpoint-comparison-code'>Verified connection code — compare every character on both screens</label>
      <textarea id='endpoint-comparison-code' value={snapshot.comparison} readOnly spellCheck={false} rows={2} />
      <p>Only confirm while you can compare the other screen directly. A matching code verifies this connection; it does not identify a person or account.</p>
      <button onClick={confirm} disabled={snapshot.confirmed || snapshot.enrolled || snapshot.stopped}>Codes match — allow connection</button>
    </div> : null}
    {role === 'receiver' ? <button className={styles.primary} onClick={select} disabled={!hasCandidate || !snapshot.described || !snapshot.clockReady || snapshot.active > 0 || snapshot.stopped}>{ownerSnapshot.active > 0 ? 'Transfer pointer for one minute' : 'Allow pointer for one minute'}</button> : null}
    {hasCandidate || invitationCode ? <button onClick={cancelCandidate}>Cancel new request</button> : null}
    {(ownerSnapshot.ready || ownerSnapshot.active > 0) && (hasCandidate || invitationCode) ? <p>Current pointer remains active while you review the new request. Transfer releases it before allowing the new source.</p> : null}
    <div ref={padRef} className={`${styles.pad} ${role === 'source' ? styles.source : ''}`} role={role === 'source' ? 'group' : 'img'}
      aria-label={role === 'source' ? 'Touch pad. Arrow keys move, Space presses, Escape releases.' : 'Application pointer surface'}
      tabIndex={role === 'source' ? 0 : undefined} data-contact={ownerSnapshot.contact} data-ready={ownerSnapshot.ready || ownerSnapshot.active === 2}
      onPointerDown={event => touch(event, 'begin')} onPointerMove={event => touch(event, 'move')}
      onPointerUp={event => touch(event, 'end')} onPointerCancel={event => touch(event, 'end')} onLostPointerCapture={event => touch(event, 'end')}
      onKeyDown={event => key(event, true)} onKeyUp={event => key(event, false)} onBlur={() => driver()?.release()}>
      {role === 'receiver' && ownerSnapshot.position ? <span ref={markerRef} className={styles.marker} data-testid='application-pointer'
        data-sequence={ownerSnapshot.capture?.sequence} data-capture-earliest={ownerSnapshot.capture?.earliest} data-capture-latest={ownerSnapshot.capture?.latest}
        data-received-at={ownerSnapshot.capture?.receivedAt} data-uncertainty-ms={ownerSnapshot.capture?.uncertaintyMs} style={{ left: ownerSnapshot.position.x, top: ownerSnapshot.position.y }} /> :
        <span className={styles.padLabel}>{role === 'source' ? (ownerSnapshot.ready ? 'Move anywhere on the pad' : 'Connect and allow pointer to begin') : 'Your pointer will appear here'}</span>}
    </div>
    {role === 'source' ? <div className={styles.controls} aria-label='Pointer controls'>
      <button onClick={() => driver()?.nudge(-0.02, 0)} disabled={!ownerSnapshot.ready}>Left</button><button onClick={() => driver()?.nudge(0, -0.02)} disabled={!ownerSnapshot.ready}>Up</button>
      <button onClick={() => driver()?.nudge(0, 0.02)} disabled={!ownerSnapshot.ready}>Down</button><button onClick={() => driver()?.nudge(0.02, 0)} disabled={!ownerSnapshot.ready}>Right</button>
      <button aria-pressed={ownerSnapshot.contact} onClick={() => { const input = driver(); input?.setContact(!input.state().contact); }} disabled={!ownerSnapshot.ready}>Press / release</button>
    </div> : null}
    <details className={styles.pairing} open={!snapshot.ready && snapshot.active === 0}><summary>Local pairing</summary>
      <p>Use a receiver invitation, then exchange offer and answer. Both owners compare the verified connection code before any resources are shared.</p>
      {role === 'receiver' ? <>
        <button onClick={createInvitation} disabled={!identity.identity || busy}>Create invitation</button>
        {invitationCode ? <><label htmlFor='receiver-invitation-code'>Invitation to copy to source</label>
          <textarea id='receiver-invitation-code' value={invitationCode} readOnly spellCheck={false} rows={3} />
          <button onClick={() => void navigator.clipboard.writeText(invitationCode).then(() => setMessage('Invitation copied.')).catch(() => setMessage('Select and copy the invitation from its field.'))}>Copy invitation</button>
          {invitationLink ? <><label htmlFor='receiver-invitation-link'>Invitation link</label>
            <textarea id='receiver-invitation-link' value={invitationLink} readOnly spellCheck={false} rows={2} />
            <button onClick={() => void navigator.clipboard.writeText(invitationLink).then(() => setMessage('Link copied.')).catch(() => setMessage('Select and copy the link from its field.'))}>Copy link</button>
            {invitationQr ? <div className={styles.qr}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={invitationQr} alt='Scan this invitation link on the source device' />
            </div> : null}</> : null}</> : null}
      </> : <>
        <label htmlFor='source-invitation-code'>Invitation link or manual code from receiver</label>
        <textarea id='source-invitation-code' value={sourceInvitation} onChange={event => { setSourceInvitation(event.target.value); setReviewed(undefined); }} maxLength={4096} spellCheck={false} />
        <button onClick={reviewInvitation} disabled={!identity.identity || busy || !sourceInvitation}>Review invitation</button>
        {reviewed ? <div data-testid='reviewed-target' className={styles.target}>
          <p>Receiver application: <strong>{reviewed.applicationId}</strong></p><p>Receiver session: <strong>{reviewed.sessionId}</strong></p>
          <button onClick={() => void createOffer()} disabled={!identity.identity || busy}>Connect to this receiver</button>
        </div> : null}
      </>}
      <label htmlFor='remote-pointer-code'>{role === 'receiver' ? 'Offer from source' : 'Answer from receiver'}</label>
      <textarea id='remote-pointer-code' value={remoteCode} onChange={event => setRemoteCode(event.target.value)} spellCheck={false} maxLength={65536} />
      <button onClick={() => void (role === 'receiver' ? acceptOffer() : acceptAnswer())} disabled={!identity.identity || busy || !remoteCode}>{role === 'receiver' ? 'Use offer' : 'Use answer'}</button>
      {localCode ? <><label htmlFor='local-pointer-code'>{role === 'receiver' ? 'Answer to copy to source' : 'Offer to copy to receiver'}</label>
        <textarea id='local-pointer-code' value={localCode} readOnly spellCheck={false} /><button onClick={() => void navigator.clipboard.writeText(localCode).then(() => setMessage('Code copied.')).catch(() => setMessage('Select and copy the code from the field.'))}>Copy code</button></> : null}
    </details>
  </main>;
}
