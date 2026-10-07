'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createProcessorManagementTask } from './processor-management';
import type { ManagementAction, ManagementReview, ManagementVersion, ProcessorManagementState, ProcessorManagementTask } from './processor-management';
import styles from '../../connections/resources/resource-task.module.css';
import connections from '../../connections/connections.module.css';
import appearance from '../settings.module.css';

const initial: ProcessorManagementState = Object.freeze({ phase: 'idle', installed: Object.freeze([]), publisherRevoked: false,
  indicator: null, effectCount: 0, releaseCount: 0, rawPending: 0, registrations: 0, routes: 0, documentBytes: 0,
  timerArmed: false, flushArmed: false, attemptsRemaining: 32, cleanupFailures: 0, closurePending: false, inputAllowed: false, outputAllowed: false });
const messages: Record<string, string> = {
  idle: 'Nothing is installed or running. Manage this tab when you are ready.',
  opening: 'Checking this page’s reviewed versions…', working: 'Finishing your approved change…',
  ready: 'Review an action below. Installation alone never starts the example.',
  stopped: 'Management stopped. Any installed versions are inactive and stay only in this page.',
  'live-stopped': 'Live use stopped and the page indicator was released. Allow it again before sending another number.',
  expired: 'Permission ended after 30 seconds. Manage again and give fresh approval to continue.',
  declined: 'That change was declined. Current management and live use stay as they were.',
  integrity: 'This version’s content or signature could not be verified. It was not installed.',
  untrusted: 'This publisher or version is not approved for this page. It was not started.',
  conformance: 'This version did not pass this page’s checked behavior. The current version was kept.',
  revoked: 'Permission for this version or publisher was removed. It cannot start again in this page.',
  incompatible: 'This version is not supported by this page. Your current choice was kept.',
  denied: 'Allow the number input and page indicator separately before starting live use.',
  busy: 'Previous work is still finishing. Wait before reviewing another change.',
  conflict: 'The installed choice changed during this action. Stop management, then review a fresh choice.',
  unavailable: 'This action could not finish. Stop management, then retry after pending work has finished.',
  interrupted: 'Live use ended. Review the installed version and allow fresh input and output to restart.',
  capacity: 'This page reached its action limit. Leave and reopen it to start a fresh tab session.',
  invalid: 'Choose a number from −40 to 125 degrees Celsius.',
  'invalid-clock': 'This page could not keep the permission current. Leave and reopen it before trying again.',
  'invalid-review': 'That review is no longer current. Review the action again.',
  closed: 'This page’s processor management has closed.',
};
const reviewText: Record<ManagementAction, { title: string; body: string; confirm: string }> = {
  install: { title: 'Install this version in this tab?', body: 'Verify and keep this reviewed version only in this page. It will remain inactive until you separately allow live use. A running version stays in place.', confirm: 'Confirm installation' },
  'activate-reviewed': { title: 'Use this version on this page?', body: 'Use the number you enter in degrees Celsius and change this page’s indicator through the reviewed rule. Both permissions end with this management session. An accepted version change releases the previous live rule.', confirm: 'Start approved example' },
  'rollback-reviewed': { title: 'Use the earlier reviewed version?', body: 'Switch to the retained earlier version for this page’s number and indicator. This does not lower the publisher’s verification requirements. Fresh input and output approval is required.', confirm: 'Confirm rollback and use' },
  'revoke-release': { title: 'Revoke this version?', body: 'Stop this version’s live use and refuse future starts in this tab. Other reviewed versions remain separate.', confirm: 'Confirm version revocation' },
  'revoke-publisher': { title: 'Revoke the built-in publisher?', body: 'Stop its live use and refuse both reviewed versions in this tab. Leaving this page clears this tab-only record.', confirm: 'Confirm publisher revocation' },
  remove: { title: 'Remove the installed versions?', body: 'Stop live use and remove source content from this tab’s installation record. Minimal version and revocation records remain until you leave this page.', confirm: 'Confirm removal' },
};

export default function ProcessorManagementPage() {
  const [state, setState] = useState(initial), [version, setVersion] = useState<ManagementVersion>('1.0.0'),
    [number, setNumber] = useState(30), [manageReview, setManageReview] = useState(false), [requestError, setRequestError] = useState('');
  const owned = useRef<ProcessorManagementTask | undefined>(undefined), alive = useRef(false), lifetime = useRef(0),
    reviewTitle = useRef<HTMLHeadingElement>(null), manageButton = useRef<HTMLButtonElement>(null),
    statusText = useRef<HTMLParagraphElement>(null), actionButton = useRef<HTMLButtonElement | null>(null), previousReview = useRef<ManagementReview | undefined>(undefined);
  const current = state.phase === 'ready' || state.phase === 'working', pending = state.phase === 'opening' || state.phase === 'working' || state.rawPending > 0;
  const update = (task: ProcessorManagementTask) => { if (alive.current && owned.current === task) setState(task.snapshot()); };
  useEffect(() => {
    const pageLifetime = lifetime;
    alive.current = true; const id = ++pageLifetime.current;
    const hidden = () => { if (document.hidden) { owned.current?.stopManagement(); setManageReview(false); } };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false; pageLifetime.current++; document.removeEventListener('visibilitychange', hidden);
      const task = owned.current; owned.current = undefined;
      if (task) void task.close().then(() => {
        window.dispatchEvent(new CustomEvent('101-processor-management-retired', { detail: { lifetime: id, closeAwaited: true, ...task.snapshot() } }));
      });
    };
  }, []);
  useEffect(() => {
    if (state.review || manageReview) reviewTitle.current?.focus({ preventScroll: true });
    else if (previousReview.current && !pending) {
      const button = actionButton.current;
      if (button?.isConnected && !button.disabled) button.focus({ preventScroll: true });
      else statusText.current?.focus({ preventScroll: true });
    }
    // Keep the original review while its action is disabled by actual returned work.
    if (state.review || !pending) previousReview.current = state.review;
  }, [state.review, manageReview, pending]);
  async function manage() {
    setManageReview(false); setRequestError('');
    let task = owned.current;
    if (!task) {
      const created = createProcessorManagementTask({ onChange: () => update(created) });
      task = created; owned.current = created;
    }
    const id = lifetime.current;
    const result = await task.manage();
    if (!alive.current || lifetime.current !== id || owned.current !== task) return;
    update(task); if (!result.ok) setRequestError(result.reason);
  }
  function review(action: ManagementAction, button: HTMLButtonElement) {
    const task = owned.current; if (!task) return;
    actionButton.current = button; setRequestError('');
    const result = task.review(action, ['install', 'activate-reviewed', 'rollback-reviewed', 'revoke-release'].includes(action) ? version : undefined);
    update(task); if (!result.ok) setRequestError(result.reason);
  }
  async function confirm() {
    const task = owned.current, pending = state.review; if (!task || !pending) return;
    const id = lifetime.current; setRequestError('');
    const result = await task.confirm(pending);
    if (!alive.current || lifetime.current !== id || owned.current !== task) return;
    update(task); if (!result.ok) setRequestError(result.reason);
  }
  const installed = state.installed.find(item => item.version === version), liveReview = state.review && ['activate-reviewed', 'rollback-reviewed'].includes(state.review.action),
    details = state.review ? reviewText[state.review.action] : undefined;
  const status = ['closed', 'expired', 'stopped'].includes(state.phase) ? state.reason || state.phase : requestError || state.reason || state.phase;
  return <main className={`${styles.page} ${appearance.page}`} aria-labelledby="processor-settings-title"
    data-processor-phase={state.phase} data-processor-raw={state.rawPending} data-processor-routes={state.routes}
    data-processor-registrations={state.registrations} data-processor-timers={Number(state.timerArmed) + Number(state.flushArmed)}
    data-processor-effects={state.effectCount} data-processor-releases={state.releaseCount} data-processor-cleanup-failures={state.cleanupFailures}
    data-processor-until={state.managementUntil ?? ''}>
    <Link className={styles.skip} href="/settings">Back to Settings</Link>
    <header><h1 id="processor-settings-title">Manage reviewed processors</h1>
      <p>Try a built-in reviewed number rule. It can read only the number you enter here and change this page’s indicator after your approval.</p>
      <p><strong>This tab only.</strong> Leaving or reloading this page forgets its installed versions. This does not install a device connector or give access to other apps.</p></header>
    <p ref={statusText} tabIndex={-1} className={styles.status} role="status" aria-label="Processor management status">{messages[status] ?? 'Review a fresh action to continue.'}</p>
    {!current && <div className={styles.actions}>
      <button ref={manageButton} disabled={pending || state.cleanupFailures > 0 || state.attemptsRemaining === 0}
        onClick={() => { setManageReview(true); setRequestError(''); }}>Manage processors</button>
    </div>}
    {manageReview && <section className={styles.panel} aria-labelledby="processor-manage-review-title">
      <h2 id="processor-manage-review-title" ref={reviewTitle} tabIndex={-1}>Allow processor management?</h2>
      <p>For up to 30 seconds, inspect this tab’s installed versions and review changes. Each installation, live use, rollback or removal needs its own approval. Nothing starts now.</p>
      <div className={styles.actions}><button disabled={pending} onClick={() => void manage()}>Allow management for 30 seconds</button>
        <button onClick={() => { setManageReview(false); manageButton.current?.focus(); }}>Decline management</button></div>
    </section>}
    <section className={styles.panel} aria-labelledby="processor-version-title">
      <h2 id="processor-version-title">Built-in number threshold rule</h2>
      <p>This publisher and its two versions are reviewed with this app. They request local calculation only. They cannot select new code or ask for device access.</p>
      <div className={appearance.choice}><label>Reviewed version<select value={version} disabled={!current || pending || !!state.review}
        onChange={event => setVersion(event.target.value as ManagementVersion)} aria-label="Reviewed version">
        <option value="1.0.0">1.0.0 — turns on at 30 degrees</option><option value="2.0.0">2.0.0 — turns on above 30 degrees</option>
      </select></label></div>
      <p>{state.installed.length ? `Installed in this page: ${state.installed.map(item => `${item.version}${item.revoked ? ' (revoked)' : ''}`).join(', ')}.` : 'No installed version in this page.'}</p>
      <p>{state.activeVersion ? `Live version: ${state.activeVersion}.` : 'No live version. Installation is separate from live use.'}</p>
      {state.publisherRevoked && <p>Both versions are blocked because this tab revoked the built-in publisher.</p>}
      <div className={styles.actions}>
        <button disabled={!current || pending || !!state.review || state.publisherRevoked} onClick={event => review('install', event.currentTarget)}>Review install</button>
        <button disabled={!current || pending || !!state.review || !installed || installed.revoked || state.publisherRevoked || state.activeVersion === version}
          onClick={event => review('activate-reviewed', event.currentTarget)}>Review live use</button>
        <button disabled={!current || pending || !!state.review || !installed || installed.revoked || state.publisherRevoked || state.selectedVersion !== '2.0.0' || version !== '1.0.0'}
          onClick={event => review('rollback-reviewed', event.currentTarget)}>Review rollback</button>
        <button disabled={!current || pending || !!state.review || !installed || installed.revoked} onClick={event => review('revoke-release', event.currentTarget)}>Revoke selected version</button>
        <button disabled={!current || pending || !!state.review || !state.installed.length || state.publisherRevoked} onClick={event => review('revoke-publisher', event.currentTarget)}>Revoke built-in publisher</button>
        <button disabled={!current || pending || !!state.review || !state.installed.length} onClick={event => review('remove', event.currentTarget)}>Remove installed versions</button>
      </div>
    </section>
    {details && state.review && <section className={styles.panel} aria-labelledby="processor-action-review-title">
      <h2 id="processor-action-review-title" ref={reviewTitle} tabIndex={-1}>{details.title}</h2>
      <p>{details.body}</p><p>{state.review.version ? `Selected version: ${state.review.version}.` : 'Scope: the built-in number rule in this tab.'}</p>
      {liveReview && <fieldset className={connections.roles}><legend>Allow both sides separately</legend>
        <button aria-pressed={state.inputAllowed} disabled={pending || state.inputAllowed} onClick={() => { owned.current?.allowInput(state.review!); }}>Allow this page’s number input</button>
        <button aria-pressed={state.outputAllowed} disabled={pending || state.outputAllowed} onClick={() => { owned.current?.allowOutput(state.review!); }}>Allow this page’s indicator output</button>
      </fieldset>}
      <div className={styles.actions}><button disabled={pending || (!!liveReview && (!state.inputAllowed || !state.outputAllowed))} onClick={() => void confirm()}>{details.confirm}</button>
        <button disabled={pending} onClick={() => { const task = owned.current; if (task) { task.decline(state.review!); update(task); } }}>Decline change</button></div>
    </section>}
    <section className={styles.panel} aria-labelledby="processor-use-title">
      <h2 id="processor-use-title">Use the page example</h2>
      <p>Enter a number in degrees Celsius. No temperature sensor is connected. The reviewed rule turns the indicator on near 30 degrees and off at 28 degrees.</p>
      <label>Number in degrees Celsius<input type="range" aria-label="Number in degrees Celsius" min={-40} max={125} step={1} value={number}
        disabled={!state.activeVersion || pending} onChange={event => setNumber(Number(event.target.value))} /></label>
      <output aria-label="Selected number">{number} degrees Celsius</output>
      <div className={styles.actions}><button disabled={!state.activeVersion || pending} onClick={() => {
        const task = owned.current; if (!task) return; const result = task.sendNumber(number); update(task); setRequestError(result.ok ? '' : result.reason);
      }}>Send number</button><button disabled={!state.activeVersion} onClick={() => { owned.current?.stopLive(); }}>Stop live use</button></div>
      <output aria-label="Page indicator" aria-live="polite">{state.indicator === null ? 'Released' : state.indicator ? 'On' : 'Off'}</output>
    </section>
    {(current || state.phase === 'opening') && <div className={styles.actions}><button onClick={() => { owned.current?.stopManagement(); setManageReview(false); }}>Stop management</button></div>}
  </main>;
}
