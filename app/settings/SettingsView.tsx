'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createSettingsTask, createSettingsThemePreview } from './settings-task';
import type { SettingsAction, SettingsTask, SettingsTaskState, ThemeChoice } from './settings-task';
import styles from '../connections/connections.module.css';
import appearance from './settings.module.css';

const initial: SettingsTaskState = Object.freeze({ active: false, pending: false, message: 'arrival', theme: 'system',
  canSave: false, canReset: false, canDelete: false, canResume: false });
const names: Record<ThemeChoice, string> = { system: 'Use this browser’s appearance', light: 'Light', dark: 'Dark' };
const messages: Record<SettingsTaskState['message'], string> = {
  arrival: 'Your choices stay untouched until you allow management.',
  review: 'Review this choice before continuing.', loading: 'Opening your saved appearance…',
  ready: 'Appearance is ready to review. The preview is only for this page.',
  saved: 'Your appearance choice was saved on this browser.', reset: 'Saved appearance was reset to this browser’s default.',
  deleted: 'Saved appearance was removed. A record of the removal is kept without your choices.',
  cancelled: 'That change was cancelled.', stopped: 'Management stopped. Your page preview was restored.',
  expired: 'Management ended after 30 seconds. Allow a new session to continue.',
  conflict: 'Saved choices changed in another page. Reload them before reviewing a new change.',
  corrupt: 'Saved appearance could not be read. Review Reset saved appearance to recover this page’s choices.',
  incompatible: 'These saved choices use a format this page cannot manage. They have been kept untouched.',
  'wrong-owner': 'These choices do not belong to this page. They have been kept untouched.',
  unavailable: 'Local saving is unavailable. Stop management, then try again after pending work has finished.',
  'pending-deletion': 'Removal has started. Review Finish removal to complete it. Saved choices remain unavailable until then.',
  limit: 'This page has reached its management limit. Stop and reopen Settings to continue.',
};
const reviews: Record<SettingsAction, { title: string; text: string; allow: string }> = {
  manage: { title: 'Allow local appearance management?',
    text: 'Read this page’s saved appearance and preview changes for up to 30 seconds. Saving, resetting and removal need separate confirmation. No device starts or connects.',
    allow: 'Allow for 30 seconds' },
  save: { title: 'Save this appearance?',
    text: 'Keep this choice on this browser until you reset or remove it. It will not change other pages automatically. Other stored preferences stay unchanged.', allow: 'Save appearance' },
  reset: { title: 'Reset saved appearance?',
    text: 'Return appearance to this browser’s default, preserving other readable preferences. If these private choices cannot be read, replace them with defaults. This does not change device permissions, connections or choices saved elsewhere.', allow: 'Reset appearance' },
  delete: { title: 'Remove saved appearance?',
    text: 'Make this page’s saved choices unavailable and start their removal. You will review Finish removal next. A record of the removal is retained without your choices. Devices and connections are unaffected.', allow: 'Start removal' },
  'resume-delete': { title: 'Finish removing saved appearance?',
    text: 'Complete the pending removal for this page’s choices. The removal record is kept, and no permissions or connections are restored.', allow: 'Finish removal' },
};

export default function SettingsView() {
  const [state, setState] = useState(initial);
  const task = useRef<SettingsTask | undefined>(undefined);
  const preview = useRef<ReturnType<typeof createSettingsThemePreview> | undefined>(undefined);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousReview = useRef<object | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    const value = createSettingsTask({ onChange(next) {
      if (!next.active) { preview.current?.restore(); preview.current = undefined; }
      if (mounted) setState(next);
    } });
    task.current = value;
    const retire = () => { preview.current?.restore(); preview.current = undefined; value.stop(); };
    const hidden = () => { if (document.visibilityState === 'hidden') retire(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', retire);
    return () => {
      mounted = false; document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', retire);
      preview.current?.restore(); preview.current = undefined; value.stop();
      // close retains unresolved native opening/transaction reservations until
      // actual settlement; component teardown does not claim browser quiescence.
      void value.close(); task.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (state.review && state.review.token !== previousReview.current) reviewHeading.current?.focus();
    else if (!state.review && previousReview.current && !state.pending) {
      if (returnFocus.current?.isConnected && !returnFocus.current.hasAttribute('disabled')) returnFocus.current.focus();
      else if (!state.active) manageButton.current?.focus(); else status.current?.focus();
    }
    if (state.review || !state.pending) previousReview.current = state.review?.token;
  }, [state.review, state.active, state.pending]);
  function review(action: SettingsAction) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    task.current?.review(action);
  }
  function restorePreview() { preview.current?.restore(); preview.current = undefined; }
  function choose(theme: ThemeChoice) {
    const value = task.current; if (!value) return;
    value.chooseTheme(theme);
    const current = value.snapshot();
    if (!current.active || current.pending || current.review || current.theme !== theme) return;
    preview.current ??= createSettingsThemePreview(document.documentElement);
    preview.current.apply(theme);
  }
  async function decide(allow: boolean) {
    if (!state.review) return;
    const action = state.review.action;
    await task.current?.decide(state.review.token, allow);
    if (allow && action === 'reset') restorePreview();
  }
  const busy = state.pending || !!state.review;
  const currentReview = state.review ? reviews[state.review.action] : undefined;
  return <main className={`${styles.page} ${appearance.page}`} aria-labelledby="settings-title">
    <header className={styles.header}>
      <p className={styles.eyebrow}>This browser</p>
      <h1 id="settings-title">Settings</h1>
      <p>Preview appearance on this page and decide whether to keep your choice.</p>
    </header>
    <section className={styles.panel} aria-labelledby="appearance-title">
      <h2 id="appearance-title">Appearance</h2>
      <p>Saved appearance is not loaded or applied on arrival. A management session lasts up to 30 seconds.</p>
      <p ref={status} className={styles.status} role="status" aria-live="polite" tabIndex={-1}>{messages[state.message]}</p>
      {!state.active && <button ref={manageButton} type="button" disabled={busy} onClick={() => review('manage')}>Manage appearance</button>}
      {state.active && <>
        <label className={appearance.choice}>Page appearance
          <select value={state.theme} disabled={busy || !state.canSave} onChange={event => choose(event.target.value as ThemeChoice)}>
            <option value="system">Use this browser’s appearance</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <p className={styles.note}>The preview ends with Cancel preview, Stop management, or when you leave or hide this page. Saving does not apply it elsewhere.</p>
        <div className={styles.actions}>
          <button type="button" disabled={busy || !state.canSave} onClick={() => review('save')}>Review save</button>
          <button type="button" disabled={busy || !state.canReset} onClick={() => review('reset')}>Reset saved appearance</button>
          <button type="button" disabled={busy || !state.canDelete} onClick={() => review('delete')}>Remove saved appearance</button>
          {state.canResume && <button type="button" disabled={busy} onClick={() => review('resume-delete')}>Review Finish removal</button>}
          <button type="button" disabled={busy || !state.canSave} onClick={() => { restorePreview(); task.current?.cancelPreview(); }}>Cancel preview</button>
          <button type="button" disabled={busy || state.canResume || state.message === 'wrong-owner'} onClick={() => { restorePreview(); void task.current?.reload(); }}>Reload saved appearance</button>
        </div>
      </>}
      {(state.active || state.pending) && <button className={appearance.stop} type="button" onClick={() => { restorePreview(); task.current?.stop(); }}>Stop management</button>}
      {state.pending && <p className={styles.note}>Waiting for local storage to finish. A new session cannot start yet.</p>}
    </section>
    {state.review && currentReview && <section className={`${styles.panel} ${styles.review}`} aria-labelledby="settings-review-title">
      <h2 ref={reviewHeading} id="settings-review-title" tabIndex={-1}>{currentReview.title}</h2>
      <p>{currentReview.text}</p>
      {state.review.action === 'save' && <p>Selected appearance: <strong>{names[state.theme]}</strong>.</p>}
      <div className={styles.actions}>
        <button type="button" disabled={state.pending} onClick={() => { void decide(true); }}>{currentReview.allow}</button>
        <button type="button" disabled={state.pending} onClick={() => { void decide(false); }}>Cancel</button>
      </div>
    </section>}
    <section className={styles.panel} aria-labelledby="settings-devices-title">
      <h2 id="settings-devices-title">Devices and connections</h2>
      <p>Inspect devices or review a connection in their own pages. Appearance choices do not grant access to them.</p>
      <div className={styles.actions}><Link href="/devices">Devices</Link><Link href="/connections">Connections</Link></div>
      <p className={styles.note}>Account identity, installed providers and publisher updates are not managed here.</p>
    </section>
  </main>;
}
