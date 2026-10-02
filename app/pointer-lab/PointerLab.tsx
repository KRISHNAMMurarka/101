'use client';
import { PeerDataTransport, PointerResourceProvider, decodeManualPeerCode, encodeManualPeerCode } from '@101/connect';
import type { PointerSourceDriver, Observation } from '@101/connect';
import { createRemotePointerSurface } from '@/examples/device-pipelines/remote-pointer';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import styles from './pointer-lab.module.css';

type Surface = ReturnType<typeof createRemotePointerSurface>;
type Capture = { sequence: number; earliest: number; latest: number; receivedAt: number; uncertaintyMs: number };
type Session = { peer: PeerDataTransport; epoch: string; provider?: PointerResourceProvider; surface?: Surface; capture?: () => Capture | undefined; dispose: () => void };
type Snapshot = { position?: { x: number; y: number }; capture?: Capture; contact: boolean; described: boolean; active: number; clockReady: boolean; ready: boolean; stopped: boolean };
const EMPTY: Snapshot = { contact: false, described: false, active: 0, clockReady: false, ready: false, stopped: false };
const directions: Record<string, [number, number]> = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] };
const newEpoch = () => [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');

export default function PointerLab() {
  const [role, setRole] = useState<'receiver' | 'source'>('receiver');
  const [message, setMessage] = useState('Paste the offer from your phone or another source.');
  const [localCode, setLocalCode] = useState('');
  const [remoteCode, setRemoteCode] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const sessionRef = useRef<Session | null>(null);
  const generation = useRef(0);
  const padRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const receiverSize = useRef({ width: 1, height: 1 });

  const stop = useCallback((update = true) => {
    generation.current++;
    const session = sessionRef.current; sessionRef.current = null;
    session?.dispose();
    if (update) { setSnapshot({ ...EMPTY, stopped: true }); setLocalCode(''); setMessage('Stopped. Start a fresh connection to continue.'); }
  }, []);
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

  const install = (peer: PeerDataTransport, epoch: string, provider?: PointerResourceProvider, surface?: Surface, capture?: () => Capture | undefined): Session => {
    const update = () => {
      if (sessionRef.current?.peer !== peer) return;
      const receiver = surface?.receiver.status(), source = provider?.status(), input = provider?.driver()?.state();
      const next: Snapshot = { ...EMPTY, ...(surface?.state() ?? {}), ...(input ? { contact: input.contact } : {}), ...(surface?.state().position ? { capture: capture?.() } : {}),
        described: !!surface?.receiver.description(), active: receiver?.active ?? 0, clockReady: receiver?.clockReady ?? false,
        ready: source?.ready ?? false, stopped: (receiver?.stopped ?? source?.stopped ?? false) || !!receiver && ['expired', 'overload', 'unavailable', 'incompatible'].includes(receiver.reason) };
      setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (next.stopped) { stop(); setMessage('Connection stopped. Start a fresh connection to continue.'); }
      else if (source?.ready) setMessage('Move on the pad. Arrows move; hold Space to press.');
      else if (receiver?.active === 2) setMessage('Pointer allowed for one minute. Stop releases it immediately.');
    };
    const detach = peer.onStateChange(state => {
      if (sessionRef.current?.peer !== peer) return;
      if (state === 'failed' || state === 'disconnected') { setMessage('Connection lost. Start a fresh connection.'); update(); }
      else if (state === 'connected') setMessage(provider ? 'Connected. Allow pointer on the receiving screen.' : 'Connected. Choose Allow pointer to use this source.');
    });
    const timer = window.setInterval(() => { provider?.tick(); surface?.tick(); update(); }, 10);
    const session: Session = { peer, epoch, provider, surface, capture, dispose() {
      clearInterval(timer); detach(); provider?.stop(); surface?.stop(); void peer.disconnect();
    } };
    sessionRef.current = session; return session;
  };
  const createOffer = async () => {
    stop(false); setSnapshot(EMPTY); setLocalCode(''); setMessage('Preparing a local offer…');
    const id = generation.current, epoch = newEpoch(), peer = new PeerDataTransport({ initiator: true });
    const provider = new PointerResourceProvider({ authentication: 'local-diagnostic', peer, epoch, clockId: `browser-source:${epoch}`, now: () => performance.now(),
      platform: 'browser-pointer-events', available: () => !document.hidden });
    install(peer, epoch, provider);
    try {
      const description = await peer.createOffer(); if (generation.current !== id) return;
      setLocalCode(encodeManualPeerCode(epoch, description)); setMessage('Copy the offer to the receiving screen, then paste its answer here.');
    } catch { if (generation.current === id) { stop(); setMessage('Could not prepare an offer. Check that WebRTC is available and try again.'); } }
  };
  const acceptOffer = async () => {
    stop(false); setSnapshot(EMPTY); setLocalCode('');
    const id = generation.current;
    try {
      const code = decodeManualPeerCode(remoteCode, 'offer');
      const peer = new PeerDataTransport({ initiator: false });
      let captured: Capture | undefined;
      const onObservation = (observation: Observation) => {
        if (observation.source.capabilityId !== 'position') return;
        const latest = observation.provenance?.captureLatest, uncertainty = observation.provenance?.uncertaintyMs;
        if (typeof latest === 'number' && typeof uncertainty === 'number') captured = { sequence: observation.sequence,
          earliest: observation.timestamp, latest, receivedAt: observation.receivedAt, uncertaintyMs: uncertainty };
      };
      const surface = createRemotePointerSurface({ authentication: 'local-diagnostic', peer, epoch: code.epoch, clockId: `browser-surface:${code.epoch}`, now: () => performance.now(),
        principalId: 'local-lab-owner', applicationId: 'independent-pointer-surface', sessionId: code.epoch, onObservation, ...receiverSize.current });
      install(peer, code.epoch, undefined, surface, () => captured); setMessage('Preparing a local answer…');
      const answer = await peer.acceptOffer(code.description); if (generation.current !== id) return;
      setLocalCode(encodeManualPeerCode(code.epoch, answer)); setMessage('Copy this answer to the source. Then choose Allow pointer.');
    } catch { if (generation.current === id) { stop(); setMessage('Could not use this offer. Paste the complete offer and try again.'); } }
  };
  const acceptAnswer = async () => {
    const session = sessionRef.current, id = generation.current;
    if (!session?.provider) return;
    try {
      const code = decodeManualPeerCode(remoteCode, 'answer', session.epoch);
      await session.peer.acceptAnswer(code.description); if (generation.current !== id) return;
      setMessage('Answer accepted. Allow pointer on the receiving screen.');
    } catch { if (generation.current === id) setMessage('Could not use this answer. Paste the complete answer for this connection.'); }
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
    stop(false); setRole(next); setSnapshot(EMPTY); setLocalCode(''); setRemoteCode('');
    setMessage(next === 'receiver' ? 'Paste the offer from your phone or another source.' : 'Create an offer, then connect it to a receiving screen.');
  };
  return <main className={styles.lab}>
    <header className={styles.header}><Link href='/studio'>101 Studio</Link><button onClick={() => stop()}>Stop</button></header>
    <div className={styles.title}><h1>Pointer lab</h1><p>A touch pad and an independent application surface.</p></div>
    <div className={styles.roles} aria-label='Choose this screen’s role'>
      <button aria-pressed={role === 'receiver'} onClick={() => choose('receiver')}>Receive pointer</button>
      <button aria-pressed={role === 'source'} onClick={() => choose('source')}>Send pointer</button>
    </div>
    <p role='status' aria-live='polite' className={styles.status}>{message}</p>
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
      <p>Use only with a source you control. Hand-transferred codes are a local diagnostic; they do not verify endpoint identity. Nothing is published.</p>
      {role === 'source' ? <button onClick={() => void createOffer()}>Create offer</button> : null}
      <label htmlFor='remote-pointer-code'>{role === 'receiver' ? 'Offer from source' : 'Answer from receiver'}</label>
      <textarea id='remote-pointer-code' value={remoteCode} onChange={event => setRemoteCode(event.target.value)} spellCheck={false} maxLength={65536} />
      <button onClick={() => void (role === 'receiver' ? acceptOffer() : acceptAnswer())}>{role === 'receiver' ? 'Use offer' : 'Use answer'}</button>
      {localCode ? <><label htmlFor='local-pointer-code'>{role === 'receiver' ? 'Answer to copy to source' : 'Offer to copy to receiver'}</label>
        <textarea id='local-pointer-code' value={localCode} readOnly spellCheck={false} /><button onClick={() => void navigator.clipboard.writeText(localCode).then(() => setMessage('Code copied.')).catch(() => setMessage('Select and copy the code from the field.'))}>Copy code</button></> : null}
    </details>
  </main>;
}
