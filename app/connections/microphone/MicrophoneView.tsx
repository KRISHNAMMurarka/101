'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createMicrophoneTask, MICROPHONE_TASK_LIMITS } from './microphone-task';
import type { MicrophoneReview, MicrophoneSnapshot, MicrophoneStage, MicrophoneTask } from './microphone-task';
import styles from '../resources/resource-task.module.css';

const empty: MicrophoneSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', choices: Object.freeze([]),
  approvals: Object.freeze({ capture: false, source: false, display: false }), rawPending: 0, cleanupUnconfirmed: false,
  attempts: 0, actions: 0, callbacks: 0, owned: Object.freeze({ runtimes: 0, providers: 0, routes: 0, sinks: 0, taskTimers: 0 }) });
const reasons: Record<MicrophoneSnapshot['reason'], string> = {
  idle: 'Choose an input to check. Microphone use is off.', permission: 'Review each permission before using this input.',
  active: 'The level display is allowed on this page. Use Stop when you are done.',
  unavailable: 'No input is available here. Check microphone access in your browser settings, then stop and look again.',
  invalid: 'This setup cannot continue. Stop and make a fresh setup.', denied: 'Microphone access was blocked. Check browser access, then stop and choose again.',
  unsupported: 'This browser cannot provide these readings. You can use page controls instead.',
  lost: 'The selected input is no longer available. Stop and choose a current input.',
  hidden: 'Microphone use stopped when this page was hidden. Choose an input again to continue.',
  unfocused: 'Microphone use stopped when you left this page. Choose an input again to continue.',
  expired: 'The time limit ended. Choose an input and review each permission again.',
  stopped: 'Microphone use stopped. Choose an input again to continue.', cancelled: 'Setup cancelled. Choose an input again to continue.',
  quota: 'This page reached its setup limit. Stop, wait for cleanup, then reload to start again.',
  busy: 'Earlier work is still finishing. Wait before starting again.', closed: 'Microphone use is closed.',
};
const reviews: Record<MicrophoneStage, Readonly<{ title: string; scope: string; approve: string }>> = {
  capture: { title: 'Allow microphone processing?', scope: 'Allow this page to process the selected microphone for signal levels. Your browser will also decide whether microphone access is allowed.', approve: 'Allow microphone processing' },
  source: { title: 'Allow these microphone readings?', scope: 'Allow the selected input to supply its signal levels and sampling details for this page. This permission ends with the current setup.', approve: 'Allow microphone readings' },
  display: { title: 'Allow the level display?', scope: 'Allow the signal levels to change the display below, on this page only. This permission ends with the current setup.', approve: 'Allow level display' },
};
function canReloadMicrophone(snapshot: MicrophoneSnapshot) {
  return snapshot.attempts >= MICROPHONE_TASK_LIMITS.attempts && snapshot.phase === 'stopped' && !snapshot.cleanupUnconfirmed &&
    snapshot.rawPending === 0 && Object.values(snapshot.owned).every(count => count === 0);
}

export default function MicrophoneView() {
  const [snapshot, setSnapshot] = useState<MicrophoneSnapshot>(empty), [ready, setReady] = useState(false),
    [review, setReview] = useState<MicrophoneReview | undefined>(undefined), [notice, setNotice] = useState('');
  const holder = useRef<MicrophoneTask | undefined>(undefined), status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    let mounted = true;
    const owner = new AbortController();
    const task = createMicrophoneTask({ owner: owner.signal, onChange() { if (mounted) setSnapshot(task.snapshot()); } });
    holder.current = task;
    queueMicrotask(() => { if (mounted) { setSnapshot(task.snapshot()); setReady(true); } });
    return () => {
      mounted = false; holder.current = undefined;
      // A failed observer/retirement callout must not skip owner revocation or actual closure.
      try { void task.stop(); } finally { try { owner.abort(); } finally { void task.close().catch(() => {}); } }
    };
  }, []);
  useEffect(() => {
    if (['stopped', 'closed', 'settling'].includes(snapshot.phase)) status.current?.focus();
  }, [snapshot.phase]);
  const work = (operation: (task: MicrophoneTask) => boolean | Promise<boolean> | Promise<void>) => {
    const task = holder.current; if (!task) return;
    setNotice('');
    try { void Promise.resolve(operation(task)).catch(() => { setNotice('This setup could not continue. Stop and try again.'); void task.stop(); }); }
    catch { setNotice('This setup could not continue. Stop and try again.'); void task.stop(); }
  };
  const requestReview = (stage: MicrophoneStage) => {
    const next = holder.current?.review(stage); setReview(next);
  };
  const stop = () => { setReview(undefined); work(task => task.stop()); };
  const reload = () => {
    const task = holder.current;
    if (task && canReloadMicrophone(task.snapshot())) window.location.reload();
  };
  const settling = snapshot.phase === 'settling', busy = settling || snapshot.rawPending > 0;
  const inputLimitReached = snapshot.attempts >= MICROPHONE_TASK_LIMITS.attempts;
  const usingInput = snapshot.approvals.capture, selected = snapshot.selectedOrdinal ?? 0;
  const cells = snapshot.latest?.rows[0], columns = snapshot.latest?.columns;
  const rmsIndex = columns?.findIndex(column => column.key === 'rms') ?? -1, peakIndex = columns?.findIndex(column => column.key === 'peak') ?? -1;
  const average = cells && rmsIndex >= 0 ? cells[rmsIndex] : undefined, peak = cells && peakIndex >= 0 ? cells[peakIndex] : undefined;
  const visibleReview = review && snapshot.phase === 'review' ? review : undefined;
  return <main className={styles.page}>
    <a className={styles.skip} href="#microphone-levels">Skip to level display</a>
    <header><p>Connections</p><h1>Check microphone levels</h1>
      <p>Choose one input and decide what this page may use. Each setup lasts up to 30 seconds from finding that input.</p>
      <p>These are digital signal levels from 0 to 1. Recording, playback and sharing with other pages are off.</p>
      <div className={styles.actions}><Link href="/connections">Back to Connections</Link><Link href="/connections/resources">Use page controls</Link></div>
    </header>
    <section className={styles.panel} aria-labelledby="microphone-input-title">
      <h2 id="microphone-input-title">Choose the input</h2>
      <p>{inputLimitReached ? 'To look for inputs again, stop and wait for cleanup, then reload this page.' :
        'If no inputs appear, check microphone access in your browser settings, then stop and look again. Only the input you choose is used.'}</p>
      <div className={styles.actions}><button disabled={!ready || busy || snapshot.owned.runtimes > 0 || inputLimitReached || snapshot.cleanupUnconfirmed}
        onClick={() => { setReview(undefined); work(task => task.findInputs()); }}>Find inputs</button>
        <button disabled={!ready} onClick={stop}>Stop</button>
        {inputLimitReached && <button disabled={!canReloadMicrophone(snapshot)} onClick={reload}>Reload this page</button>}</div>
      {snapshot.choices.length > 0 ? <label>Input<select value={selected} disabled={busy || usingInput}
        onChange={event => { const ordinal = Number(event.target.value); setReview(undefined); work(task => task.select(ordinal)); }}>
        <option value={0} disabled>Choose an input</option>{snapshot.choices.map(choice => <option key={choice.ordinal} value={choice.ordinal}>{choice.label}</option>)}
      </select></label> : null}
      <p ref={status} className={styles.status} tabIndex={-1} role="status">{settling ? 'Stopping microphone use. Earlier work must finish before a fresh setup.' :
        snapshot.phase === 'stopped' && inputLimitReached && !snapshot.cleanupUnconfirmed ? 'Microphone use stopped. This page reached its setup limit. Check microphone access in your browser settings, then reload this page to start again.' :
        snapshot.phase === 'no-inputs' && inputLimitReached ? 'No input is available here. This page reached its setup limit. Check microphone access in your browser settings, then stop and wait for cleanup before reloading this page.' :
        snapshot.phase === 'finding' ? 'Finding available inputs. Microphone use is off.' : snapshot.phase === 'opening' ? 'Waiting for the selected input. You can stop while you wait.' :
        snapshot.phase === 'captured' ? 'The selected microphone is being processed. Review the remaining permissions to show its levels.' : reasons[snapshot.reason]}</p>
      {notice ? <p role="alert">{notice}</p> : null}
      {snapshot.cleanupUnconfirmed ? <p>Cleanup could not be confirmed. Keep microphone use stopped and check browser access before leaving this page.</p> : null}
    </section>
    <section className={styles.panel} aria-labelledby="microphone-permissions-title">
      <h2 id="microphone-permissions-title">Review permissions</h2>
      <p>Microphone processing, supplying readings and changing this display are separate choices. Stop ends all three.</p>
      <div className={styles.actions}>
        <button disabled={!selected || busy || snapshot.approvals.capture} onClick={() => requestReview('capture')}>Review microphone processing</button>
        <button disabled={!usingInput || busy || snapshot.phase === 'opening' || snapshot.approvals.source} onClick={() => requestReview('source')}>Review microphone readings</button>
        <button disabled={!snapshot.approvals.source || busy || snapshot.approvals.display} onClick={() => requestReview('display')}>Review level display</button>
      </div>
      {visibleReview ? <div><h3>{reviews[visibleReview.stage].title}</h3><p>{visibleReview.label}. {reviews[visibleReview.stage].scope}</p>
        <p>Review this choice within five seconds. The original setup time limit still applies.</p>
        <div className={styles.actions}><button onClick={() => { const owned = visibleReview; setReview(undefined); work(task => task.approve(owned)); }}>{reviews[visibleReview.stage].approve}</button>
          <button onClick={stop}>Decline and stop</button></div></div> : null}
    </section>
    <section className={styles.panel} aria-labelledby="microphone-levels" id="microphone-levels-panel">
      <h2 id="microphone-levels" tabIndex={-1}>Level display</h2>
      <p>{snapshot.approvals.display ? 'Levels are supplied only while this setup remains active.' : 'No readings are displayed until all three permissions are allowed.'}</p>
      <div className={styles.outputs}>
        <label>Average signal level<output>{average ?? 'Not yet supplied'}</output>{average !== undefined ? <meter min={0} max={1} value={Number(average)} aria-label="Average signal level" /> : null}</label>
        <label>Peak signal level<output>{peak ?? 'Not yet supplied'}</output>{peak !== undefined ? <meter min={0} max={1} value={Number(peak)} aria-label="Peak signal level" /> : null}</label>
      </div>
    </section>
  </main>;
}
