'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createFeedbackTask, FEEDBACK_TASK_LIMITS } from './feedback-task';
import type { FeedbackReview, FeedbackSnapshot, FeedbackStage, FeedbackTask } from './feedback-task';
import styles from '../resources/resource-task.module.css';

const empty: FeedbackSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', presets: Object.freeze([]),
  approvals: Object.freeze({ source: false, output: false }), rawPending: 0, cleanupUnconfirmed: false, canSend: false,
  runs: 0, actions: 0, commands: 0, callbacks: 0,
  owned: Object.freeze({ runtimes: 0, sources: 0, sinks: 0, routes: 0, taskTimers: 0 }) });
const reasons: Record<FeedbackSnapshot['reason'], string> = {
  idle: 'Feedback is off. Review both permissions before requesting a preset.',
  permission: 'Review page buttons and feedback output separately. Feedback stays off until both are allowed.',
  ready: 'You can request a preset on this page. Stop ends both permissions.',
  requested: 'A feedback request was made. This page cannot confirm whether you felt it.',
  busy: 'Wait before requesting another preset. You can use Stop at any time.',
  unavailable: 'Feedback is unavailable here. Stop and try a fresh setup, or use page controls.',
  unsupported: 'This browser cannot request this feedback. You can use page controls instead.',
  invalid: 'This setup could not continue. Keep feedback stopped and reload to start again.',
  hidden: 'Feedback stopped when this page was hidden. Review both permissions again to continue.',
  unfocused: 'Feedback stopped when you left this page. Review both permissions again to continue.',
  expired: 'The time limit ended. Review both permissions again for a fresh setup.',
  stopped: 'Feedback stopped. Review both permissions again to continue.',
  quota: 'This setup reached its limit. Stop before making a fresh setup. Reload if this page has reached its setup limit.',
  closed: 'Feedback is closed.',
};
const reviews: Record<FeedbackStage, Readonly<{ title: string; scope: string; approve: string }>> = {
  source: { title: 'Allow page feedback buttons?', scope: 'Allow the preset buttons below to supply your requests on this page only. Buttons do not request feedback until feedback output is also allowed.', approve: 'Allow page buttons' },
  output: { title: 'Allow feedback requests in this browser?', scope: 'Allow this page to request the displayed presets in this browser. Your browser and device decide whether vibration is available. This page cannot confirm a physical effect or physical cancellation.', approve: 'Allow feedback requests' },
};
const presetLabels = { tap: 'Tap', impact: 'Impact', warning: 'Warning' } as const;
const outcomeLabels: Record<NonNullable<FeedbackSnapshot['last']>['outcome'], string> = {
  'api-returned': 'The request returned. Whether you felt feedback is not confirmed.',
  unavailable: 'The browser did not accept this request.', busy: 'An earlier request is still finishing.',
  cancelled: 'This request was stopped. Physical cancellation is not confirmed.',
  'api-rejected': 'This request could not continue.', 'rate-limited': 'Wait before requesting another preset.',
  expired: 'This request took too long. Whether you felt feedback is not confirmed.',
};

export default function FeedbackView() {
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot>(empty), [ready, setReady] = useState(false),
    [review, setReview] = useState<FeedbackReview | undefined>(undefined), [notice, setNotice] = useState('');
  const holder = useRef<FeedbackTask | undefined>(undefined), status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    let mounted = true;
    const owner = new AbortController();
    const task = createFeedbackTask({ owner: owner.signal, onChange() { if (mounted) setSnapshot(task.snapshot()); } });
    holder.current = task;
    queueMicrotask(() => { if (mounted) { setSnapshot(task.snapshot()); setReady(true); } });
    return () => {
      mounted = false; holder.current = undefined;
      // Withdrawal failure must not skip lifetime revocation or actual close observation.
      try { void task.stop(); } finally { try { owner.abort(); } finally { void task.close().catch(() => {}); } }
    };
  }, []);
  useEffect(() => {
    if (snapshot.phase === 'settling' || snapshot.phase === 'stopped' || snapshot.phase === 'closed') status.current?.focus();
  }, [snapshot.phase]);
  const work = (operation: (task: FeedbackTask) => boolean | Promise<void>) => {
    const task = holder.current; if (!task) return;
    setNotice('');
    try { void Promise.resolve(operation(task)).catch(() => { setNotice('This setup could not continue. Stop and try again.'); void task.stop(); }); }
    catch { setNotice('This setup could not continue. Stop and try again.'); void task.stop(); }
  };
  const requestReview = (stage: FeedbackStage) => {
    const task = holder.current; if (!task) return;
    setNotice('');
    try { setReview(task.review(stage)); }
    catch { setReview(undefined); setNotice('This setup could not continue. Stop and try again.'); void task.stop(); }
  };
  const stop = () => { setReview(undefined); work(task => task.stop()); };
  const busy = snapshot.phase === 'settling' || snapshot.rawPending > 0;
  const visibleReview = review && snapshot.review === review ? review : undefined;
  const exhausted = snapshot.actions >= FEEDBACK_TASK_LIMITS.actions || snapshot.runs >= FEEDBACK_TASK_LIMITS.runs && snapshot.deadline === undefined;
  return <main className={styles.page}>
    <a className={styles.skip} href="#feedback-presets">Skip to feedback presets</a>
    <header><p>Connections</p><h1>Try feedback</h1>
      <p>Review page buttons and feedback output, then request a preset in this browser. Each setup lasts up to 30 seconds from its first review.</p>
      <p>Feedback is request only. Availability and what you feel depend on your browser and device.</p>
      <div className={styles.actions}><Link href="/connections">Back to Connections</Link><Link href="/connections/resources">Use page controls</Link></div>
    </header>
    <section className={styles.panel} aria-labelledby="feedback-status-title">
      <h2 id="feedback-status-title">This browser</h2>
      <p>No feedback is requested on arrival. Each preset needs a new button press; requests never repeat automatically.</p>
      <div className={styles.actions}><button disabled={!ready} onClick={stop}>Stop</button></div>
      <p ref={status} className={styles.status} tabIndex={-1} role="status">{busy && snapshot.phase !== 'pending' ?
        'Feedback permission has ended. Earlier work must finish before a fresh setup.' : reasons[snapshot.reason]}</p>
      {notice ? <p role="alert">{notice}</p> : null}
      {snapshot.cleanupUnconfirmed ? <p>Cleanup could not be confirmed. Keep feedback stopped. A fresh setup is unavailable on this page.</p> : null}
    </section>
    <section className={styles.panel} aria-labelledby="feedback-permissions-title">
      <h2 id="feedback-permissions-title">Review permissions</h2>
      <p>Page buttons and feedback output are separate choices. Stop ends both. Only this page and this browser are included.</p>
      <div className={styles.actions}>
        <button disabled={!ready || busy || exhausted || snapshot.cleanupUnconfirmed || snapshot.approvals.source}
          onClick={() => requestReview('source')}>Review page buttons</button>
        <button disabled={!ready || busy || exhausted || snapshot.cleanupUnconfirmed || snapshot.approvals.output}
          onClick={() => requestReview('output')}>Review feedback output</button>
      </div>
      {visibleReview ? <div><h3>{reviews[visibleReview.stage].title}</h3><p>Destination: {visibleReview.destination}. {reviews[visibleReview.stage].scope}</p>
        {visibleReview.stage === 'output' ? <p>Available preset requests: {snapshot.presets.map(preset => presetLabels[preset]).join(', ')}.</p> : null}
        <p>Review this choice within five seconds. The original setup time limit still applies.</p>
        <div className={styles.actions}><button onClick={() => { const owned = visibleReview; setReview(undefined); work(task => task.approve(owned)); }}>{reviews[visibleReview.stage].approve}</button>
          <button onClick={stop}>Decline and stop</button></div></div> : null}
      <p>Page buttons: {snapshot.approvals.source ? 'Allowed for this setup' : 'Off'}. Feedback output: {snapshot.approvals.output ? 'Allowed for this setup' : 'Off'}.</p>
    </section>
    <section className={styles.panel} aria-labelledby="feedback-presets">
      <h2 id="feedback-presets" tabIndex={-1}>Feedback presets</h2>
      <p>These names describe preset requests. Strength, duration and whether they feel different are not confirmed.</p>
      <p>Up to {FEEDBACK_TASK_LIMITS.commands} requests are allowed per setup. Wait a moment between requests.</p>
      <div className={styles.actions}>{snapshot.presets.map(preset => <button key={preset} disabled={!ready || !snapshot.canSend}
        onClick={() => work(task => task.send(preset))}>Request {presetLabels[preset]}</button>)}</div>
      {!snapshot.approvals.source || !snapshot.approvals.output ? <p>Allow both permissions before requesting a preset.</p> : null}
      {snapshot.last ? <p role="status">{presetLabels[snapshot.last.preset]}: {outcomeLabels[snapshot.last.outcome]}</p> : <p>No request result is displayed.</p>}
      <p>Use Stop when you are done. Stop ends page permission and asks the browser to cancel; physical cancellation cannot be confirmed.</p>
    </section>
  </main>;
}
