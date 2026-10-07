'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createHistoryTask, HISTORY_RESOURCES } from './history-task';
import type { HistoryAction, HistoryTask, HistoryTaskState } from './history-task';
import styles from '../../connections/connections.module.css';
import appearance from '../settings.module.css';

const initial: HistoryTaskState = Object.freeze({ active: false, pending: false, message: 'arrival',
  selectedResource: HISTORY_RESOURCES[0]!.id, count: 0, partial: false,
  canCapture: false, canExport: false, canDelete: false, canResume: false, canSweep: false });
const messages: Record<HistoryTaskState['message'], string> = {
  arrival: 'Nothing is opened or collected until you allow management.',
  review: 'Review this choice before continuing.', loading: 'Opening saved page history…',
  ready: 'Saved history is ready to inspect. Collection is off unless you separately allow it.',
  collecting: 'Collection is on for the selected page measurement. Stop collection whenever you want.',
  'collection-stopped': 'Collection stopped. Already saved items keep their original expiry.',
  exported: 'Selected history was handed to this browser for download.',
  'pending-deletion': 'Removal needs fresh review. Review the next step to finish removing the selected history.',
  deleted: 'Selected history removed. A removal record is retained without measurements.',
  swept: 'Expired saved items were removed from this page’s history store.',
  cancelled: 'Management was not started.', stopped: 'Management stopped. Saved items keep their original expiry.',
  expired: 'Management ended after 30 seconds. Allow a new session to continue.',
  'wrong-owner': 'These saved items do not belong to this page. They have been kept untouched.',
  incompatible: 'This saved format cannot be managed by this page. It has been kept untouched.',
  corrupt: 'Saved history could not be read safely. It has been kept untouched.',
  unavailable: 'Local history is unavailable. Stop management and try again after pending work finishes.',
  limit: 'This page has reached its management limit. Leave and reopen it to continue.',
};
const reviews: Record<HistoryAction, { title: string; text: string; allow: string }> = {
  manage: { title: 'Allow page history management?', text: 'Read this page’s saved history for up to 30 seconds. Collection, download, removal and expiry cleanup each need another review. No device starts or connects.', allow: 'Allow management for 30 seconds' },
  capture: { title: 'Collect this page measurement?', text: 'Keep only the selected page size or page position, at most once per second. Collection ends with Stop collection, leaving or hiding this page, or this approval ending. It collects no text, keys, address or device data.', allow: 'Allow collection' },
  export: { title: 'Download selected history?', text: 'Download the selected measurement’s saved items, including their original values and observation times. You manage downloaded copies separately; removing local history cannot recall them.', allow: 'Allow download' },
  delete: { title: 'Remove selected history?', text: 'Make the selected saved measurement unavailable and start removal of its local records and registered local copies. Another review is needed for each removal step. Other saved measurements remain. A removal record is kept without measurements.', allow: 'Allow removal' },
  'resume-delete': { title: 'Continue selected removal?', text: 'Allow one next step of the previously selected removal. This does not restore collection or download permission.', allow: 'Allow next removal step' },
  sweep: { title: 'Remove expired saved items?', text: 'Remove expired history and registered local copies from this page’s private history store. Original expiry times are kept; downloaded copies are unaffected. Cleanup does not start collection.', allow: 'Allow expiry cleanup' },
};

export default function HistoryView() {
  const [state, setState] = useState(initial), [retention, setRetention] = useState(60000);
  const task = useRef<HistoryTask | undefined>(undefined);
  const reviewHeading = useRef<HTMLHeadingElement>(null), status = useRef<HTMLParagraphElement>(null), manageButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null), previousReview = useRef<object | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    const value = createHistoryTask({ onChange(next) { if (mounted) setState(next); } }); task.current = value;
    const retire = () => value.stop();
    const hidden = () => { if (document.visibilityState === 'hidden') retire(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', retire); window.addEventListener('blur', retire);
    return () => {
      mounted = false; document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', retire); window.removeEventListener('blur', retire);
      value.stop(); void value.close(); task.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (state.review && previousReview.current !== state.review.token) reviewHeading.current?.focus();
    else if (!state.review && previousReview.current && !state.pending) {
      if (returnFocus.current?.isConnected && !returnFocus.current.hasAttribute('disabled')) returnFocus.current.focus();
      else if (!state.active) manageButton.current?.focus(); else status.current?.focus();
    }
    if (state.review || !state.pending) previousReview.current = state.review?.token;
  }, [state.review, state.active, state.pending]);
  function review(action: HistoryAction) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    task.current?.review(action, action === 'capture' ? { resourceId: state.selectedResource, retentionMs: retention } : undefined);
  }
  const busy = state.pending || !!state.review, currentReview = state.review ? reviews[state.review.action] : undefined;
  const selected = HISTORY_RESOURCES.find(resource => resource.id === state.selectedResource)!;
  const collection = HISTORY_RESOURCES.find(resource => resource.id === state.capture?.resourceId);
  return <main data-history-page className={`${styles.page} ${appearance.page}`} aria-labelledby="history-title">
    <header className={styles.header}>
      <p className={styles.eyebrow}>This browser</p>
      <h1 id="history-title">History on this browser</h1>
      <p>Choose whether to keep this page’s size or position. Inspect, download or remove only the measurement you select.</p>
      <Link href="/settings">Back to Settings</Link>
    </header>
    <section className={styles.panel} aria-labelledby="history-management-title">
      <h2 id="history-management-title">Local history</h2>
      <p>Arrival opens no saved history and collects nothing. Management is temporary and collection always needs its own review.</p>
      <p ref={status} role="status" aria-live="polite" tabIndex={-1} className={styles.status}>{messages[state.message]}</p>
      {!state.active && <button ref={manageButton} type="button" disabled={busy} onClick={() => review('manage')}>Manage history</button>}
      {state.active && <>
        <label className={appearance.choice}>Saved resource
          <select value={state.selectedResource} disabled={busy || state.canResume} onChange={event => { void task.current?.selectResource(event.target.value); }}>
            {HISTORY_RESOURCES.map(resource => <option key={resource.id} value={resource.id}>{resource.label}</option>)}
          </select>
        </label>
        <p>{selected.label}: {state.count} saved {state.count === 1 ? 'item' : 'items'}{state.partial ? ' shown' : ''}.</p>
        <p className={styles.note}>Every saved item expires by its original collection approval deadline. Expired items are cleared on the next approved use, rather than in the background.</p>
        <div className={styles.actions}>
          <button type="button" disabled={busy || !state.canExport} onClick={() => review('export')}>Export selected history</button>
          <button type="button" disabled={busy || !state.canDelete} onClick={() => review('delete')}>Remove selected history</button>
          {state.canResume && <button type="button" disabled={busy} onClick={() => review('resume-delete')}>Resume selected removal</button>}
          <button type="button" disabled={busy || !state.canSweep} onClick={() => review('sweep')}>Remove expired history</button>
        </div>
      </>}
      {(state.active || state.pending) && <button className={appearance.stop} type="button" onClick={() => { returnFocus.current = manageButton.current; task.current?.stop(); }}>Stop management</button>}
      {state.pending && <p className={styles.note}>Waiting for local storage or the current download to finish. A new session cannot start yet.</p>}
    </section>
    {state.active && !state.canResume && <section className={styles.panel} aria-labelledby="history-collection-title">
      <h2 id="history-collection-title">Page measurements</h2>
      <p>Only this page’s size or scroll position can be collected. No device permission is requested.</p>
      <label className={appearance.choice}>Keep data for
        <select value={retention} disabled={busy} onChange={event => setRetention(Number(event.target.value))}>
          <option value="15000">Up to 15 seconds</option>
          <option value="60000">Until this approval ends (up to 30 seconds)</option>
        </select>
      </label>
      <p className={styles.note}>The shorter of your choice and the original approval applies. Changing this choice never extends existing saved items.</p>
      <div className={styles.actions}>
        <button type="button" disabled={busy || !state.canCapture} onClick={() => review('capture')}>Record page measurements</button>
        {state.capture && <button type="button" onClick={() => task.current?.stopCapture()}>Stop collection</button>}
      </div>
      {collection && <p>Collecting {collection.label.toLowerCase()}. A collection keeps at most 16 items, then stops.</p>}
    </section>}
    {state.review && currentReview && <section className={`${styles.panel} ${styles.review}`} aria-labelledby="history-review-title">
      <h2 ref={reviewHeading} id="history-review-title" tabIndex={-1}>{currentReview.title}</h2>
      <p>{currentReview.text}</p>
      {state.review.action !== 'manage' && <p>Selected measurement: <strong>{HISTORY_RESOURCES.find(resource => resource.id === state.review!.resourceId)?.label}</strong>.</p>}
      {state.review.action === 'capture' && <p>Keep each item for {state.review.retentionMs === 15000 ? 'up to 15 seconds' : 'the remainder of this approval'}, ending sooner if the original approval ends.</p>}
      <div className={styles.actions}>
        <button type="button" disabled={state.pending} onClick={() => { if (state.review) void task.current?.decide(state.review.token, true); }}>{currentReview.allow}</button>
        <button type="button" disabled={state.pending} onClick={() => { if (state.review) void task.current?.decide(state.review.token, false); }}>Cancel</button>
      </div>
    </section>}
    <section className={styles.panel} aria-labelledby="history-limits-title">
      <h2 id="history-limits-title">What stays local</h2>
      <p>These controls manage only this page’s history on this browser. They do not manage an account, other sites, connected devices or copies downloaded elsewhere.</p>
      <p>Removing history needs fresh review for each step. Leaving, hiding or unfocusing this page stops management; returning never restores collection permission.</p>
      <p className={styles.note}>A record of removal or expiry is kept for 30 days without saved measurements. Local storage may be unavailable; pending work must finish before retry.</p>
    </section>
  </main>;
}
