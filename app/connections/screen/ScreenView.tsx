'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createLocalScreenTask } from './screen-task';
import type { LocalScreenTask, ScreenTaskReason, ScreenTaskSnapshot } from './screen-task';
import styles from '../resources/resource-task.module.css';

const initial: ScreenTaskSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', runs: 0, actions: 0, previewVisible: false,
  capturePresent: false, rawPending: 0, framePending: 0, cleanupUnconfirmed: false, owned: Object.freeze({ pipelines: 0, timers: 0 }) });
const messages: Record<ScreenTaskReason, string> = {
  idle: 'Nothing is capturing. Review this brief local preview before choosing a screen or window.',
  review: 'Allow capture, preview frames and local display separately. Nothing starts until you press Choose.',
  opening: 'Waiting for your browser choice. Stop remains available while that request finishes.',
  capturing: 'A current small sample is visible on this page. It is not a full-resolution view.',
  waiting: 'Capture is ready, but no current display sample is available. You can stop or wait briefly.',
  stopped: 'Preview stopped. Review fresh permissions to choose again.', closed: 'Preview access is closed.',
  invalid: 'This preview request is no longer valid. Stop and review a fresh request.', unsupported: 'This browser cannot start this preview. You can return or try another supported browser.',
  unavailable: 'The selected preview could not start. Stop and review a fresh request or check browser permission.',
  denied: 'Screen sharing was not allowed. Check your browser screen-sharing permission, then select Review screen preview to review a fresh choice. You can also return to Connections.', busy: 'Earlier work is still finishing. Wait before choosing again.',
  lost: 'The selected surface ended. Review fresh permissions to choose again.', hidden: 'Preview stopped when this page was hidden. Review fresh permissions to choose again.',
  unfocused: 'Preview stopped when this page lost focus. Review fresh permissions to choose again.', expired: 'The brief permission window ended. Review fresh permissions to choose again.',
  cancelled: 'The request was cancelled. Wait for it to finish before choosing again.', quota: 'This page reached its attempt limit. Reload before choosing again.',
  'gesture-required': 'Press Choose directly after reviewing the permissions. Your browser needs that action to open its chooser.',
  changed: 'The selected surface changed size or settings. Preview stopped; review fresh permissions to choose again.',
  revoked: 'Permission removed. Review fresh permissions to choose again.',
  'cleanup-unconfirmed': 'Access stopped, but cleanup could not be confirmed. Reload before trying again.',
};
const surfaceNames = { monitor: 'Screen', window: 'Window', browser: 'Browser surface', unknown: 'Not reported' } as const;
const cursorNames = { always: 'Reported as always present', motion: 'Reported during motion', never: 'Reported as absent', unknown: 'Not reported' } as const;

export default function ScreenView() {
  const [snapshot, setSnapshot] = useState<ScreenTaskSnapshot>(initial), [error, setError] = useState<ScreenTaskReason | undefined>(undefined);
  const current = useRef<LocalScreenTask | undefined>(undefined), canvas = useRef<HTMLCanvasElement>(null),
    reviewButton = useRef<HTMLButtonElement>(null), reviewTitle = useRef<HTMLHeadingElement>(null), status = useRef<HTMLParagraphElement>(null), generation = useRef({ epoch: 0 });
  useEffect(() => {
    const lifetime = generation.current, epoch = ++lifetime.epoch, owner = new AbortController(), output = canvas.current;
    if (!output) return;
    const installed = createLocalScreenTask({ owner: owner.signal, now: () => performance.now(), preview: output,
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: token => window.clearTimeout(token as number),
      onChange() { if (lifetime.epoch === epoch && current.current === installed && !owner.signal.aborted) setSnapshot(installed.snapshot()); } });
    current.current = installed;
    const background = () => { if (current.current === installed && lifetime.epoch === epoch) void installed.stop('hidden'); };
    const hidden = () => { if (document.hidden) background(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', background); window.addEventListener('blur', background);
    return () => {
      lifetime.epoch++; current.current = undefined;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', background); window.removeEventListener('blur', background);
      // Task close clears this exact output and always starts/awaits native owned
      // teardown, even when its independent display clear throws.
      owner.abort(); void installed.close().then(() => {
        const final = installed.snapshot(); window.dispatchEvent(new CustomEvent('101-local-screen-retired', {
          detail: Object.freeze({ phase: final.phase, rawPending: final.rawPending, framePending: final.framePending,
            cleanupUnconfirmed: final.cleanupUnconfirmed, owned: final.owned }) }));
      });
    };
  }, []);
  const handle = snapshot.review?.handle;
  useEffect(() => { if (handle) reviewTitle.current?.focus(); }, [handle]);
  const unavailable = snapshot.cleanupUnconfirmed || snapshot.phase === 'closed' || snapshot.rawPending > 0;
  const review = () => { setError(undefined); const result = current.current?.review(); if (result && !result.ok) setError(result.reason); };
  const choose = async () => {
    const installed = current.current; if (!installed || !handle) return; setError(undefined);
    const result = await installed.start(handle); if (current.current !== installed) return;
    if (!result.ok) setError(result.reason); setSnapshot(installed.snapshot());
  };
  const stop = () => {
    const installed = current.current; if (!installed) return; setError(undefined);
    void installed.stop().then(() => { if (current.current === installed) { const final = installed.snapshot(); setSnapshot(final);
      if (final.cleanupUnconfirmed) status.current?.focus(); else reviewButton.current?.focus(); } });
  };
  const statusText = snapshot.phase === 'stopping' ? 'Access stopped. Previously issued work is still finishing; a new choice is blocked until it returns.' : messages[error ?? snapshot.reason];
  return <main className={styles.page} data-screen-phase={snapshot.phase} data-screen-pending={snapshot.rawPending} data-screen-preview={snapshot.previewVisible}>
    <Link href="#screen-review" className={styles.skip}>Skip to preview review</Link>
    <header><p><Link href="/connections">Back to Connections</Link></p><h1>Brief screen preview</h1>
      <p>Choose a screen or window with your browser, then see a small local sample on this page.</p></header>
    <p>Nothing captures on arrival. Your browser chooses the surface; this page does not remember it. No audio is captured, and the preview is not saved or sent elsewhere.</p>
    <p>Each permission window lasts at most 10 seconds, counted before the chooser opens. There is no automatic renewal. Leaving, hiding or stopping this page ends access.</p>
    <p className={styles.status} ref={status} role="status" aria-live="polite" tabIndex={-1}>{statusText}</p>
    <section id="screen-review" className={styles.panel} aria-labelledby="screen-review-title">
      <h2 id="screen-review-title">Review a local preview</h2>
      <p>Recipient: this page only. You may select a surface in your browser chooser after allowing each part below. No remote control is connected here.</p>
      <div className={styles.actions}><button ref={reviewButton} disabled={unavailable || snapshot.owned.pipelines > 0 || !!snapshot.review || snapshot.runs >= 4} onClick={review}>Review screen preview</button>
        <button disabled={snapshot.phase === 'idle' || snapshot.phase === 'stopped' || snapshot.phase === 'closed'} onClick={stop}>Stop preview access</button></div>
      {snapshot.review && snapshot.phase === 'review' && <section aria-labelledby="screen-approval-title">
        <h2 id="screen-approval-title" ref={reviewTitle} tabIndex={-1}>Allow each part before choosing</h2>
        <p>The surface is not known yet. Review expires quickly; if needed, Stop and make a fresh review.</p>
        <div className={styles.actions}>{(['capture', 'source', 'display'] as const).map(part => <button key={part} disabled={unavailable || snapshot.review?.[part]}
          onClick={() => { if (!handle) return; const result = current.current?.approve(handle, part); if (result && !result.ok) setError(result.reason); }}>
          {snapshot.review?.[part] ? 'Allowed: ' : 'Allow '}{part === 'capture' ? 'selected screen capture' : part === 'source' ? 'preview frames' : 'display on this page'}</button>)}
          <button disabled={unavailable || !snapshot.review.capture || !snapshot.review.source || !snapshot.review.display} onClick={() => void choose()}>Choose a screen or window</button>
          <button onClick={stop}>Cancel preview review</button></div>
      </section>}
    </section>
    <section className={styles.panel} aria-labelledby="screen-preview-title">
      <h2 id="screen-preview-title">Small local preview</h2>
      <figure><canvas ref={canvas} width={8} height={8} role="img" aria-label={snapshot.previewVisible ? 'Current small sample from the selected surface' : 'No current screen sample'}
        style={{ width: '16rem', maxWidth: '100%', imageRendering: 'pixelated', visibility: snapshot.previewVisible ? 'visible' : 'hidden' }} />
        <figcaption>This 8×8 sample is scaled up. It is not a full-resolution stream or a way to control the selected surface.</figcaption></figure>
      <p>{snapshot.previewVisible ? 'A current local sample is shown.' : 'No current display sample is shown.'}</p>
      {snapshot.facts && <dl><dt>Reported surface type</dt><dd>{surfaceNames[snapshot.facts.displaySurface]}</dd>
        <dt>Reported source dimensions</dt><dd>{snapshot.facts.width} × {snapshot.facts.height}; these are separate from the 8×8 sample.</dd>
        <dt>Reported cursor setting</dt><dd>{cursorNames[snapshot.facts.cursor]}</dd></dl>}
      <p>Surface and cursor facts may be unknown. A surface label does not identify a particular screen or prove permission. A size or settings change stops this preview.</p>
      <div className={styles.actions}>{(['capture', 'source', 'display'] as const).map(part => <button key={part} disabled={!snapshot.capturePresent}
        onClick={() => { const installed = current.current; if (installed) void installed.revoke(part); }}>Remove {part === 'capture' ? 'capture' : part === 'source' ? 'preview-frame' : 'local-display'} permission</button>)}</div>
    </section>
  </main>;
}
