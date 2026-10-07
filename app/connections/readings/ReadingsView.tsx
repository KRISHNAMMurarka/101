'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createReadingsTask } from './readings-task';
import type { ReadingReview, ReadingsSnapshot, ReadingsTask } from './readings-task';
import { pageReadingDescriptor } from './readings-schema';
import connectionStyles from '../connections.module.css';
import resourceStyles from '../resources/resource-task.module.css';
import sharingStyles from '../../sharing/sharing.module.css';

const styles: Record<string, string> = { ...connectionStyles, page: `${connectionStyles.page} ${resourceStyles.page}`,
  panel: resourceStyles.panel, actions: resourceStyles.actions, status: resourceStyles.status,
  formRow: resourceStyles.choices, check: sharingStyles.check };

type Role = 'receiver' | 'source';
type FormRow = Readonly<{ step: string; ready: boolean; includeReady: boolean; mode: string }>;
const profile = pageReadingDescriptor();
const empty: ReadingsSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', code: '', confirmed: false,
  resources: Object.freeze([]), clockReady: false, rows: Object.freeze([]), rawPending: 0, cleanupUnconfirmed: false,
  owned: Object.freeze({ registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0 }) });
const freshRow = (): FormRow => ({ step: '0', ready: false, includeReady: true, mode: 'count-up' });
const phases: Record<ReadingsSnapshot['phase'], string> = {
  idle: 'Choose what this page will do. Nothing is connected yet.',
  working: 'Preparing this connection. You can stop while you wait.',
  invitation: 'Send the receiving invitation to the page you chose. It allows no readings yet.',
  review: 'Continue only if you chose this receiving page. No readings are allowed yet.',
  exchange: 'Exchange the complete replies, then compare the matching code on both pages.',
  comparison: 'Compare every character on both pages. Confirm only when the complete codes match.',
  confirmed: 'Waiting for the other page to confirm the complete code.',
  permissions: 'Choose a reading. Both pages must allow that whole reading separately.',
  waiting: 'Permission is set on this page. Waiting for the other page and a current reading.',
  active: 'Sharing is active for up to 30 seconds. Stop clears the display and ends sharing.',
  stopped: 'Sharing stopped. Make a fresh connection to continue.', closed: 'This reading connection is closed.',
};
const reasons: Record<ReadingsSnapshot['reason'], string> = {
  idle: '', permission: '', invalid: 'That code cannot be used here. Use the complete current code from the other page and try again.',
  incompatible: 'These pages cannot share the selected reading. Stop and choose a fresh connection.',
  unavailable: 'This connection could not continue. Check both pages are open, then prepare a fresh connection.',
  expired: 'The time limit ended. Prepare a fresh connection and ask both pages again.',
  stopped: 'Sharing stopped. Prepare a fresh connection to continue.',
  hidden: 'Sharing stopped when this page was hidden. Prepare a fresh connection to continue.',
  closed: 'This reading connection is closed.', busy: 'Earlier work is still finishing. Wait before trying again.',
  quota: 'This page reached its connection limit. Reload before preparing another connection.',
};

export default function ReadingsView() {
  const [role, setRole] = useState<Role>('receiver'), [ready, setReady] = useState(false),
    [snapshot, setSnapshot] = useState<ReadingsSnapshot>(empty), [incoming, setIncoming] = useState(''),
    [outgoingKind, setOutgoingKind] = useState<'invite' | 'offer' | 'answer' | undefined>(undefined),
    [resourceId, setResourceId] = useState(''), [rows, setRows] = useState<readonly FormRow[]>([freshRow()]),
    [formError, setFormError] = useState(''), [reviewHandle, setReviewHandle] = useState<ReadingReview | undefined>(undefined);
  const task = useRef<ReadingsTask | undefined>(undefined),
    outgoing = useRef<HTMLTextAreaElement>(null), invitationInput = useRef<HTMLTextAreaElement>(null), prepare = useRef<HTMLButtonElement>(null),
    returnFocus = useRef(false);
  useEffect(() => {
    const owner = new AbortController(); let mounted = true;
    const installed = createReadingsTask({ role, owner: owner.signal, now: () => performance.now(), wallNow: () => Date.now(),
      onChange(next) { if (mounted && task.current === installed && !owner.signal.aborted) {
        setSnapshot(next); if (!next.selected) setReviewHandle(undefined);
      } } });
    const owns = () => mounted && task.current === installed && !owner.signal.aborted;
    task.current = installed;
    queueMicrotask(() => { if (owns()) { setSnapshot(installed.snapshot()); setReady(true); } });
    const stopHidden = () => { if (owns()) {
      setReviewHandle(undefined); setIncoming(''); setOutgoingKind(undefined); returnFocus.current = true; installed.stop('hidden');
    } };
    const visibility = () => { if (document.hidden) stopHidden(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', stopHidden);
    return () => {
      // Fence retired view callbacks before actual asynchronous resource settlement.
      mounted = false; task.current = undefined;
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stopHidden);
      owner.abort(); void installed.close().then(() => {
        const retired = installed.snapshot();
        // Fixed lifecycle counts only: no reading, code, identity or permission is emitted.
        window.dispatchEvent(new CustomEvent('101-readings-retired', { detail: Object.freeze({
          rawPending: retired.rawPending, owned: retired.owned, cleanupUnconfirmed: retired.cleanupUnconfirmed }) }));
      });
    };
  }, [role]);
  useEffect(() => {
    if (returnFocus.current && snapshot.rawPending === 0 && !snapshot.cleanupUnconfirmed) {
      returnFocus.current = false; (role === 'receiver' ? prepare.current : invitationInput.current)?.focus();
    }
  }, [snapshot.selected, snapshot.rawPending, snapshot.cleanupUnconfirmed, role]);
  const choice = snapshot.resources.find(item => item.id === resourceId) ?? snapshot.resources.find(item => item.supported);
  const sourceCapability = role === 'source' ? profile.capabilities.find(item => item.id === choice?.id) : undefined;
  const formSchema = sourceCapability?.value.type === 'array' ? sourceCapability.value.items : sourceCapability?.value;
  const stepSchema = formSchema?.type === 'record' ? formSchema.fields.step : undefined;
  const modeSchema = formSchema?.type === 'record' ? formSchema.fields.mode : undefined;
  const maxRows = sourceCapability?.value.type === 'array' ? sourceCapability.value.maxItems : 1;
  const tableForm = choice?.shape === 'table';
  const hasAttempt = !['idle', 'stopped', 'closed'].includes(snapshot.phase);
  const settled = snapshot.rawPending === 0 && !snapshot.cleanupUnconfirmed;
  const canStart = ready && !hasAttempt && settled && snapshot.reason !== 'quota';
  const showResources = snapshot.confirmed && (snapshot.phase === 'permissions' || snapshot.selected !== undefined || snapshot.permissionExpiresAt !== undefined);
  const value = (currentRows: readonly FormRow[] = rows) => {
    const selectedRows = tableForm ? currentRows : currentRows.slice(0, 1);
    if (selectedRows.some(row => row.step.trim() === '' || !Number.isFinite(Number(row.step)))) return;
    const values = selectedRows.map(row => ({ step: Number(row.step), ...(row.includeReady ? { ready: row.ready } : {}), mode: row.mode }));
    return tableForm ? values : values[0];
  };
  const editRows = (nextRows: readonly FormRow[]) => {
    setRows(nextRows);
    if (role === 'source' && reviewHandle && snapshot.selected === choice?.id)
      setFormError(task.current?.setValue(value(nextRows)) ? '' : 'Enter a step within the shown limits before sharing.');
  };
  const changeRow = (index: number, change: Partial<FormRow>) => editRows(rows.map((row, at) => at === index ? { ...row, ...change } : row));
  const applyCode = async () => {
    const installed = task.current; if (!installed) return;
    const accepted = await installed.accept(incoming);
    if (task.current !== installed || !accepted) return;
    setIncoming(''); setOutgoingKind(role === 'receiver' ? 'answer' : undefined);
  };
  const reviewReading = () => {
    const installed = task.current; if (!installed || !choice?.supported) return;
    const handle = installed.select(choice.id); setReviewHandle(handle);
    if (!handle) return;
    if (role === 'source') setFormError(installed.setValue(value()) ? '' : 'Enter a step within the shown limits before sharing.');
  };
  const stop = () => { setReviewHandle(undefined); setIncoming(''); setOutgoingKind(undefined); setFormError(''); returnFocus.current = true; task.current?.stop(); };
  const changeRole = (selected: Role) => {
    if (role === selected) return;
    setReady(false); setSnapshot(empty); setIncoming(''); setOutgoingKind(undefined); setResourceId('');
    setRows([freshRow()]); setFormError(''); setReviewHandle(undefined); setRole(selected);
  };
  const reviewed = snapshot.resources.find(item => item.id === snapshot.selected);
  const status = snapshot.cleanupUnconfirmed ? 'Sharing stopped, but cleanup could not be confirmed. Reload before preparing another connection.'
    : snapshot.rawPending > 0 && !hasAttempt ? 'Sharing stopped. Earlier work is still finishing.' : reasons[snapshot.reason] || phases[snapshot.phase];
  const cellStyle = { padding: ".6rem .35rem", borderBottom: "1px solid var(--line-control)", verticalAlign: "top" } as const;
  return <main className={styles.page}>
    <header><p>Connections</p><h1>View shared readings</h1>
      <p>Choose readings from another page. Both pages decide what can be shared, and either page can stop.</p>
      <nav aria-label="Reading connection options" className={styles.actions}><Link href="/connections">Connections</Link><Link href="/devices">Devices</Link></nav>
    </header>
    <fieldset className={styles.roles} disabled={!ready || hasAttempt || !settled}><legend>This page will</legend>
      <button type="button" aria-pressed={role === 'receiver'} onClick={() => changeRole('receiver')}>Show readings on this page</button>
      <button type="button" aria-pressed={role === 'source'} onClick={() => changeRole('source')}>Send readings from this page</button>
    </fieldset>
    <section className={styles.panel} aria-labelledby="reading-connection-heading"><h2 id="reading-connection-heading">Connect the pages</h2>
      <p role="status" aria-live="polite" aria-atomic="true" aria-label="Reading connection status" className={styles.status}>{status}</p>
      <p className={styles.note}>Use two pages you chose. Pasted codes and matching codes allow no readings. Keep both pages visible; a connection ends after one minute.</p>
      {role === 'receiver' && !hasAttempt && <button type="button" ref={prepare} disabled={!canStart} onClick={async () => {
        const installed = task.current; if (installed && await installed.invite() && task.current === installed) setOutgoingKind('invite');
      }}>Prepare receiving page</button>}
      {role === 'source' && !hasAttempt && <div className={styles.code}>
        <label htmlFor="reading-invitation">Invitation from receiving page<textarea ref={invitationInput} id="reading-invitation" value={incoming} rows={3} maxLength={65536} spellCheck={false} onChange={event => setIncoming(event.target.value)} /></label>
        <button type="button" disabled={!canStart || !incoming.trim()} onClick={() => { if (task.current?.review(incoming)) setIncoming(''); }}>Review invitation</button>
      </div>}
      {role === 'source' && snapshot.phase === 'review' && <div className={styles.review}><h3>Receiving page: Reading display</h3>
        <p>Continue to the receiving page you chose. Both owners will still need to allow a reading.</p>
        <button type="button" disabled={!settled} onClick={async () => { const installed = task.current;
          if (installed && await installed.offer() && task.current === installed) setOutgoingKind('offer'); }}>Make sending offer</button>
      </div>}
      {outgoingKind && snapshot.code && snapshot.phase !== 'working' && <div className={styles.code}>
        <label htmlFor="reading-outgoing">{outgoingKind === 'invite' ? 'Receiving invitation' : outgoingKind === 'offer' ? 'Sending offer' : 'Receiving answer'}
          <textarea ref={outgoing} id="reading-outgoing" readOnly value={snapshot.code} rows={3} spellCheck={false} /></label>
        <button type="button" onClick={() => { outgoing.current?.focus(); outgoing.current?.select(); }}>Select complete code</button>
      </div>}
      {role === 'receiver' && outgoingKind === 'invite' && snapshot.phase === 'invitation' && <div className={styles.code}>
        <label htmlFor="reading-offer">Offer from sending page<textarea id="reading-offer" value={incoming} rows={3} maxLength={65536} spellCheck={false} onChange={event => setIncoming(event.target.value)} /></label>
        <button type="button" disabled={!settled || !incoming.trim()} onClick={() => { void applyCode(); }}>Use sending offer</button>
      </div>}
      {role === 'source' && outgoingKind === 'offer' && snapshot.code && snapshot.phase !== 'working' && <div className={styles.code}>
        <label htmlFor="reading-answer">Answer from receiving page<textarea id="reading-answer" value={incoming} rows={3} maxLength={65536} spellCheck={false} onChange={event => setIncoming(event.target.value)} /></label>
        <button type="button" disabled={!settled || !incoming.trim()} onClick={() => { void applyCode(); }}>Use receiving answer</button>
      </div>}
      {snapshot.comparison && <div className={styles.review}><h3>Compare the complete code</h3>
        <output aria-label="Complete comparison code" className={styles.comparison}>{snapshot.comparison.match(/.{1,8}/g)?.join(' ')}</output>
        <p>Compare every character on both pages. Stop if any character differs.</p>
        <div className={styles.actions}><button type="button" disabled={snapshot.confirmed} onClick={() => task.current?.confirm(snapshot.comparison ?? '')}>The complete codes match</button>
          <button type="button" onClick={() => { setReviewHandle(undefined); setIncoming(''); setOutgoingKind(undefined); returnFocus.current = true; task.current?.stop('incompatible'); }}>Codes do not match</button></div>
      </div>}
      <div className={styles.actions}><button type="button" disabled={!ready} onClick={stop}>Stop sharing readings</button><Link href="/connections">Skip and return to Connections</Link></div>
    </section>
    {showResources && <section className={styles.panel} aria-labelledby="reading-choice-heading"><h2 id="reading-choice-heading">Choose a whole reading</h2>
      {snapshot.resources.length === 0 ? <p>Waiting for a supported reading from the sending page.</p> : <>
        <label htmlFor="reading-resource">{role === 'source' ? 'Sending resource' : 'Reading resource'}<select id="reading-resource" value={choice?.id ?? ''} disabled={snapshot.permissionExpiresAt !== undefined} onChange={event => {
          setResourceId(event.target.value); setReviewHandle(undefined); setFormError('');
        }}>{snapshot.resources.map(item => <option key={item.id} value={item.id} disabled={!item.supported}>{item.label}</option>)}</select></label>
        {!snapshot.resources.some(item => item.supported) && <p>No supported reading is available. Stop and choose another sending page.</p>}
        {role === 'receiver' && !snapshot.clockReady && <p>Waiting for a current connection between these pages. Keep both pages open before reviewing a reading.</p>}
        {role === 'source' && choice?.supported && <div className={styles.review}><h3>Readings from this page</h3>
          <p>These values are form entries on this page. Edit them with the keyboard or the controls below.</p>
          {(tableForm ? rows : rows.slice(0, 1)).map((row, index) => <fieldset className={styles.formRow} style={{ minWidth: 0 }} key={index}><legend>{tableForm ? `Row ${index + 1}` : 'One reading'}</legend>
            <label htmlFor={`reading-step-${index}`}>{tableForm ? `Row ${index + 1} step` : 'Step'}<input id={`reading-step-${index}`} type="number" min={stepSchema?.type === 'scalar' ? stepSchema.min : undefined} max={stepSchema?.type === 'scalar' ? stepSchema.max : undefined} step="any" value={row.step} onChange={event => changeRow(index, { step: event.target.value })} /></label>
            <label htmlFor={`reading-mode-${index}`}>{tableForm ? `Row ${index + 1} mode` : 'Mode'}<select id={`reading-mode-${index}`} value={row.mode} onChange={event => changeRow(index, { mode: event.target.value })}>{modeSchema?.type === 'enum' && modeSchema.values.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>
            <label className={styles.check} style={{ display: 'flex' }} htmlFor={`reading-include-${index}`}><input id={`reading-include-${index}`} type="checkbox" checked={row.includeReady} onChange={event => changeRow(index, { includeReady: event.target.checked })} />{tableForm ? `Include row ${index + 1} readiness` : 'Include readiness'}</label>
            <label className={styles.check} style={{ display: 'flex' }} htmlFor={`reading-ready-${index}`}><input id={`reading-ready-${index}`} type="checkbox" checked={row.ready} disabled={!row.includeReady} onChange={event => changeRow(index, { ready: event.target.checked })} />{tableForm ? `Row ${index + 1} ready` : 'Ready'}</label>
          </fieldset>)}
          {tableForm && <div className={styles.actions}><button type="button" disabled={rows.length >= maxRows} onClick={() => { if (rows.length < maxRows) editRows([...rows, freshRow()]); }}>Add row</button>
            <button type="button" disabled={rows.length <= 1} onClick={() => { if (rows.length > 1) editRows(rows.slice(0, -1)); }}>Remove last row</button></div>}
          <p className={styles.note}>{tableForm ? `Up to ${maxRows} rows. ` : ''}An omitted readiness value is shown as Not supplied.</p>
          {formError && <p role="alert">{formError}</p>}
        </div>}
        <div className={styles.actions}><button type="button" disabled={!choice?.supported || snapshot.permissionExpiresAt !== undefined || role === 'receiver' && !snapshot.clockReady} onClick={reviewReading}>Review reading</button></div>
      </>}
      {reviewHandle && reviewed && <div className={styles.review}><h3>Allow {reviewed.label.toLowerCase()}?</h3>
        <p>{role === 'source' ? 'Share this whole reading with the receiving page you compared.' : 'Show this whole reading on this page only.'} Permission lasts up to 30 seconds and ends when either page stops.</p>
        <p>Included fields:</p><ul>{reviewed.columns.map(column => <li key={column.key}>{column.label}{column.unit && column.unit !== '1' ? ` (${column.unit})` : ''}{column.optional ? ' — optional' : ''}</li>)}</ul>
        <p className={styles.note}>This permission covers every included field.</p>
        <button type="button" disabled={snapshot.permissionExpiresAt !== undefined || !!formError} onClick={() => task.current?.allow(reviewHandle)}>{role === 'source' ? 'Allow sending for 30 seconds' : 'Allow this display for 30 seconds'}</button>
      </div>}
    </section>}
    {role === 'receiver' && <section className={styles.panel} aria-labelledby="shared-readings-heading"><h2 id="shared-readings-heading">Shared readings</h2>
      <p>{snapshot.rows.length ? 'Current readings from the sending page.' : 'No readings are displayed. Allow a supported reading on both pages to begin.'}</p>
      <table aria-label="Shared readings" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', overflowWrap: 'anywhere', textAlign: 'left' }}><caption>Current reading values</caption>
        <thead><tr>{(snapshot.table?.columns ?? reviewed?.columns ?? []).map(column => <th key={column.key} scope="col" style={cellStyle}>{column.label}{column.unit && column.unit !== '1' && <span style={{ display: 'block', fontWeight: 'normal' }}>{column.unit}</span>}</th>)}</tr></thead>
        <tbody>{snapshot.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at} style={cellStyle}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </section>}
  </main>;
}
