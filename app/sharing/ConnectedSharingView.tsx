'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createConnectedSharingTask } from './connected-sharing-task';
import type { ConnectedSharingSnapshot, ConnectedSharingTask } from './connected-sharing-task';
import styles from './sharing.module.css';

const area = (id: string) => id === 'exclusive' ? 'Whole play area' : id === 'left' ? 'Left side' : 'Right side';
const messages = { 'participant-removing': 'Removing the selected connection. Other approved sharing continues.', 'participant-removed': 'Participant removed. Create a replacement invitation when you are ready.', 'participant-replacing': 'Connect the replacement page and compare its codes. Controls need fresh approval.', ready: 'Nothing is shared. Complete setup, then review a request.', invalid: 'Use a complete code from the matching setup. Stop this setup to try again.',
  unavailable: 'Sharing could not continue. Stop this setup and connect again.', busy: 'Wait for the current step to finish.', limit: 'This setup reached its limit. Stop it and start again.',
  'consent-needed': 'Allow your page controls before making a request.', requested: 'A request is waiting. Current sharing continues until a transfer is approved.',
  approving: 'Checking the selected controls. Input stays off until sharing is ready.', active: 'Sharing is active for the approved play area.', declined: 'The request was declined. Current sharing was kept.',
  cancelled: 'The request was cancelled. Current sharing was kept.', revoked: 'The selected sharing stopped. Held presses were released.', expired: 'Sharing expired. Make a new request to continue.',
  'review-changed': 'Sharing changed since this review. Review the current sharing again.', 'policy-changed': 'The play area changed. Everyone needs a new request and approval.',
  stopped: 'Sharing stopped. Held presses were released. New requests need approval.', closed: 'This setup is closed. Start again when ready.' };
const peerMessages = { idle: 'Not connected.', review: 'Review the invitation before creating an offer.', working: 'Preparing the connection. Input is off.', exchange: 'Exchange the matching codes. Input is off.',
  comparison: 'Compare the code with the other page. Each page must confirm.', connected: 'The connected page is verified. Connecting does not share controls.',
  stopped: 'The connection stopped. Start a new setup.', invalid: 'The code could not be used. Start a new setup.', unsupported: 'This browser cannot make this connection. Use the local setup or try another supported browser.' };

export default function ConnectedSharingView({ onBack }: { onBack: () => void }) {
  const task = useRef<ConnectedSharingTask | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<ConnectedSharingSnapshot>();
  const [role, setRole] = useState<'owner' | 'participant'>('owner');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [duration, setDuration] = useState<30 | 60>(30), [slot, setSlot] = useState('left'), [consent, setConsent] = useState(false);
  const [focusTarget, setFocusTarget] = useState('connected-sharing-status');
  const [settling, setSettling] = useState(false), [stopping, setStopping] = useState(false);
  const negotiating = useRef(false), retiring = useRef(false), observed = useRef<ConnectedSharingSnapshot | undefined>(undefined);
  const status = useRef<HTMLParagraphElement>(null), live = useRef(true);
  function refresh(owned: ConnectedSharingTask) {
    if (!live.current || task.current !== owned) return;
    const next = owned.snapshot(), previous = observed.current; observed.current = next;
    if (!previous || previous.policy !== next.policy || previous.revision !== next.revision) {
      setSlot(next.policy === 'exclusive' ? 'exclusive' : 'left'); setConsent(false);
    } else if (previous.participant.request !== undefined && next.participant.request === undefined) setConsent(false);
    const signature = next.slots.map(value => value.request?.id ?? '').join('|');
    if (signature && signature !== previous?.slots.map(value => value.request?.id ?? '').join('|') && next.role === 'owner') setFocusTarget('connected-sharing-review');
    setSnapshot(next);
  }
  function run(action: (owned: ConnectedSharingTask) => unknown, focus: string | null = 'connected-sharing-status') {
    const owned = task.current; if (!owned) return; action(owned); refresh(owned); if (focus) setFocusTarget(focus);
  }
  async function work(action: (owned: ConnectedSharingTask) => Promise<unknown>) {
    const owned = task.current; if (!owned || negotiating.current || retiring.current) return;
    negotiating.current = true; setSettling(true);
    try { await action(owned); } finally { negotiating.current = false;
      if (live.current && task.current === owned) { refresh(owned); setSettling(false); if (!retiring.current) setFocusTarget('connected-sharing-status'); }
    }
  }
  function start() {
    if (negotiating.current || retiring.current || task.current && (!task.current.snapshot().closed || task.current.snapshot().rawPending)) return;
    const owned = createConnectedSharingTask({ role, now: () => performance.now(), wallNow: () => Date.now(), onChange: () => refresh(owned) });
    task.current = owned; observed.current = undefined; refresh(owned); setCodes({}); setConsent(false); setFocusTarget('connected-sharing-status');
  }
  async function stop(back = false) {
    const owned = task.current; if (!owned || retiring.current) return;
    retiring.current = true; setStopping(true); setConsent(false); setFocusTarget('connected-sharing-status');
    try { await owned.close(); } finally {
      retiring.current = false;
      if (live.current && task.current === owned) { refresh(owned); setStopping(false); setCodes({}); setFocusTarget('connected-sharing-status'); if (back) onBack(); }
    }
  }
  useLayoutEffect(() => {
    const target = document.getElementById(focusTarget);
    if (target instanceof HTMLElement && !('disabled' in target && target.disabled)) target.focus(); else status.current?.focus();
  }, [focusTarget, snapshot?.preview]);
  useEffect(() => {
    live.current = true; let frame = 0, stopped = false;
    function connectedSharingTick() { if (stopped) return; const owned = task.current; owned?.tick(); if (owned) refresh(owned); frame = requestAnimationFrame(connectedSharingTick); }
    frame = requestAnimationFrame(connectedSharingTick);
    const hide = () => { if (document.hidden) { const owned = task.current; owned?.interrupt(); if (owned) refresh(owned); setConsent(false); } };
    document.addEventListener('visibilitychange', hide);
    return () => { live.current = false; stopped = true; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', hide); void task.current?.close(); };
  }, []);
  const running = !!snapshot && !snapshot.closed, owner = snapshot?.role === 'owner';
  const label = (id: string) => snapshot?.peers.find(peer => peer.id === id)?.label ?? 'Selected participant';
  return <main className={styles.page}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>Sharing</p><h1>Connect participants</h1>
      <p>Connect another browser page, compare the codes, and review each request to move and press inside this play area.</p>
      <p className={styles.note}>This confirms the connected page, not a person’s account. It never moves the system pointer or controls another application. Keep both pages visible while sharing.</p>
      <button disabled={stopping} onClick={() => { if (running) void stop(true); else if (!negotiating.current && !snapshot?.rawPending) onBack(); }}>Back to local sharing</button>
    </header>
    <p id="connected-sharing-status" ref={status} role="status" tabIndex={-1} className={styles.status}>{snapshot ? messages[snapshot.notice] : 'Nothing is shared. Choose a role before starting.'}</p>
    {!running ? <section className={styles.panel} aria-labelledby="connected-role-title">
      <h2 id="connected-role-title">Choose your page</h2>
      <label className={styles.duration}>Page role<select value={role} disabled={settling || stopping} onChange={event => setRole(event.target.value as 'owner' | 'participant')}>
        <option value="owner">Own the shared play area</option><option value="participant">Supply my page controls</option>
      </select></label>
      <button disabled={settling || stopping || !!snapshot?.rawPending} onClick={start}>Start connected setup</button>
      {settling || stopping || snapshot?.rawPending ? <p>Waiting for the previous setup to close.</p> : null}
    </section> : <>
      <section className={styles.panel} aria-labelledby="connected-setup-title">
        <h2 id="connected-setup-title">Connect and compare</h2>
        <p>Transfer only these setup codes between the pages. Complete connection and comparison within 30 seconds. Each page must confirm before requesting controls.</p>
        {owner ? <div className={styles.actions}>
          <button disabled={settling || snapshot.rosterFinished || snapshot.peers.length >= 2 || snapshot.remainingAttempts === 0} onClick={() => void work(owned => owned.invite())}>Create participant invitation</button>
          <button disabled={settling || snapshot.rosterFinished || !snapshot.peers.length || snapshot.peers.some(peer => peer.connection.phase !== 'connected')} onClick={() => run(owned => owned.finishRoster())}>Finish participant setup</button>
        </div> : !snapshot.peers.length ? <>
          <label className={styles.duration}>Owner invitation<textarea maxLength={65536} value={codes.invitation ?? ''} onChange={event => setCodes({ ...codes, invitation: event.target.value })} /></label>
          <button onClick={() => run(owned => owned.review(codes.invitation ?? ''))}>Review invitation</button>
        </> : null}
        {snapshot.peers.map(peer => <section className={styles.pending} key={peer.id} data-testid={`connected-peer-${peer.id}`} aria-labelledby={`connected-peer-title-${peer.id}`}>
          <h3 id={`connected-peer-title-${peer.id}`}>{owner ? peer.label : 'Connected owner page'}</h3>
          <p role="status">{peer.membership === 'retiring' ? 'Removing this connection. Wait for it to close.' : peer.membership === 'removed' ? 'This participant is removed. Its controls are off.' : peerMessages[peer.connection.phase]}</p>
          {owner && snapshot.rosterFinished && peer.membership === 'live' ? <button disabled={settling || stopping} onClick={() => run(owned => owned.previewRemoveParticipant(peer.id), 'connected-sharing-confirm')}>Remove {peer.label}</button> : null}
          {owner && peer.membership === 'removed' ? <button disabled={settling || stopping || snapshot.rawPending > 0 || snapshot.remainingAttempts === 0} onClick={() => { setCodes(previous => ({ ...previous, [peer.id]: '' })); void work(owned => owned.inviteReplacement(peer.id)); }}>Create replacement invitation for {peer.label}</button> : null}
          {peer.connection.code ? <label className={styles.duration}><span id={`connected-code-out-${peer.id}`}>{owner ? 'Code for the participant' : 'Code for the owner'}</span><textarea readOnly value={peer.connection.code} aria-labelledby={`connected-peer-title-${peer.id} connected-code-out-${peer.id}`} /></label> : null}
          {!owner && peer.connection.phase === 'review' ? <button disabled={settling} onClick={() => void work(owned => owned.offer())}>Create connection offer</button> : null}
          {peer.connection.phase === 'exchange' ? <>
            <label className={styles.duration}><span id={`connected-code-in-${peer.id}`}>{owner ? 'Participant offer' : 'Owner answer'}</span><textarea maxLength={65536} aria-labelledby={`connected-peer-title-${peer.id} connected-code-in-${peer.id}`} value={codes[peer.id] ?? ''} onChange={event => setCodes({ ...codes, [peer.id]: event.target.value })} /></label>
            <button disabled={settling || !(codes[peer.id]?.length)} onClick={() => void work(owned => owned.accept(peer.id, codes[peer.id] ?? ''))}>{owner ? 'Accept participant offer' : 'Accept owner answer'}</button>
          </> : null}
          {peer.connection.comparison ? <>
            <p>Compare this entire code with the other page:</p><output data-testid={`connected-comparison-${peer.id}`} className={styles.comparison}>{peer.connection.comparison}</output>
            <button disabled={peer.connection.confirmed || settling} onClick={() => run(owned => owned.confirm(peer.id))}>The codes match</button>
          </> : null}
        </section>)}
      </section>
      {owner && snapshot.rosterFinished ? <>
        <section className={styles.panel} aria-labelledby="connected-policy-title"><h2 id="connected-policy-title">Shared play area</h2>
          <p>{snapshot.policy === 'partitioned' ? 'Left and right are separate. Each side needs its own approval.' : 'Only one participant can use the whole play area at a time.'}</p>
          <div className={styles.actions}><button disabled={snapshot.remainingPolicyChanges === 0} onClick={() => run(owned => owned.previewPolicy(snapshot.policy === 'partitioned' ? 'exclusive' : 'partitioned'), 'connected-sharing-confirm')}>{snapshot.policy === 'partitioned' ? 'Use one shared area' : 'Give each participant a side'}</button>
            <button onClick={() => run(owned => owned.interrupt())}>Stop all connected sharing</button></div>
        </section>
        <section id="connected-sharing-review" tabIndex={-1} aria-labelledby="connected-requests-title" className={styles.panel}>
          <h2 id="connected-requests-title">Review requests</h2>
          <p>Connection and a pending request do not allow movement or presses. Review the recipient, area and duration separately.</p>
          {snapshot.slots.filter(value => value.request).map(value => {
            const peer = snapshot.peers.find(peer => peer.id === value.request!.sourceId);
            return <section className={styles.pending} key={value.id} data-testid={`connected-review-${value.id}`}>
              <h3>{label(value.request!.sourceId)} requests {area(value.id).toLowerCase()}</h3>
              <p>Allow page position and presses inside {area(value.id).toLowerCase()} for {peer?.requestDuration} seconds. {value.owner ? `${label(value.owner.sourceId)} keeps sharing until the transfer is approved and ready.` : 'No participant currently shares this area.'}</p>
              <div className={styles.actions}>
                <button disabled={!peer?.ready || peer.approving} onClick={() => run(owned => owned.approve(value.id))}>Approve {label(value.request!.sourceId)} on {area(value.id).toLowerCase()}</button>
                <button disabled={peer?.approving} onClick={() => run(owned => owned.decline(value.id))}>Decline request</button>
                <button onClick={() => run(owned => owned.cancelReview(value.id))}>Cancel review</button>
              </div>{peer?.approving ? <p>Checking fresh controls. Current sharing stays in place until the new controls are ready.</p> : null}
            </section>;
          })}
          {!snapshot.slots.some(value => value.request) ? <p>No requests are waiting.</p> : null}
        </section>
        {snapshot.preview?.kind === 'remove' ? <section className={styles.review} aria-labelledby="connected-remove-title">
          <h2 id="connected-remove-title">Remove {label(snapshot.preview.participantId!)}?</h2>
          <p>This closes this participant’s connection and releases its held controls. Other participants keep their approved sharing.</p>
          <p>A replacement page needs a new invitation, matching codes and fresh approval from both pages. No permission is restored.</p>
          <div className={styles.actions}>{snapshot.notice === 'review-changed' ? <button id="connected-sharing-confirm" disabled={settling || stopping} onClick={() => run(owned => owned.previewRemoveParticipant(snapshot.preview!.participantId!), 'connected-sharing-confirm')}>Review participant again</button> : <button id="connected-sharing-confirm" disabled={settling || stopping} onClick={() => void work(owned => owned.confirmRemoval(snapshot.preview!))}>Confirm participant removal</button>}
            <button disabled={settling || stopping} onClick={() => run(owned => owned.cancelPreview())}>Keep participant</button></div>
        </section> : snapshot.preview ? <section className={styles.review} aria-labelledby="connected-preview-title">
          <h2 id="connected-preview-title">Review what will stop</h2>
          <p>Moving and pressing will stop for {snapshot.preview.recipients.length ? snapshot.preview.recipients.map(recipient => `${label(recipient.sourceId)} on ${area(recipient.slotId).toLowerCase()}`).join(' and ') : 'all participants; nothing is shared yet'}. Held presses will be released.</p>
          {snapshot.preview.kind === 'policy' ? <p>The new layout is {snapshot.preview.policy === 'exclusive' ? 'one whole play area' : 'separate left and right sides'}. Pending requests are cancelled. Everyone needs new consent and approval.</p> : <p>Other approved areas keep sharing.</p>}
          <div className={styles.actions}>{snapshot.notice === 'review-changed' ? <button id="connected-sharing-confirm" onClick={() => run(owned => {
            if (snapshot.preview?.kind === 'policy') owned.previewPolicy(snapshot.preview.policy!);
            else if (snapshot.preview?.recipients[0]) owned.previewRevoke(snapshot.preview.recipients[0].slotId);
          }, 'connected-sharing-confirm')}>Review current sharing</button> : <button id="connected-sharing-confirm" onClick={() => run(owned => snapshot.preview && owned.confirmPreview(snapshot.preview))}>Confirm stop sharing</button>}
            <button onClick={() => run(owned => owned.cancelPreview())}>Keep current sharing</button></div>
        </section> : null}
        <section aria-labelledby="connected-current-title"><h2 id="connected-current-title">Current sharing</h2><div className={styles.surfaces}>
          {snapshot.slots.map(value => <section className={styles.panel} key={value.id} data-testid={`connected-slot-${value.id}`}>
            <h3>{area(value.id)}</h3><p>Controls: <strong data-testid={`connected-owner-${value.id}`}>{value.owner ? label(value.owner.sourceId) : 'None'}</strong></p>
            <div className={styles.surface} role="img" aria-label={`${area(value.id)}. ${value.owner ? label(value.owner.sourceId) : 'No controls'}. ${value.held ? 'Press held' : 'No press held'}.`} data-testid={`connected-output-${value.id}`} data-held={String(value.held)} data-x={value.position?.x ?? ''} data-y={value.position?.y ?? ''}>
              {value.position ? <span className={styles.marker} data-held={String(value.held)} style={{ left: `${value.position.x * 100}%`, top: `${value.position.y * 100}%` }} /> : <span>Not shared</span>}
              <span className={styles.outputText}>{value.held ? 'Press held' : 'No press held'}</span>
            </div>
            {value.owner ? <><p>Position and presses are approved for {value.duration} seconds.</p><button onClick={() => run(owned => owned.previewRevoke(value.id), 'connected-sharing-confirm')}>Stop {label(value.owner.sourceId)} on {area(value.id).toLowerCase()}</button></> : null}
          </section>)}
        </div></section>
      </> : null}
      {!owner && snapshot.participant.layoutReady ? <section className={styles.panel} aria-labelledby="connected-source-title" data-testid="connected-participant-controls">
        <h2 id="connected-source-title">Your page controls</h2><p>Supply position and presses only inside the selected owner play area. This permission is separate from the owner’s approval.</p>
        <label className={styles.duration}>Requested area<select disabled={!!snapshot.participant.request} value={slot} onChange={event => setSlot(event.target.value)}>
          {snapshot.policy === 'partitioned' ? <><option value="left">Left side</option><option value="right">Right side</option></> : <option value="exclusive">Whole play area</option>}
        </select></label>
        <label className={styles.duration}>Sharing duration<select disabled={!!snapshot.participant.request} value={duration} onChange={event => setDuration(Number(event.target.value) as 30 | 60)}><option value={30}>30 seconds</option><option value={60}>60 seconds</option></select></label>
        <label className={styles.check}><input type="checkbox" disabled={!!snapshot.participant.request} checked={consent} onChange={event => setConsent(event.target.checked)} />Allow this page to supply position and presses for this request for {duration} seconds. The owner must approve separately.</label>
        <div className={styles.actions}><button disabled={!consent || !!snapshot.participant.request} onClick={() => run(owned => owned.request(slot, duration, consent))}>Request {area(slot).toLowerCase()}</button>
          {snapshot.participant.request ? <button onClick={() => { run(owned => owned.cancelRequest()); setConsent(false); }}>{snapshot.participant.active ? 'Stop my sharing' : 'Cancel my request'}</button> : null}</div>
        <button type="button" className={styles.pad} aria-label="Your connected movement pad" disabled={!snapshot.participant.active} aria-disabled={!snapshot.participant.active} aria-pressed={snapshot.participant.held}
          onClick={event => { if (event.detail === 0) run(owned => owned.input(snapshot.participant.held ? 'release' : 'press'), null); }}
          onPointerDown={event => {
            if (!snapshot.participant.active) return; const element = event.currentTarget, rect = element.getBoundingClientRect();
            element.focus(); element.setPointerCapture(event.pointerId);
            run(owned => owned.pointer('begin', event.pointerId, event.clientX, event.clientY, rect.width, rect.height), null);
          }} onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = event.currentTarget.getBoundingClientRect();
            run(owned => owned.pointer('move', event.pointerId, event.clientX, event.clientY, rect.width, rect.height), null);
          }} onPointerUp={event => {
            run(owned => owned.pointer('end', event.pointerId), null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => run(owned => owned.releaseInput(), null)} onLostPointerCapture={() => run(owned => owned.releaseInput(), null)}
          onBlur={() => run(owned => owned.releaseInput(), null)} onKeyDown={event => {
            const action = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'press', Enter: 'press' } as const)[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | ' ' | 'Enter'];
            if (action) { event.preventDefault(); run(owned => owned.input(action), null); }
          }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); run(owned => owned.input('release'), null); } }}>
          {snapshot.participant.active ? 'Drag to move and hold a press, or use arrow keys and Space. Equivalent controls are below.' : 'Input is off until the owner approves and sharing is ready.'}
        </button>
        <div className={styles.actions}>{(['left', 'right', 'up', 'down', 'press', 'release'] as const).map(action => <button key={action} disabled={!snapshot.participant.active} onClick={() => run(owned => owned.input(action), 'connected-sharing-pad-status')}>{action === 'press' ? 'Press' : action === 'release' ? 'Release' : `Move ${action}`}</button>)}</div>
        <p id="connected-sharing-pad-status" tabIndex={-1} role="status">{snapshot.participant.active ? snapshot.participant.held ? 'Your press is held.' : 'Your controls are active. No press is held.' : 'Your controls are off.'}</p>
      </section> : null}
      <button disabled={stopping} onClick={() => void stop()}>Stop connected setup</button>
    </>}
  </main>;
}
