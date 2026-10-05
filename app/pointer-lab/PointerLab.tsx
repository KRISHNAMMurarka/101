'use client';
import { AuthenticatedResourcePeer, PeerDataTransport, PointerResourceProvider, createReceiverInvitation,
  decodeReceiverInvitationInput, encodeReceiverInvitation, encodeReceiverInvitationLink,
  receiverInvitationCurrent, webEndpointCrypto,
  decodeManualPeerCode, encodeManualPeerCode } from '@101/connect';
import type { PointerSourceDriver, Observation, ReceiverInvitation } from '@101/connect';
import { createRemotePointerSurface } from '@/examples/device-pipelines/remote-pointer';
import { useEndpointIdentity } from '@/app/components/use-endpoint-identity';
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
  const sessionRef = useRef<Session | null>(null);
  const generation = useRef(0);
  const padRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const receiverSize = useRef({ width: 1, height: 1 });

  const stop = useCallback((update = true) => {
    generation.current++;
    const session = sessionRef.current; sessionRef.current = null;
    session?.dispose();
    invitation.current = undefined;
    if (update) { setBusy(false); setSnapshot({ ...EMPTY, stopped: true }); setLocalCode(''); setInvitationCode('');
      setInvitationLink(''); setInvitationQr(''); setReviewed(undefined); setMessage('Stopped. Create a fresh invitation to continue.'); }
  }, []);
  useEffect(() => {
    const acceptLink = () => {
      if (!window.location.hash.startsWith('#invite=')) return;
      const incoming = window.location.href;
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
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
    const blur = () => { sessionRef.current?.provider?.driver()?.release(); };
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
      const surface = sessionRef.current?.surface;
      if (surface) { surface.resize(width, height); setSnapshot(current => ({ ...current, ...surface.state() })); }
    });
    observer.observe(element); return () => observer.disconnect();
  }, [role]);
  useLayoutEffect(() => {
    // Receiver-clock DOM commit callback. This is not physical display/photon timing.
    if (markerRef.current && snapshot.capture) markerRef.current.dataset.renderedAt = String(performance.now());
  }, [snapshot]);

  const install = (peer: PeerDataTransport, auth: AuthenticatedResourcePeer, target: ReceiverInvitation, provider?: PointerResourceProvider, surface?: Surface, capture?: () => Capture | undefined): Session => {
    const update = () => {
      if (sessionRef.current?.peer !== peer) return;
      const receiver = surface?.receiver.status(), source = provider?.status(), input = provider?.driver()?.state();
      const authentication = auth.status();
      if (!sessionRef.current?.admitted && !receiverInvitationCurrent(target, Date.now())) { stop(); setMessage('Invitation expired. Create a fresh invitation on the receiver.'); return; }
      const next: Snapshot = { ...EMPTY, ...(surface?.state() ?? {}), ...(input ? { contact: input.contact } : {}), ...(surface?.state().position ? { capture: capture?.() } : {}),
        described: !!surface?.receiver.description(), active: receiver?.active ?? 0, clockReady: receiver?.clockReady ?? false,
        comparison: authentication.comparisonDigest, confirmed: sessionRef.current?.confirmed, enrolled: authentication.phase === 'active',
        ready: source?.ready ?? false, stopped: authentication.phase === 'stopped' || (receiver?.stopped ?? source?.stopped ?? false) || !!receiver && ['expired', 'overload', 'unavailable', 'incompatible'].includes(receiver.reason) };
      setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (next.stopped) { stop(); setMessage('Connection stopped. Start a fresh connection to continue.'); }
      else if (source?.ready) setMessage('Move on the pad. Arrows move; hold Space to press.');
      else if (receiver?.active === 2) setMessage('Pointer allowed for one minute. Stop releases it immediately.');
      else if (authentication.phase === 'awaiting-enrollment') setMessage(next.confirmed ? 'Waiting for the other screen to confirm the matching code.' : 'Compare every character of the code on both screens, then confirm only if they match.');
      else if (authentication.phase === 'active') setMessage(provider ? 'Connection verified. Allow pointer on the receiving screen.' : 'Connection verified. Choose Allow pointer to use this source.');
    };
    const detach = auth.onStateChange(state => {
      if (sessionRef.current?.peer !== peer) return;
      if (state === 'failed' || state === 'disconnected') { setMessage('Connection lost. Start a fresh connection.'); update(); }
      else if (state === 'connected') {
        if (!receiverInvitationCurrent(target, Date.now())) { stop(); setMessage('Invitation expired before enrollment completed. Create a fresh invitation.'); return; }
        sessionRef.current.admitted = true;
        setMessage('Connection verified. The receiver can now select its resources.');
      }
    });
    // The receiver queues validated observations before this subscription runs.
    // Deliver and render immediately; the timer still owns pending/rate-limited
    // delivery, clock probes and expiry when no packets arrive.
    const detachInput = surface ? auth.onData(() => {
      if (sessionRef.current?.peer !== peer) return;
      surface.tick(); update();
    }) : () => {};
    const timer = window.setInterval(() => {
      const selected = sessionRef.current; if (selected?.peer !== peer) return;
      if (!selected.admitted && !receiverInvitationCurrent(target, Date.now())) { stop(); setMessage('Invitation expired. Create a fresh invitation.'); return; }
      auth.tick(); if (sessionRef.current !== selected) return;
      provider?.tick(); surface?.tick(); update();
    }, 10);
    const session: Session = { peer, auth, invitation: target, confirmed: false, admitted: false, epoch: target.epoch, provider, surface, capture, dispose() {
      clearInterval(timer); detachInput(); detach(); provider?.stop(); surface?.stop(); auth.stop(); void peer.disconnect();
    } };
    sessionRef.current = session; return session;
  };
  const createInvitation = () => {
    stop(false); setSnapshot(EMPTY); setLocalCode(''); setRemoteCode('');
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
    stop(false); setSnapshot(EMPTY); setLocalCode(''); setBusy(true); setMessage('Preparing a local offer…');
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
    } catch { if (generation.current === id) { stop(); setMessage('Could not prepare an offer. Check the invitation, local identity and WebRTC availability, then try again.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const acceptOffer = async () => {
    const target = invitation.current, key = identity.identity;
    stop(false); setSnapshot(EMPTY); setLocalCode(''); setBusy(true);
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
    } catch { if (generation.current === id) { stop(); setMessage('Could not use this offer. Create a fresh invitation and use its matching complete offer.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const acceptAnswer = async () => {
    const session = sessionRef.current, id = generation.current;
    if (!session?.provider) return;
    setBusy(true);
    try {
      const code = decodeManualPeerCode(remoteCode, 'answer', session.epoch);
      await session.peer.acceptAnswer(code.description); if (generation.current !== id) return;
      setMessage('Answer accepted. Wait for the verified comparison code on both screens.');
    } catch { if (generation.current === id) { stop(); setMessage('Could not use this answer. Create a fresh invitation and transfer its complete codes.'); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  const confirm = () => {
    const selected = sessionRef.current, displayed = snapshot.comparison;
    if (selected && !selected.admitted && !receiverInvitationCurrent(selected.invitation, Date.now())) { stop(); setMessage('Invitation expired. Create a fresh invitation.'); return; }
    if (!selected || !displayed || !selected.auth.confirmEnrollment(displayed)) { setMessage('The comparison expired. Create a fresh invitation.'); return; }
    selected.confirmed = true; setSnapshot(previous => ({ ...previous, confirmed: true }));
    setMessage('Confirmed here. Waiting for the other screen to confirm.');
  };
  const select = () => {
    const surface = sessionRef.current?.surface;
    if (!surface?.select()) { setMessage('Pointer could not be allowed. Start a fresh connection.'); return; }
    setMessage('Pointer allowed for one minute.');
  };
  const driver = (): PointerSourceDriver | undefined => sessionRef.current?.provider?.driver();
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
    {role === 'receiver' ? <button className={styles.primary} onClick={select} disabled={!snapshot.described || !snapshot.clockReady || snapshot.active > 0 || snapshot.stopped}>Allow pointer for one minute</button> : null}
    <div ref={padRef} className={`${styles.pad} ${role === 'source' ? styles.source : ''}`} role={role === 'source' ? 'group' : 'img'}
      aria-label={role === 'source' ? 'Touch pad. Arrow keys move, Space presses, Escape releases.' : 'Application pointer surface'}
      tabIndex={role === 'source' ? 0 : undefined} data-contact={snapshot.contact} data-ready={snapshot.ready || snapshot.active === 2}
      onPointerDown={event => touch(event, 'begin')} onPointerMove={event => touch(event, 'move')}
      onPointerUp={event => touch(event, 'end')} onPointerCancel={event => touch(event, 'end')} onLostPointerCapture={event => touch(event, 'end')}
      onKeyDown={event => key(event, true)} onKeyUp={event => key(event, false)} onBlur={() => driver()?.release()}>
      {role === 'receiver' && snapshot.position ? <span ref={markerRef} className={styles.marker} data-testid='application-pointer'
        data-sequence={snapshot.capture?.sequence} data-capture-earliest={snapshot.capture?.earliest} data-capture-latest={snapshot.capture?.latest}
        data-received-at={snapshot.capture?.receivedAt} data-uncertainty-ms={snapshot.capture?.uncertaintyMs} style={{ left: snapshot.position.x, top: snapshot.position.y }} /> :
        <span className={styles.padLabel}>{role === 'source' ? (snapshot.ready ? 'Move anywhere on the pad' : 'Connect and allow pointer to begin') : 'Your pointer will appear here'}</span>}
    </div>
    {role === 'source' ? <div className={styles.controls} aria-label='Pointer controls'>
      <button onClick={() => driver()?.nudge(-0.02, 0)} disabled={!snapshot.ready}>Left</button><button onClick={() => driver()?.nudge(0, -0.02)} disabled={!snapshot.ready}>Up</button>
      <button onClick={() => driver()?.nudge(0, 0.02)} disabled={!snapshot.ready}>Down</button><button onClick={() => driver()?.nudge(0.02, 0)} disabled={!snapshot.ready}>Right</button>
      <button aria-pressed={snapshot.contact} onClick={() => { const input = driver(); input?.setContact(!input.state().contact); }} disabled={!snapshot.ready}>Press / release</button>
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
