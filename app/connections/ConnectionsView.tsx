'use client';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { createConnectionTask } from './connection-task';
import styles from './connections.module.css';

type Task = ReturnType<typeof createConnectionTask>;
type Snapshot = ReturnType<Task['snapshot']>;
const initial = createConnectionTask({ role: 'receiver', now: () => 0, wallNow: () => 0 }).snapshot();
const directions: Record<string, [number, number]> = { ArrowLeft: [-0.025, 0], ArrowRight: [0.025, 0], ArrowUp: [0, -0.025], ArrowDown: [0, 0.025] };
const messages: Record<Snapshot['phase'], string> = {
  idle: 'Choose what this screen will do. Nothing is connected yet.',
  invitation: 'Share this invitation with the input screen. It lasts five minutes.',
  review: 'This invitation is for a 101 connection surface. Continue only if you chose that screen.',
  working: 'Preparing this connection. You can cancel while you wait.',
  offer: 'Send your reply to the receiving screen, then enter its final reply here.',
  answer: 'Send this final reply to the input screen. Keep both screens open.',
  connecting: 'Waiting for the other screen. Keep both screens open.',
  compare: 'Compare every character of the matching code on both screens. Confirm only when they match.',
  confirmed: 'Waiting for the other screen to confirm the matching code.',
  permissions: 'The screens match. Each owner still needs to allow what this connection can do.',
  active: 'Connected for up to one minute. Stop releases the input.',
  stopped: 'Stopped. Start a fresh connection to continue.',
  unsupported: 'This browser cannot make this connection. Try another browser, or return to Devices.',
  invalid: 'That code cannot be used here. Copy the complete current code from the other screen and try again.',
  busy: 'Earlier work is still finishing. Wait before trying again, or reload this screen.',
  expired: 'The time limit ended. Start a fresh connection and ask both owners again.',
  lost: 'The connection ended. Check that both screens are open, then start a fresh connection.',
};
export default function ConnectionsView() {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<'receiver' | 'source'>('receiver');
  const [snapshot, setSnapshot] = useState(initial);
  const [incoming, setIncoming] = useState('');
  const [reviewingNew, setReviewingNew] = useState(false);
  const task = useRef<Task | undefined>(undefined);
  const status = useRef<HTMLParagraphElement>(null);
  const code = useRef<HTMLTextAreaElement>(null);
  const pad = useRef<HTMLButtonElement>(null);
  const makeTask = useCallback((selected: 'receiver' | 'source') => {
    const controller: Task = createConnectionTask({ role: selected, now: () => performance.now(), wallNow: () => Date.now(),
      onChange() { const next = controller.snapshot(); setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); } });
    task.current = controller;
    return controller;
  }, []);
  useEffect(() => {
    const controller = makeTask('receiver');
    let mounted = true; queueMicrotask(() => { if (mounted) setReady(true); });
    const timer = window.setInterval(() => task.current?.tick(), 16);
    const leave = () => task.current?.stop();
    const blur = () => task.current?.release();
    const hidden = () => { if (document.hidden) leave(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden);
    return () => { mounted = false; clearInterval(timer); window.removeEventListener('pagehide', leave); window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden); task.current?.close(); controller.close(); task.current = undefined; };
  }, [makeTask]);
  useLayoutEffect(() => {
    if (['compare', 'stopped', 'expired', 'lost', 'unsupported', 'invalid', 'busy'].includes(snapshot.phase) || snapshot.notice) status.current?.focus();
    else if (['invitation', 'offer', 'answer'].includes(snapshot.phase) &&
      (document.activeElement === document.body || document.activeElement === status.current)) code.current?.focus();
  }, [snapshot.phase, snapshot.notice]);
  const changeRole = (selected: 'receiver' | 'source') => {
    task.current?.close(); const next = makeTask(selected); setRole(selected); setSnapshot(next.snapshot()); setIncoming('');
  };
  const submit = () => { const current = task.current; if (!current) return;
    if (role === 'source' && (reviewingNew || ['idle', 'stopped', 'invalid', 'expired', 'lost', 'review'].includes(snapshot.phase))) { if (current.review(incoming)) setReviewingNew(false); }
    else void current.useCode(incoming);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction = directions[event.key];
    if (direction) { event.preventDefault(); task.current?.move(...direction); }
    else if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) task.current?.press(true); }
    else if (event.key === 'Escape') { event.preventDefault(); task.current?.release(); }
  };
  const geometry = (event: PointerEvent<HTMLButtonElement>) => { const rect = event.currentTarget.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height] as const; };
  const startPointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (task.current?.beginPointer(event.pointerId, ...geometry(event))) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }
  };
  const endPointer = (event: PointerEvent<HTMLButtonElement>) => { task.current?.endPointer(event.pointerId); };
  const canEnter = role === 'source' ? reviewingNew || ['idle', 'stopped', 'invalid', 'expired', 'lost', 'review', 'offer'].includes(snapshot.phase) : snapshot.phase === 'invitation';
  const hasWork = snapshot.candidate || snapshot.active || snapshot.sourceAllowed || snapshot.outputAllowed;
  return <main className={styles.page}>
    <header className={styles.header}><p className={styles.eyebrow}>Connections</p><h1>Connect an input</h1>
      <p>Choose what can send input and where it can act. Both screens decide before anything moves.</p>
      <nav aria-label="Connection options" className={styles.actions}>
        <Link href="/connections/resources">Connect page controls</Link>
        <Link href="/connections/readings">View shared readings</Link>
        <Link href="/connections/camera">Use a camera here</Link>
        <Link href="/connections/microphone">Check microphone levels</Link>
        <Link href="/connections/screen">Preview a screen here</Link>
        <Link href="/connections/feedback">Try feedback here</Link>
        <Link href="/connections/gamepad">Check a gamepad here</Link>
        <Link href="/connections/audio">Try sound here</Link>
        <Link href="/devices">Back to Devices</Link>
      </nav></header>
    <fieldset className={styles.roles} disabled={!ready || hasWork || snapshot.rawPending > 0}><legend>This screen will</legend>
      <button type="button" aria-pressed={role === 'receiver'} onClick={() => changeRole('receiver')}>Receive input</button>
      <button type="button" aria-pressed={role === 'source'} onClick={() => changeRole('source')}>Send input</button>
    </fieldset>
    <section className={styles.panel} aria-labelledby="connection-status-heading">
      <h2 id="connection-status-heading">{snapshot.active ? 'Input connected' : 'Make the connection'}</h2>
      <p ref={status} tabIndex={-1} role="status" className={styles.status}>{snapshot.notice === 'invalid' ? messages.invalid : messages[snapshot.phase]}</p>
      <p className={styles.note}>This connection lasts only while these screens stay open. An invitation does not allow input.</p>
      {role === 'receiver' && !snapshot.candidate && <button type="button" disabled={!ready} onClick={() => { setIncoming(''); void task.current?.beginReceive(); }}>
        {snapshot.active ? 'Replace connection' : 'Create invitation'}</button>}
      {role === 'source' && snapshot.active && !snapshot.candidate && !reviewingNew && <button type="button" onClick={() => { setIncoming(''); setReviewingNew(true); }}>Choose another receiving screen</button>}
      {snapshot.code && <div className={styles.code}><label htmlFor="outgoing-connection-code">{snapshot.phase === 'invitation' ? 'Invitation to share' : 'Reply to share'}</label>
        <textarea id="outgoing-connection-code" ref={code} readOnly value={snapshot.code} spellCheck={false} rows={3} />
        <button type="button" onClick={() => { code.current?.focus(); code.current?.select(); }}>Select code to copy</button>
      </div>}
      {canEnter && <div className={styles.code}><label htmlFor="incoming-connection-code">{role === 'source' && (reviewingNew || snapshot.phase !== 'offer') ? 'Invitation from the receiving screen' : 'Reply from the other screen'}</label>
        <textarea id="incoming-connection-code" value={incoming} maxLength={65536} onChange={event => setIncoming(event.target.value)} spellCheck={false} rows={3} />
        <button type="button" disabled={!incoming.trim()} onClick={submit}>{role === 'source' && (reviewingNew || snapshot.phase !== 'offer') ? 'Review invitation' : 'Use reply'}</button>
      </div>}
      {role === 'source' && snapshot.phase === 'review' && <div className={styles.review}><h3>Receiving screen: Connection surface</h3>
        <p>It can show a pointer and whether it is pressed. Continuing connects these two screens; it does not allow that input yet.</p>
        <button type="button" onClick={() => { setIncoming(''); void task.current?.beginSend(); }}>Continue to this screen</button></div>}
      {snapshot.comparison && <div className={styles.review}><h3>Matching code</h3><output className={styles.comparison} aria-label="Matching code">{snapshot.comparison.match(/.{1,8}/g)?.join(' ')}</output>
        <p>Compare this with the other screen. If any character differs, cancel.</p>
        <button type="button" disabled={snapshot.confirmed} onClick={() => task.current?.confirm()}>{snapshot.confirmed ? 'Matching code confirmed' : 'The codes match'}</button></div>}
      {snapshot.verified && <div className={styles.review}><h3>{role === 'source' ? 'Allow this input?' : 'Allow this connection to act here?'}</h3>
        {role === 'source' ? <><p>This screen provides a pointer position and a press. It can act only on the Connection surface, for up to one minute.</p>
          <button type="button" disabled={snapshot.sourceAllowed} onClick={() => task.current?.allowSource()}>{snapshot.sourceAllowed ? 'Input sharing allowed' : 'Allow input sharing'}</button></>
          : <><p>{snapshot.compatible ? 'This input provides a pointer position and a press. Allow both to change the surface below for up to one minute.' : snapshot.described ? 'This input cannot control this surface. Choose another input or stop this connection.' : 'Waiting for the input owner. No compatible input has been shared yet.'}</p>
            <button type="button" disabled={!snapshot.compatible || snapshot.outputAllowed} onClick={() => task.current?.allowOutput()}>{snapshot.outputAllowed ? 'Surface control allowed' : 'Allow surface control'}</button></>}
      </div>}
      <div className={styles.actions}>{snapshot.candidate && <button type="button" onClick={() => { task.current?.cancelCandidate(); setIncoming(''); }}>Cancel new connection</button>}
        {hasWork && <button type="button" onClick={() => { task.current?.stop(); setIncoming(''); }}>Stop connection</button>}
        {!hasWork && <Link href="/devices">Skip and return to Devices</Link>}</div>
    </section>
    <section className={styles.panel} aria-labelledby="surface-heading"><h2 id="surface-heading">{role === 'source' ? 'Input pad' : 'Connection surface'}</h2>
      {role === 'source' ? <><p>When connected, use the arrow keys to move. Hold Space to press, release it to let go. Press Enter to press or release. Escape also releases.</p>
        <button type="button" ref={pad} className={styles.pad} disabled={!snapshot.active} aria-pressed={snapshot.held} onKeyDown={keyDown}
          onClick={event => { if (event.detail === 0) { const current = task.current; if (current) current.press(!current.snapshot().held); } }}
          onKeyUp={event => { if (event.code === 'Space') { event.preventDefault(); task.current?.press(false); } }} onBlur={() => task.current?.release()}
          onPointerDown={startPointer} onPointerMove={event => task.current?.movePointer(event.pointerId, ...geometry(event))}
          onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={() => task.current?.release()} aria-label="Input pad">{snapshot.active ? 'Move and press here' : 'Waiting for both owners'}</button>
        <p>{snapshot.held ? 'Press held' : 'Released'}</p></>
        : <><p>Input changes only this surface. It does not control other apps or your computer.</p>
          <div className={styles.surface} data-effects={snapshot.effects} data-held={String(snapshot.held)} aria-label="Connection surface">
            {snapshot.position && <span className={styles.marker} data-held={String(snapshot.held)} style={{ left: `${snapshot.position.x * 100}%`, top: `${snapshot.position.y * 100}%` }} />}
            {!snapshot.position && <span className={styles.empty}>No input received</span>}
          </div><p role="status">{snapshot.held ? 'Press held on this surface' : 'Surface released'}</p></>}
    </section>
  </main>;
}
