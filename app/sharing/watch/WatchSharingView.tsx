'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createWatchSharingTask } from './watch-sharing-task.ts';
import type { WatchSharingSnapshot, WatchSharingTask } from './watch-sharing-task.ts';
import type { SharingPeerSnapshot } from '../sharing-peer.ts';
import styles from '../sharing.module.css';

const messages: Record<WatchSharingSnapshot['notice'], string> = {
  ready: 'Review connection codes before allowing a view.', invalid: 'That code cannot be used. Ask the other page for a fresh code.',
  unavailable: 'The connection is not ready. Stop this setup and try again.', busy: 'Preparing a connection. You can stop while it finishes.',
  limit: 'This setup has reached its limit. Stop it before starting again.', 'consent-needed': 'Sharing needs your separate approval.',
  requested: 'A view request is waiting for review.', approving: 'Checking the approved view. Nothing appears until it is ready.',
  active: 'Only separately approved pages can view your shared controls.', declined: 'The view request was declined. Other approved views keep sharing.',
  cancelled: 'The view request was cancelled. Other approved views keep sharing.', revoked: 'This view stopped. A new view needs fresh approval.',
  expired: 'The original approval ended. Review a new request to share again.', paused: 'View updates are paused. The original approval still ends on time.',
  stopped: 'Sharing stopped. New source and display approvals are needed.', closed: 'This setup stopped. Wait for it to close before starting again.',
};
const peerMessages: Record<SharingPeerSnapshot['phase'], string> = {
  idle: 'No connection is open.', review: 'Review the selected observer invitation before creating an offer.',
  working: 'Preparing the selected connection.', exchange: 'Transfer the connection code to the other page.',
  comparison: 'Compare the whole code on both pages. Each page must confirm.',
  connected: 'The connected page is verified. Viewing still needs approval.',
  stopped: 'The connection stopped. Start a new setup.', invalid: 'The code could not be used. Start a new setup with fresh codes.',
  unsupported: 'This browser cannot open this connection. Try another supported browser.',
};

export default function WatchSharingView() {
  const task = useRef<WatchSharingTask | undefined>(undefined), live = useRef(true), observed = useRef<WatchSharingSnapshot | undefined>(undefined);
  const negotiating = useRef(false), retiring = useRef(false), pointer = useRef<number | undefined>(undefined), keyHeld = useRef(false);
  const [snapshot, setSnapshot] = useState<WatchSharingSnapshot>(), [role, setRole] = useState<'owner' | 'observer'>('owner');
  const [codes, setCodes] = useState<Record<string, string>>({}), [sourceConsent, setSourceConsent] = useState(false), [displayConsent, setDisplayConsent] = useState(false);
  const [settling, setSettling] = useState(false), [stopping, setStopping] = useState(false), [focusTarget, setFocusTarget] = useState('watch-status');
  const status = useRef<HTMLParagraphElement>(null), pad = useRef<HTMLButtonElement>(null);

  function releaseHeld(owned = task.current) {
    const id = pointer.current; pointer.current = undefined; keyHeld.current = false; owned?.releaseInput();
    if (id !== undefined && pad.current?.hasPointerCapture(id)) pad.current.releasePointerCapture(id);
  }
  function refresh(owned: WatchSharingTask) {
    if (!live.current || task.current !== owned) return;
    const next = owned.snapshot(), previous = observed.current; observed.current = next;
    if (previous?.source.active && !next.source.active || previous && previous.source.generation !== next.source.generation) {
      setSourceConsent(false); pointer.current = undefined; keyHeld.current = false;
    }
    if (previous?.view.request !== undefined && next.view.request === undefined) setDisplayConsent(false);
    if (next.closed) { setSourceConsent(false); setDisplayConsent(false); }
    const request = next.peers.find(peer => peer.request !== undefined && peer.request !== previous?.peers.find(old => old.id === peer.id)?.request);
    if (request && next.role === 'owner') setFocusTarget(`watch-review-${request.id}`);
    setSnapshot(next);
  }
  function run(action: (owned: WatchSharingTask) => unknown, focus: string | null = 'watch-status') {
    const owned = task.current; if (!owned || retiring.current) return; action(owned); refresh(owned); if (focus) setFocusTarget(focus);
  }
  async function work(action: (owned: WatchSharingTask) => Promise<unknown>) {
    const owned = task.current; if (!owned || negotiating.current || retiring.current) return;
    negotiating.current = true; setSettling(true);
    try { await action(owned); } finally {
      negotiating.current = false;
      if (live.current && task.current === owned) { refresh(owned); setSettling(false); if (!retiring.current) setFocusTarget('watch-status'); }
    }
  }
  function start() {
    if (negotiating.current || retiring.current || task.current && (!task.current.snapshot().closed || task.current.snapshot().rawPending)) return;
    const owned = createWatchSharingTask({ role, now: () => performance.now(), wallNow: () => Date.now(), onChange: () => refresh(owned) });
    task.current = owned; observed.current = undefined; setCodes({}); setSourceConsent(false); setDisplayConsent(false);
    refresh(owned); setFocusTarget('watch-status');
  }
  async function stop() {
    const owned = task.current; if (!owned || retiring.current) return;
    retiring.current = true; setStopping(true); releaseHeld(owned); setSourceConsent(false); setDisplayConsent(false); setFocusTarget('watch-status');
    // Stop is usable during negotiation. Await the exact task's returned work;
    // a late result cannot enable a different setup.
    try { await owned.close(); } finally {
      retiring.current = false;
      if (live.current && task.current === owned) { refresh(owned); setStopping(false); setCodes({}); setFocusTarget('watch-status'); }
    }
  }
  useLayoutEffect(() => {
    const target = document.getElementById(focusTarget);
    if (target instanceof HTMLElement && !('disabled' in target && target.disabled)) target.focus(); else status.current?.focus();
  }, [focusTarget]);
  useEffect(() => {
    live.current = true; let frame = 0, stopped = false;
    const tick = () => { if (stopped) return; const owned = task.current; owned?.tick(); if (owned) refresh(owned); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const blur = () => { if (keyHeld.current || pointer.current !== undefined) releaseHeld(); const owned = task.current; if (owned) refresh(owned); };
    const hide = () => { if (document.hidden) { releaseHeld(); const owned = task.current; owned?.interrupt(); if (owned) refresh(owned);
      setSourceConsent(false); setDisplayConsent(false); setFocusTarget('watch-status'); } };
    const leave = () => { releaseHeld(); task.current?.interrupt(); };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', leave);
    return () => { live.current = false; stopped = true; cancelAnimationFrame(frame); window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave); releaseHeld(); void task.current?.close(); };
  }, []);

  const running = !!snapshot && !snapshot.closed, owner = snapshot?.role === 'owner', source = snapshot?.source, view = snapshot?.view;
  const canMove = running && !!source?.active && !source.paused;
  return <main className={styles.page} data-watch-sharing-page>
    <header className={styles.header}>
      <p className={styles.eyebrow}>Sharing</p><h1>Share a read-only page view</h1>
      <p>Let up to two connected browser pages view the movement and presses you make in this page’s play area.</p>
      <p className={styles.note}>Compare both pages’ codes, then review source and display approvals separately. A connected page is not a verified person’s account. Observers cannot send controls back.</p>
      <p className={styles.note}>This shares only these page controls. Keep the pages visible. It does not share your screen or control another application.</p>
      <Link href="/sharing">Back to Sharing</Link>
    </header>
    <p ref={status} id="watch-status" role="status" tabIndex={-1} className={styles.status}>{snapshot ? messages[snapshot.notice] : 'Nothing is shared. Choose your page’s role before starting.'}</p>
    {!running ? <section className={styles.panel} aria-labelledby="watch-role-title">
      <h2 id="watch-role-title">Choose your page</h2>
      <label className={styles.duration}>Page role<select value={role} disabled={settling || stopping || !!snapshot?.rawPending} onChange={event => setRole(event.target.value as 'owner' | 'observer')}>
        <option value="owner">Share my page controls</option><option value="observer">Display a read-only view</option>
      </select></label>
      <button disabled={settling || stopping || !!snapshot?.rawPending || !!snapshot?.cleanupFailed} onClick={start}>Start watch setup</button>
      {settling || stopping || snapshot?.rawPending ? <p>Waiting for the previous setup to close.</p> : null}
      {snapshot?.cleanupFailed ? <p>This setup could not close safely. Leave this page before starting again.</p> : null}
    </section> : <>
      <section className={styles.panel} aria-labelledby="watch-connection-title">
        <h2 id="watch-connection-title">Connect and compare</h2>
        <p>The observer creates an invitation. The owner reviews it and returns an offer. The observer returns an answer. Compare the entire code and confirm on both pages within 30 seconds.</p>
        {owner ? <>
          <label className={styles.duration}>Observer invitation<textarea maxLength={65536} value={codes.invitation ?? ''} onChange={event => setCodes({ ...codes, invitation: event.target.value })} /></label>
          <button disabled={settling || stopping || snapshot.peers.length >= 2 || snapshot.remainingAttempts === 0} onClick={() => run(owned => owned.review(codes.invitation ?? ''))}>Review observer invitation</button>
        </> : !snapshot.peers.length ? <button disabled={settling || stopping || snapshot.remainingAttempts === 0} onClick={() => void work(owned => owned.invite())}>Create observer invitation</button> : null}
        {snapshot.peers.map(peer => <section className={styles.pending} key={peer.id} data-testid={`watch-peer-${peer.id}`} aria-labelledby={`watch-peer-title-${peer.id}`}>
          <h3 id={`watch-peer-title-${peer.id}`}>{peer.label}</h3><p role="status">{peerMessages[peer.connection.phase]}</p>
          {peer.connection.code ? <label className={styles.duration}><span id={`watch-code-out-${peer.id}`}>Code for the other page</span><textarea readOnly aria-labelledby={`watch-peer-title-${peer.id} watch-code-out-${peer.id}`} value={peer.connection.code} /></label> : null}
          {owner && peer.connection.phase === 'review' ? <button disabled={settling || stopping} onClick={() => void work(owned => owned.offer(peer.id))}>Create connection offer</button> : null}
          {peer.connection.phase === 'exchange' ? <>
            <label className={styles.duration}><span id={`watch-code-in-${peer.id}`}>{owner ? 'Observer answer' : 'Owner offer'}</span><textarea maxLength={65536} aria-labelledby={`watch-peer-title-${peer.id} watch-code-in-${peer.id}`} value={codes[peer.id] ?? ''} onChange={event => setCodes({ ...codes, [peer.id]: event.target.value })} /></label>
            <button disabled={settling || stopping || !codes[peer.id]} onClick={() => void work(owned => owned.accept(peer.id, codes[peer.id] ?? ''))}>{owner ? 'Accept observer answer' : 'Accept owner offer'}</button>
          </> : null}
          {peer.connection.comparison && !peer.connection.confirmed ? <>
            <p>Compare this entire code with the other page:</p><output className={styles.comparison} data-testid={`watch-comparison-${peer.id}`}>{peer.connection.comparison}</output>
            <button disabled={settling || stopping} onClick={() => run(owned => owned.confirm(peer.id))}>The codes match</button>
          </> : peer.connection.comparison ? <output className={styles.comparison} data-testid={`watch-comparison-${peer.id}`}>{peer.connection.comparison}</output> : null}
        </section>)}
      </section>
      {owner ? <>
        <section className={styles.panel} aria-labelledby="watch-source-title">
          <h2 id="watch-source-title">Your page controls</h2>
          <p>Approve sharing for up to 30 seconds from this original approval. Every observer also needs separate approval. Pausing cannot extend or restart this permission.</p>
          <label className={styles.check}><input type="checkbox" checked={sourceConsent} disabled={source?.active} onChange={event => setSourceConsent(event.target.checked)} />Allow sharing my page controls</label>
          <div className={styles.actions}>
            <button disabled={!sourceConsent || source?.active || settling || stopping || snapshot.remainingAttempts === 0} onClick={() => run(owned => owned.startSource(sourceConsent))}>Start my page controls</button>
            <button disabled={!source?.active || stopping} onClick={() => { releaseHeld(); run(owned => owned.interrupt()); setSourceConsent(false); }}>Stop my page controls</button>
            <button disabled={!canMove} onClick={() => { releaseHeld(); run(owned => owned.pauseUpdates()); }}>Pause view updates</button>
          </div>
          <button ref={pad} type="button" className={styles.pad} aria-label="Your shared movement pad" disabled={!canMove} aria-disabled={!canMove} aria-pressed={source?.held ?? false}
            onPointerDown={event => {
              if (!canMove || pointer.current !== undefined) return; pointer.current = event.pointerId;
              const element = event.currentTarget; element.focus(); element.setPointerCapture(event.pointerId); run(owned => owned.input('press'), null);
            }} onPointerMove={event => {
              if (pointer.current !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const movement = event.movementX, vertical = event.movementY;
              if (Math.abs(movement) >= Math.abs(vertical)) { if (movement) run(owned => owned.input(movement > 0 ? 'right' : 'left'), null); }
              else if (vertical) run(owned => owned.input(vertical > 0 ? 'down' : 'up'), null);
            }} onPointerUp={event => { if (pointer.current === event.pointerId) { pointer.current = undefined;
              if (!keyHeld.current) run(owned => owned.input('release'), null);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
            onPointerCancel={event => { if (pointer.current === event.pointerId) releaseHeld(); }}
            onLostPointerCapture={event => { if (pointer.current === event.pointerId) { pointer.current = undefined; if (!keyHeld.current) run(owned => owned.releaseInput(), null); } }}
            onBlur={() => { const keyboardPress = keyHeld.current; keyHeld.current = false;
              if (keyboardPress && pointer.current === undefined) run(owned => owned.releaseInput(), null); }}
            onKeyDown={event => {
              const action = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'press', Enter: 'press' } as const)[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | ' ' | 'Enter'];
              if (action) { event.preventDefault(); if (action === 'press') keyHeld.current = true; run(owned => owned.input(action), null); }
            }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); keyHeld.current = false;
              if (pointer.current === undefined) run(owned => owned.input('release'), null); } }}>
            Drag to move and hold a press, or use arrow keys and Space. Equivalent buttons are below.
          </button>
          <div className={styles.actions}>{(['left', 'right', 'up', 'down', 'press', 'release'] as const).map(action =>
            <button key={action} disabled={!canMove} onClick={() => run(owned => owned.input(action), null)}>{action === 'press' ? 'Press' : action === 'release' ? 'Release' : `Move ${action}`}</button>)}</div>
          <div className={styles.surface} data-testid="watch-source" data-x={source?.value?.x} data-y={source?.value?.y}
            data-held={String(source?.value?.pressed ?? false)} data-generation={source?.generation} data-emitted-at={source?.value?.emittedAt}
            data-emissions={source?.emissions ?? 0} data-expires-at={source?.expiresAt} data-active={String(source?.active ?? false)} role="img" aria-label={`Your page controls. ${source?.held ? 'Press held.' : 'No press held.'}`}>
            {source?.value ? <span className={styles.marker} data-held={String(source.value.pressed)} style={{ left: `${source.value.x * 100}%`, top: `${source.value.y * 100}%` }} /> : <span>Not shared</span>}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="watch-approvals-title"><h2 id="watch-approvals-title">Review each observer</h2>
          <p>A request alone cannot display anything. Approving one observer does not approve another.</p>
          {snapshot.peers.filter(peer => peer.request !== undefined).map(peer => <section className={styles.review} id={`watch-review-${peer.id}`} tabIndex={-1} data-testid={`watch-review-${peer.id}`} key={peer.id} aria-labelledby={`watch-review-title-${peer.id}`}>
            <h3 id={`watch-review-title-${peer.id}`}>{peer.label} requests a read-only view</h3>
            <p>Allow only this connected page to display your position and presses until the original source approval ends. Other approved views keep sharing.</p>
            <div className={styles.actions}><button disabled={!source?.active || source.paused || stopping} onClick={() => run(owned => owned.approveDisplay(peer.id, true))}>Allow {peer.label} to view</button>
              <button disabled={stopping} onClick={() => run(owned => owned.declineDisplay(peer.id))}>Decline view request</button></div>
          </section>)}
          {!snapshot.peers.some(peer => peer.request !== undefined) ? <p>No view requests are waiting.</p> : null}
          {snapshot.peers.filter(peer => peer.active).map(peer => <div className={styles.pending} key={peer.id}><p>{peer.label} can view the approved page controls.</p>
            <button onClick={() => run(owned => owned.revokeDisplay(peer.id))}>Stop {peer.label} viewing</button></div>)}
        </section>
      </> : <section className={styles.panel} aria-labelledby="watch-display-approval-title">
        <h2 id="watch-display-approval-title">Your display approval</h2>
        <p>This page can only view. It cannot send movement or presses back. The owner must approve this exact request separately.</p>
        <label className={styles.check}><input type="checkbox" checked={displayConsent} disabled={view?.request !== undefined} onChange={event => setDisplayConsent(event.target.checked)} />Allow this page to display the shared view</label>
        <div className={styles.actions}>
          <button disabled={!displayConsent || view?.request !== undefined || !snapshot.peers[0]?.ready || settling || stopping || snapshot.remainingRequests === 0} onClick={() => run(owned => owned.requestDisplay(displayConsent))}>Request a read-only view</button>
          {view?.request !== undefined ? <button onClick={() => { run(owned => owned.cancelDisplay()); setDisplayConsent(false); }}>Cancel my view request</button> : null}
        </div>
        {!snapshot.peers[0]?.ready ? <p>Wait for verified page controls, then review a fresh display request.</p> : null}
      </section>}
      <div className={styles.actions}><button disabled={stopping} onClick={() => void stop()}>Stop watch setup</button></div>
    </>}
    <section className={styles.panel} aria-labelledby="watch-view-title"><h2 id="watch-view-title">Read-only view</h2>
      <div tabIndex={-1} className={styles.surface} data-testid="watch-display" data-x={view?.value?.x} data-y={view?.value?.y}
        data-held={String(view?.value?.pressed ?? false)} data-generation={view?.value?.generation} data-emitted-at={view?.value?.emittedAt}
        data-endpoint={view?.sourceStamp?.endpointId} data-received-at={view?.receivedAt} role="img"
        aria-label={view?.value ? `Read-only shared position. ${view.value.pressed ? 'Press held.' : 'No press held.'}` : 'Read-only view. Nothing is shared.'}>
        {view?.value ? <span className={styles.marker} data-held={String(view.value.pressed)} style={{ left: `${view.value.x * 100}%`, top: `${view.value.y * 100}%` }} /> : <span>Nothing is shared</span>}
        <span className={styles.outputText}>{view?.value?.pressed ? 'Press held' : 'No press held'}</span>
      </div>
    </section>
    <span data-testid="watch-raw" data-pending={snapshot?.rawPending ?? 0} hidden />
  </main>;
}
