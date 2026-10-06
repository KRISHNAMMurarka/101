'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSharingTask } from './sharing-task';
import type { SharingSnapshot, SharingTask } from './sharing-task';
import styles from './sharing.module.css';
import ConnectedSharingView from './ConnectedSharingView';

const slotLabel = (id: string) => id === 'exclusive' ? 'Whole play area' : id === 'left' ? 'Left side' : 'Right side';
const outcomes = {
  ready: 'Not shared. A control can request this area.', requested: 'A request is waiting. Current sharing continues until you approve a transfer.',
  declined: 'Request declined. Current sharing continues.', cancelled: 'Request cancelled. Current sharing continues.',
  'request-expired': 'Request expired. Ask again when ready.', transferred: 'Sharing is active for the approved controls only.',
  released: 'Sharing stopped. Ask again to continue.', 'route-lost': 'Sharing stopped because access expired or the controls became unavailable. Enable the controls if needed, then ask again.',
  'activation-failed': 'Sharing could not start. The previous controls were released. Ask again when the controls are available.', closed: 'Sharing is closed.',
};
const notices = { ready: '', 'consent-needed': 'Allow your controls before sending a request.', unavailable: 'These controls are unavailable. Enable them, then request sharing again.',
  'controls-in-use': 'These controls already share or request another area. Stop or cancel that sharing before requesting this one.',
  'review-changed': 'Sharing changed since this review. Review the current controls before trying again.', revoked: 'The selected sharing stopped. Held presses were released.',
  'policy-changed': 'The play area changed. Each control needs a new request and approval.', interrupted: 'Sharing stopped while this page was away. Make a new request to continue.',
  closed: 'Sharing is closed. Start a new setup to continue.', limit: 'This setup has reached its request limit. Stop it and start a new setup.' };

export default function SharingView() {
  const [connected, setConnected] = useState(false);
  const task = useRef<SharingTask | undefined>(undefined), status = useRef<HTMLParagraphElement>(null);
  const [snapshot, setSnapshot] = useState<SharingSnapshot>();
  const [choice, setChoice] = useState<Record<string, string>>({ first: 'left', second: 'right' });
  const [duration, setDuration] = useState<30 | 60>(30);
  const [allowed, setAllowed] = useState<Record<string, boolean>>({ first: false, second: false });
  const [focusTarget, setFocusTarget] = useState<{ id: string }>();
  function run(action: (owned: SharingTask) => void, focus?: string) { const owned = task.current; if (!owned) return; action(owned); setSnapshot(owned.snapshot()); if (focus) setFocusTarget({ id: focus }); }
  function start() {
    task.current?.close();
    const owned = createSharingTask({ now: () => performance.now(), onChange: () => { if (task.current === owned) setSnapshot(owned.snapshot()); } });
    task.current = owned; setSnapshot(owned.snapshot()); setAllowed({ first: false, second: false }); setChoice({ first: 'left', second: 'right' }); setFocusTarget({ id: 'sharing-status' });
  }
  const focusSignature = snapshot?.slots.map(slot => slot.request?.id ?? slot.owner?.epoch ?? slot.state).join('|');
  const running = !!snapshot && !snapshot.closed;
  useLayoutEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget.id);
    if (element instanceof HTMLElement && !('disabled' in element && element.disabled)) element.focus();
    else status.current?.focus();
  }, [focusTarget, snapshot?.preview, focusSignature]);
  useEffect(() => {
    if (!running) return;
    let stopped = false, frame = 0;
    function sharingTick() { if (stopped) return; task.current?.tick(); frame = requestAnimationFrame(sharingTick); }
    frame = requestAnimationFrame(sharingTick);
    const interrupt = () => { task.current?.interrupt(); setAllowed({ first: false, second: false }); };
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('blur', interrupt); document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; cancelAnimationFrame(frame); window.removeEventListener('blur', interrupt); document.removeEventListener('visibilitychange', visibility); };
  }, [running]);
  useEffect(() => () => { task.current?.close(); task.current = undefined; }, []);
  const label = (id: string) => snapshot?.recipients.find(recipient => recipient.id === id)?.label ?? 'Selected controls';
  const active = snapshot?.slots.filter(slot => slot.owner) ?? [];
  if (connected) return <ConnectedSharingView onBack={() => setConnected(false)} />;
  return <main className={styles.page}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>Sharing</p>
      <h1>Choose who can use your play area</h1>
      <p>Two controls on this page can move a marker and press inside the shared play area. Review each request, give each control its own side, or allow a transfer.</p>
      <p className={styles.note}>These are controls on this screen, not connected people or devices. Sharing never moves your system pointer or gives access to another application.</p>
      <a href="/devices">Back to Devices</a>
    </header>
    <p id="sharing-status" ref={status} className={styles.status} role="status" tabIndex={-1}>{snapshot ? notices[snapshot.notice] || `${active.length ? 'Sharing is active.' : 'Nothing is shared.'} Review requests below.` : 'Nothing is shared. Start a setup when you are ready.'}</p>
    {!snapshot || snapshot.closed ? <div className={styles.actions}><button onClick={start}>Start sharing setup</button><button onClick={() => setConnected(true)}>Connect participants</button></div> : <>
      <section className={styles.panel} aria-labelledby="sharing-policy-title">
        <h2 id="sharing-policy-title">Shared play area</h2>
        <p>{snapshot.policy === 'partitioned' ? 'Left and right are separate. Two controls can use them at the same time.' : 'One control can use the whole play area. Another request waits for your review.'}</p>
        <button disabled={snapshot.remainingPolicyChanges === 0} onClick={() => run(owned => { owned.previewPolicy(snapshot.policy === 'partitioned' ? 'exclusive' : 'partitioned'); }, 'sharing-confirm')}>{snapshot.policy === 'partitioned' ? 'Use one shared area' : 'Give each control its own side'}</button>
        <button onClick={() => run(owned => owned.interrupt(), 'sharing-status')}>Stop all sharing</button>
      </section>
      {snapshot.preview ? <section className={styles.review} aria-labelledby="sharing-preview-title">
        <h2 id="sharing-preview-title">{snapshot.preview.kind === 'policy' ? 'Review the play area change' : 'Review what will stop'}</h2>
        <p>Moving and pressing will stop for {snapshot.preview.recipients.length ? snapshot.preview.recipients.map(recipient => `${label(recipient.sourceId)} on ${slotLabel(recipient.slotId).toLowerCase()}`).join(' and ') : 'all controls; nothing is shared yet'}. Held presses will be released.</p>
        {snapshot.preview.kind === 'policy' ? <p>The new layout is {snapshot.preview.policy === 'exclusive' ? 'one whole play area for one control at a time' : 'separate left and right sides for distinct controls'}. Pending requests will be cancelled. New requests and approvals are needed for the new layout.</p> : <p>The other side keeps its approved sharing.</p>}
        {snapshot.notice === 'review-changed' ? <p role="alert">{notices['review-changed']}</p> : null}
        <div className={styles.actions}>
          {snapshot.notice === 'review-changed' ? <button id="sharing-confirm" onClick={() => run(owned => {
            if (snapshot.preview?.kind === 'policy') owned.previewPolicy(snapshot.preview.policy!);
            else if (snapshot.preview?.recipients[0]) owned.previewRevoke(snapshot.preview.recipients[0].slotId);
          }, 'sharing-confirm')}>Review current sharing</button> : <button id="sharing-confirm" onClick={() => run(owned => { if (snapshot.preview) owned.confirmPreview(snapshot.preview); }, 'sharing-status')}>{snapshot.preview.kind === 'policy' ? 'Stop sharing and change area' : 'Confirm stop sharing'}</button>}
          <button onClick={() => run(owned => owned.cancelPreview(), 'sharing-status')}>Keep current sharing</button>
        </div>
      </section> : null}
      <section aria-labelledby="sharing-active-title">
        <h2 id="sharing-active-title">Current sharing</h2>
        <div className={styles.surfaces}>
          {snapshot.slots.map(slot => <section key={slot.id} className={styles.panel} data-testid={`sharing-slot-${slot.id}`} aria-labelledby={`sharing-slot-title-${slot.id}`}>
            <h3 id={`sharing-slot-title-${slot.id}`}>{slotLabel(slot.id)}</h3>
            <p>Controls: <strong data-testid={`sharing-owner-${slot.id}`}>{slot.owner ? label(slot.owner.sourceId) : 'None'}</strong></p>
            {slot.owner ? <p>Can move and press here for at most {slot.duration} seconds from approval. It stops automatically.</p> : null}
            <p className={styles.state} role="status">{outcomes[slot.outcome]}</p>
            <div className={styles.surface} data-testid={`sharing-surface-${slot.id}`} data-held={slot.held} data-x={slot.position?.x} data-y={slot.position?.y} aria-label={`${slotLabel(slot.id)} shared output`}>
              {slot.position ? <span className={styles.marker} data-held={slot.held} style={{ left: `${slot.position.x * 100}%`, top: `${slot.position.y * 100}%` }} aria-hidden="true" /> : <span>Waiting for approved controls</span>}
              <span className={styles.outputText}>{slot.held ? 'Pressed' : 'Released'}</span>
            </div>
            {slot.owner ? <button onClick={() => run(owned => { owned.previewRevoke(slot.id); }, 'sharing-confirm')}>Stop sharing {slotLabel(slot.id).toLowerCase()}</button> : null}
          </section>)}
        </div>
      </section>
      <section className={styles.panel} aria-labelledby="sharing-requests-title">
        <h2 id="sharing-requests-title">Requests to review</h2>
        {!snapshot.slots.some(slot => slot.request) ? <p>No pending requests. A control can ask below.</p> : snapshot.slots.filter(slot => slot.request).map(slot => <section className={styles.pending} key={slot.request!.id} data-testid={`sharing-review-${slot.id}`}>
          <h3>{label(slot.request!.sourceId)} asks for {slotLabel(slot.id).toLowerCase()}</h3>
          <p>Move a marker and press in this area only. Review within 30 seconds. {slot.owner ? `${label(slot.owner.sourceId)} keeps control until you approve. Approval releases its held press.` : 'Nothing starts before approval.'}</p>
          <p>The request includes this control’s permission to supply its position and press input for {slot.requestDuration ?? 30} seconds after approval.</p>
          <div className={styles.actions}>
            <button id={`sharing-approve-${slot.id}`} onClick={() => run(owned => { owned.decide(slot.request!.id, true); }, 'sharing-status')}>{slot.owner ? 'Approve transfer' : 'Approve sharing'}</button>
            <button onClick={() => run(owned => { owned.decide(slot.request!.id, false); }, 'sharing-status')}>Decline request</button>
            <button onClick={() => run(owned => { owned.cancel(slot.request!.id); }, 'sharing-status')}>Cancel request</button>
          </div>
        </section>)}
      </section>
      <section aria-labelledby="sharing-controls-title">
        <h2 id="sharing-controls-title">Controls on this screen</h2>
        <p>Use the arrow keys to move. Hold Space to press and release it to let go. You can also drag the pad or use the buttons.</p>
        <label className={styles.duration}>Sharing duration <select aria-label="Sharing duration" value={duration} onChange={event => setDuration(Number(event.target.value) as 30 | 60)}><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label>
        <div className={styles.controls}>
          {snapshot.recipients.map(recipient => {
            const owned = snapshot.slots.some(slot => slot.owner?.sourceId === recipient.id), held = snapshot.slots.some(slot => slot.owner?.sourceId === recipient.id && slot.held);
            const selected = snapshot.slots.some(slot => slot.id === choice[recipient.id]) ? choice[recipient.id] : snapshot.slots[0].id;
            return <section className={styles.panel} key={recipient.id} data-testid={`sharing-controls-${recipient.id}`} aria-labelledby={`sharing-controls-title-${recipient.id}`}>
              <h3 id={`sharing-controls-title-${recipient.id}`}>{recipient.label}</h3>
              <p>{recipient.available ? owned ? 'Approved. Only the chosen area receives these controls.' : 'Waiting for a request and approval.' : 'Unavailable. Enable these controls, then send a new request.'}</p>
              <label>Area to request <select aria-label={`Area for ${recipient.label}`} value={selected} disabled={!recipient.available} onChange={event => setChoice(old => ({ ...old, [recipient.id]: event.target.value }))}>{snapshot.slots.map(slot => <option key={slot.id} value={slot.id}>{slotLabel(slot.id)}</option>)}</select></label>
              <label className={styles.check}><input type="checkbox" checked={allowed[recipient.id]} disabled={!recipient.available} onChange={event => setAllowed(old => ({ ...old, [recipient.id]: event.target.checked }))} />For a new request, allow {recipient.label} to supply position and presses for {duration} seconds after approval.</label>
              <button disabled={!recipient.available || !allowed[recipient.id] || snapshot.slots.some(slot => slot.id === selected && (slot.owner?.sourceId === recipient.id || !!slot.request)) || snapshot.remainingRequests === 0 || snapshot.remainingActivationAttempts === 0} onClick={() => {
                run(task => { task.request(recipient.id, selected, duration, allowed[recipient.id]); }, `sharing-approve-${selected}`); setAllowed(old => ({ ...old, [recipient.id]: false }));
              }}>Request sharing for {recipient.label}</button>
              <button type="button" className={styles.pad} disabled={!owned} aria-label={`${recipient.label} input pad`} aria-disabled={!owned}
                onBlur={() => task.current?.releaseInput(recipient.id)}
                onKeyDown={event => {
                  if (!owned) return;
                  const moves: Record<string, readonly [number, number]> = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02] };
                  const move = moves[event.key]; if (move) { event.preventDefault(); task.current?.nudge(recipient.id, ...move); }
                  if (event.code === 'Space') { event.preventDefault(); task.current?.contact(recipient.id, true); }
                }}
                onKeyUp={event => { if (event.code === 'Space') { event.preventDefault(); task.current?.contact(recipient.id, false); } }}
                onPointerDown={event => { if (!owned) return; const box = event.currentTarget.getBoundingClientRect(); event.currentTarget.setPointerCapture(event.pointerId); task.current?.begin(recipient.id, event.pointerId, event.clientX, event.clientY, box.width, box.height); }}
                onPointerMove={event => { if (!owned) return; const box = event.currentTarget.getBoundingClientRect(); task.current?.move(recipient.id, event.pointerId, event.clientX, event.clientY, box.width, box.height); }}
                onPointerUp={event => { task.current?.end(recipient.id, event.pointerId); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onPointerCancel={() => task.current?.releaseInput(recipient.id)} onLostPointerCapture={() => task.current?.releaseInput(recipient.id)}>Arrow keys · Space · Drag</button>
              <div className={styles.actions}>
                <button disabled={!owned} onClick={() => task.current?.nudge(recipient.id, -.05, 0)}>Move {recipient.label} left</button>
                <button disabled={!owned} onClick={() => task.current?.nudge(recipient.id, .05, 0)}>Move {recipient.label} right</button>
                <button disabled={!owned} aria-pressed={held} onClick={() => task.current?.contact(recipient.id, !held)}>{held ? 'Release' : 'Press'} {recipient.label}</button>
                <button onClick={() => run(owned => { owned.setAvailable(recipient.id, !recipient.available); }, 'sharing-status')}>{recipient.available ? 'Disable' : 'Enable'} {recipient.label}</button>
              </div>
            </section>;
          })}
        </div>
      </section>
      {!snapshot.remainingRequests || !snapshot.remainingActivationAttempts || !snapshot.remainingPolicyChanges ? <p role="status">This setup has reached a limit. Stop this setup, then start again.</p> : null}
      <button onClick={() => run(owned => owned.close(), 'sharing-status')}>Stop this setup</button>
    </>}
  </main>;
}
