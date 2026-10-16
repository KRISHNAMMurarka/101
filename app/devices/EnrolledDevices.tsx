'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createEnrolledDeviceInspector, formatEnrolledPrimitiveValue } from './enrolled-device';
import type { EnrolledDeviceHandle, EnrolledDeviceInspector, EnrolledDeviceSnapshot } from './enrolled-device';
import { REMEMBERED_DEVICE_LIMITS } from './remembered-devices';

const empty: EnrolledDeviceSnapshot = Object.freeze({ state: 'idle', outcome: 'idle', rawPending: 0, timerArmed: false });
const outcomeText: Record<string, string> = {
  idle: 'Pair a device to choose and preview its inputs. No input starts automatically.',
  preparing: 'Preparing a connection code… You can cancel.', 'invitation-ready': 'Use this invitation with the other device’s compatible connector, then paste its complete reply here.',
  'preparing-answer': 'Preparing the answer… You can cancel.', 'answer-ready': 'Use this pairing answer on the other device, then compare the complete connection code on both screens.',
  'confirmed-here': 'Confirmed here. Wait for the other screen to confirm.', 'device-enrolled': 'Device connected. Choose inputs before previewing them.',
  cancelled: 'Cancelled. The current device is unchanged.', 'invalid-offer': 'This reply could not be used. Prepare a fresh invitation and use its complete matching reply. The current device is unchanged.',
  'identity-unavailable': 'Could not prepare the connection. Cancel, then retry.', 'connection-unavailable': 'Could not finish the connection. Prepare a fresh invitation and try again.',
  'setup-unavailable': 'The connection did not finish in time. Cancel, then retry after cleanup finishes.',
  'busy-or-unavailable': 'A connection task is still finishing or the attempt limit was reached. Wait for cleanup, or reload to start again.',
  'input-received': 'Input received by this screen’s preview. No other application is using it.', 'preview-waiting': 'Preview approved. Waiting for input…',
  'preview-released': 'Preview input released.', 'preview-stopped': 'Preview stopped. Reconnect and approve again to start another preview.',
  'preview-expired': 'Preview permission expired. Reconnect and approve again.', 'preview-unavailable': 'Input preview became unavailable. Reconnect to try again.',
  'preview-unsupported': 'This input cannot be previewed here. Choose another input or an application that supports it.',
  'connection-expired': 'This connection expired. Prepare a fresh invitation to reconnect.', 'connection-lost': 'This device stopped responding. Check the other screen, then prepare a fresh invitation.',
  stopped: 'Connections stopped. Pair again when you’re ready.', 'invalid-clock': 'This connection could not stay current. Reload, then pair again.',
  'cleanup-unconfirmed': 'Access stopped here, but connection cleanup could not be confirmed. Reload before trying again.',
  closed: 'Connections closed.',
};
const operations: Record<string, string> = { read: 'Read', subscribe: 'Live updates', write: 'Change values', invoke: 'Actions' };
const memoryText: Record<string, string> = {
  idle: 'Saved names have not been read. Connections stay temporary unless you explicitly remember a past pairing.',
  ready: 'Remembered devices are offline. Pair again and compare the complete codes before using any input.',
  working: 'Finishing the remembered-device change. You can cancel; issued work may still be finishing.',
  saved: 'Past device name remembered on this browser. No connection or preview permission was saved.',
  forgotten: 'Remembered device name removed. Any current connection is separate.', stopped: 'Remembered-device change stopped. Wait for issued work before trying again.',
  unavailable: 'Browser storage is unavailable. Nothing was saved into a temporary replacement. Retry later or continue with a fresh temporary pairing.',
  quota: 'This browser could not keep another saved record. Existing data was left unchanged. Forget a remembered entry, then retry.',
  corrupt: 'Saved data could not be read safely. It was left unchanged. Continue with a fresh temporary pairing, or retry later.',
  future: 'This browser has a saved format this page cannot use. It was left unchanged. Continue with a fresh temporary pairing.',
  capacity: `This browser remembers up to ${REMEMBERED_DEVICE_LIMITS.records} past devices. Forget an entry before remembering another.`,
  conflict: 'Saved records changed during this action. Show remembered devices again before retrying.',
  invalid: 'This past device name could not be remembered safely. A fresh pairing can still be used temporarily.',
  closed: 'Remembered-device management closed.',
  reviewing: 'Review the exact past names and public pairing identifiers below. Confirm within 30 seconds, or cancel and review again.',
  exported: 'Copy of remembered names prepared. Keep it only if you want an offline record. It saves no connection or permission.',
  restored: 'Past names restored as offline records. Pair again and approve inputs separately before use.',
  'not-empty': 'Restore requires an empty remembered list. Existing data was left unchanged. Review and explicitly forget entries first if you want to start over.',
  'invalid-backup': 'This text is not a supported copy of remembered names. Use a complete copy made by this page, containing only past names and public pairing identifiers.',
  expired: 'This review expired or could not stay current. Nothing was copied or restored. Review the names again.',
};

/** Ephemeral resource task only; it never mutates the shared legacy room transport or a saved identity. */
export default function EnrolledDevices({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<EnrolledDeviceSnapshot>(empty), [offer, setOffer] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]), [removing, setRemoving] = useState<EnrolledDeviceHandle>();
  const [rememberReview, setRememberReview] = useState<EnrolledDeviceHandle>(), [forgetting, setForgetting] = useState<string>();
  const [importing, setImporting] = useState(false), [backupInput, setBackupInput] = useState('');
  const controller = useRef<EnrolledDeviceInspector | undefined>(undefined);
  const owner = useRef(0), title = useRef<HTMLHeadingElement>(null), add = useRef<HTMLButtonElement>(null);
  const inspectTitle = useRef<HTMLHeadingElement>(null), removeButton = useRef<HTMLButtonElement>(null), removeTitle = useRef<HTMLHeadingElement>(null);
  const rememberTitle = useRef<HTMLHeadingElement>(null), rememberButton = useRef<HTMLButtonElement>(null), forgottenTitle = useRef<HTMLHeadingElement>(null), savedTitle = useRef<HTMLHeadingElement>(null);
  const backupTitle = useRef<HTMLHeadingElement>(null), importTitle = useRef<HTMLHeadingElement>(null), copyText = useRef<HTMLTextAreaElement>(null);
  const previousHandle = useRef<EnrolledDeviceHandle | undefined>(undefined), previousTask = useRef(false);
  const returnToAdd = useRef(false);
  useEffect(() => {
    if (!sessionId) return;
    const generation = ++owner.current;
    const installed = createEnrolledDeviceInspector({ sessionId, now: () => performance.now(), wallNow: () => Date.now(), onChange(value) {
      if (owner.current === generation && controller.current === installed) setSnapshot(value);
    } });
    controller.current = installed; setSnapshot(installed.snapshot());
    const stop = () => { if (controller.current === installed) installed.stop(); };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', stop);
    return () => {
      // Cleanup advances the active generation to fence callbacks from this installed controller.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      owner.current++; controller.current = undefined;
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stop);
      void installed.close();
    };
  }, [sessionId]);
  useEffect(() => {
    const task = !!snapshot.invitation || !!snapshot.candidate || snapshot.state === 'preparing';
    if (task && !previousTask.current) title.current?.focus();
    if (!task && previousTask.current && !snapshot.current) returnToAdd.current = true;
    previousTask.current = task;
    if (snapshot.current?.handle !== previousHandle.current) {
      previousHandle.current = snapshot.current?.handle; setChosen([]); setRemoving(undefined);
      if (snapshot.current) { returnToAdd.current = false; inspectTitle.current?.focus(); }
    }
    if (returnToAdd.current && !task && snapshot.rawPending === 0) { returnToAdd.current = false; add.current?.focus(); }
  }, [snapshot]);
  useEffect(() => { if (removing) removeTitle.current?.focus(); }, [removing]);
  useEffect(() => { if (rememberReview) rememberTitle.current?.focus(); }, [rememberReview]);
  useEffect(() => { if (forgetting) forgottenTitle.current?.focus(); }, [forgetting]);
  useEffect(() => { if (importing) importTitle.current?.focus(); }, [importing]);
  useEffect(() => { if (snapshot.remembered?.backupReview?.handle) backupTitle.current?.focus(); }, [snapshot.remembered?.backupReview?.handle]);
  useEffect(() => { if (snapshot.remembered?.backupText !== undefined) copyText.current?.focus(); }, [snapshot.remembered?.backupText]);
  const prepare = async () => { setOffer(''); setRemoving(undefined); await controller.current?.prepare(); };
  const cancel = () => { returnToAdd.current = true; controller.current?.cancel(); setOffer(''); };
  const stopConnections = () => { returnToAdd.current = true; controller.current?.stop(); };
  const current = snapshot.current, candidate = snapshot.candidate;
  const remembered = snapshot.remembered, memoryPending = (remembered?.pending ?? 0) > 0,
    forgettingRecord = remembered?.records.find(record => record.publicKeyId === forgetting);
  const backupReview = remembered?.backupReview;
  const pendingTask = !!snapshot.invitation || !!candidate || snapshot.state === 'preparing';
  const status = snapshot.outcome === 'device-removing' ? snapshot.rawPending ? 'Removing the connection… Access has stopped. Cleanup is still finishing.' : 'Device removed. Its connection and previews are closed here.' :
    outcomeText[snapshot.outcome] ?? 'Review the connection and choose an action below.';
  const stopPreview = () => { returnToAdd.current = true; controller.current?.stopPreview(); setChosen([]); };
  const cancelRemoval = () => { setRemoving(undefined); removeButton.current?.focus(); };
  const confirmRemoval = () => {
    if (removing && controller.current?.remove(removing)) { returnToAdd.current = true; setRemoving(undefined); setChosen([]); }
  };
  const toggle = (id: string, checked: boolean) => setChosen(previous => checked ? previous.length < 4 ? [...previous, id] : previous : previous.filter(value => value !== id));
  const remember = async () => {
    const installed = controller.current, handle = rememberReview, generation = owner.current;
    if (!installed || !handle) return; setRememberReview(undefined);
    await installed.rememberCurrent(handle);
    if (controller.current !== installed || owner.current !== generation) return;
    if (rememberButton.current?.isConnected) rememberButton.current.focus(); else savedTitle.current?.focus();
  };
  const forget = async () => {
    const installed = controller.current, publicKeyId = forgetting, generation = owner.current;
    if (!installed || !publicKeyId) return; setForgetting(undefined);
    await installed.forgetRemembered(publicKeyId);
    if (controller.current === installed && owner.current === generation) savedTitle.current?.focus();
  };
  const cancelBackup = () => { controller.current?.cancelRemembering(); setImporting(false); setBackupInput(''); savedTitle.current?.focus(); };
  const confirmBackup = async () => {
    const installed = controller.current, review = backupReview, generation = owner.current;
    if (!installed || !review) return;
    const completed = await installed.confirmRememberedBackup(review.handle);
    if (controller.current !== installed || owner.current !== generation) return;
    if (completed && review.action === 'import') { setImporting(false); setBackupInput(''); }
    if (review.action === 'import' || !completed) savedTitle.current?.focus();
  };
  return <article className="device-card devices-enrolled" aria-labelledby="devices-enrolled-title">
    <div className="device-card-head"><div><h2 id="devices-enrolled-title">Pair a device</h2>
      <p>Connect a device by comparing codes on both screens. Connections on this page last up to one minute.</p></div></div>
    <p className="device-note">Pairing checks the connection’s key, not its physical make or model. Inputs and names are reported by its connector. Nothing starts without a separate preview approval.</p>
    <div className="devices-flow-actions">
      <button ref={add} className="outline-button devices-flow-button" disabled={!sessionId || snapshot.rawPending > 0 || snapshot.state === 'preparing'} onClick={() => void prepare()}>Pair a device</button>
      {(current || pendingTask) && <button className="outline-button devices-flow-button" onClick={stopConnections}>Stop device connections</button>}
    </div>
    <p className="devices-flow-status" role="status" aria-live="polite" data-enrollment-outcome={snapshot.outcome}>{status}</p>
    {pendingTask && <section className="devices-enrolled-task" aria-labelledby="devices-enrollment-task-title">
      <div className="devices-flow-task-head"><h3 id="devices-enrollment-task-title" tabIndex={-1} ref={title}>Pair a device</h3>
        <button className="outline-button devices-flow-button" onClick={cancel}>Cancel pairing</button></div>
      <p>Keep both screens open. An invitation identifies this pairing task. It does not approve access to any input. A new task leaves the current device running until you choose its replacement.</p>
      {snapshot.invitation && <>
        <label className="devices-flow-link-label" htmlFor="devices-resource-invitation">Pairing invitation</label>
        <textarea id="devices-resource-invitation" readOnly value={snapshot.invitation} onFocus={event => event.currentTarget.select()} />
        <label className="devices-flow-link-label" htmlFor="devices-resource-offer">Complete device reply</label>
        <textarea id="devices-resource-offer" maxLength={65536} value={offer} onChange={event => setOffer(event.currentTarget.value)} />
        <button className="outline-button devices-flow-button" disabled={!offer || snapshot.rawPending > 0} onClick={() => void controller.current?.acceptOffer(offer)}>Use device reply</button>
      </>}
      {snapshot.answer && <><label className="devices-flow-link-label" htmlFor="devices-resource-answer">Pairing answer</label>
        <textarea id="devices-resource-answer" readOnly value={snapshot.answer} onFocus={event => event.currentTarget.select()} /></>}
      {candidate?.comparison && <>
        <p>Compare every group on both screens. Confirm only if the complete codes match.</p>
        <output aria-label="Complete connection code" className="devices-enrollment-digest">{candidate.comparison.match(/.{1,8}/g)?.join(' ')}</output>
        {candidate.phase === 'comparison' && <div className="devices-flow-actions">
          <button className="primary-button devices-flow-button" onClick={() => controller.current?.confirm(candidate.comparison!)}>The complete codes match</button>
          <button className="outline-button devices-flow-button" onClick={cancel}>Codes do not match</button>
        </div>}
      </>}
      {candidate?.phase === 'connected' && <button className="primary-button devices-flow-button" onClick={() => controller.current?.activate()}>{current ? 'Replace current device' : 'Use this device'}</button>}
    </section>}
    {current && <section className="devices-enrolled-task" aria-labelledby="devices-enrolled-inspect-title">
      <div className="devices-flow-task-head"><h3 id="devices-enrolled-inspect-title" tabIndex={-1} ref={inspectTitle}>Inspect {current.label}</h3>
        <button ref={removeButton} className="outline-button devices-flow-button" onClick={() => setRemoving(current.handle)}>Remove device</button></div>
      <p>Reported inputs. This connection does not give another application access or let this screen change the device.</p>
      <div className="devices-flow-actions"><button ref={rememberButton} className="outline-button devices-flow-button"
        disabled={!current.metadataReady || snapshot.rawPending > 0 || memoryPending} onClick={() => setRememberReview(current.handle)}>Remember this device in this browser</button></div>
      {rememberReview === current.handle && <section className="devices-enrolled-removal" aria-labelledby="devices-remember-title">
        <h4 id="devices-remember-title" tabIndex={-1} ref={rememberTitle}>Remember this past pairing?</h4>
        <p>Save only the reported name “{current.label}” and its public pairing identifier on this app’s browser storage. Keep the connection temporary unless you choose this.</p>
        <p>A remembered name does not prove which physical device connects next. Its key can change. Pair again, compare the complete codes and separately approve inputs on every connection. No preview, device inputs, offers, answers or private credentials are saved.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={() => { setRememberReview(undefined); rememberButton.current?.focus(); }}>Keep this connection temporary</button>
          <button className="primary-button devices-flow-button" disabled={memoryPending || snapshot.rawPending > 0} onClick={() => void remember()}>Confirm remembering past device</button></div>
      </section>}
      {!current.resources.length && <p>No inputs have been described yet. Wait briefly, or check the connector and reconnect. An empty description is not proof that a device has no inputs.</p>}
      {!!current.resources.length && <ul className="devices-flow-resources">
        {current.resources.map(resource => {
          const table = Object.hasOwn(current.readings, resource.id) ? current.readings[resource.id] : undefined, label = resource.reading?.label ?? resource.semantic;
          const rawValue = Object.hasOwn(current.values, resource.id) ? current.values[resource.id] : undefined;
          const valueText = rawValue === undefined ? undefined : resource.primitive ? formatEnrolledPrimitiveValue(resource, rawValue) : JSON.stringify(rawValue);
          return <li key={resource.id}>
          <div className="devices-flow-resource-head"><h4>{label}</h4><span>{resource.previewable ? current.preview === 'receiving' && (Object.hasOwn(current.values, resource.id) || Object.hasOwn(current.readings, resource.id)) ? 'Input received' : 'Not approved or not receiving' : 'Unavailable for preview'}</span></div>
          <p>Reported actions: {resource.permissions.map(value => operations[value] ?? value).join(', ')}{resource.unit ? ` · Unit: ${resource.unit}` : ''}</p>
          {resource.reading && <><p>Preview includes every shown field. An omitted optional field is shown as Not supplied; a supplied switch is On or Off.</p>
            <ul style={{ overflowWrap: 'anywhere' }}>{resource.reading.columns.map(column => <li key={column.key}>{column.label}{column.unit && column.unit !== '1' ? ` (${column.unit})` : ''}{column.optional ? ' — optional' : ''}</li>)}</ul></>}
          {resource.previewable ? <label className="devices-enrolled-choice"><input type="checkbox" checked={chosen.includes(resource.id)}
            disabled={current.preview !== 'unapproved' || !chosen.includes(resource.id) && chosen.length >= 4}
            onChange={event => toggle(resource.id, event.currentTarget.checked)} />Preview {label}</label> :
            <p>This screen previews compatible live numbers, switches, vectors and bounded readings or reading tables. Read-only properties, actions, jobs, media and other formats need a supporting application.</p>}
          {valueText !== undefined && <output aria-label={`Preview value ${label}`} className="devices-enrolled-value">{valueText}</output>}
          {table && <table aria-label={`Preview ${label}`} style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', overflowWrap: 'anywhere', textAlign: 'left', marginTop: 'var(--space-sm)' }}>
            <caption>Current {label.toLowerCase()}</caption>
            <thead><tr>{table.columns.map(column => <th key={column.key} scope="col" style={{ border: '1px solid var(--line)', padding: 'var(--space-xs)', verticalAlign: 'top' }}>
              {column.label}{column.unit && column.unit !== '1' && <span style={{ display: 'block', fontWeight: 'normal' }}>{column.unit}</span>}
            </th>)}</tr></thead>
            <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ border: '1px solid var(--line)', padding: 'var(--space-xs)', verticalAlign: 'top' }}>{cell}</td>)}</tr>)}</tbody>
          </table>}
        </li>; })}
      </ul>}
      {current.preview === 'unapproved' && <div className="devices-flow-actions"><button className="primary-button devices-flow-button" disabled={!chosen.length}
        onClick={() => controller.current?.preview(chosen)}>Approve selected input preview</button></div>}
      {(current.preview === 'waiting' || current.preview === 'receiving') && <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={stopPreview}>Stop input preview</button></div>}
      {current.preview === 'stopped' && <p>Preview stopped and released. Choose “Pair a device” to reconnect and approve a new preview.</p>}
      <p><Link href="/">Choose an application</Link> for other supported inputs.</p>
      {removing === current.handle && <section className="devices-enrolled-removal" aria-labelledby="devices-remove-title">
        <h4 id="devices-remove-title" tabIndex={-1} ref={removeTitle}>Remove this device connection?</h4>
        <p>This closes its connection and releases this screen’s preview. It does not erase the other device or its saved settings. A remembered name stays until you separately forget it below.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={cancelRemoval}>Keep this device</button>
          <button className="primary-button devices-flow-button" onClick={confirmRemoval}>Confirm device removal</button></div>
      </section>}
    </section>}
    <section className="devices-enrolled-task" aria-labelledby="devices-remembered-title" data-remembered-outcome={remembered?.outcome ?? 'idle'} data-remembered-pending={remembered?.pending ?? 0}>
      <h3 id="devices-remembered-title" tabIndex={-1} ref={savedTitle}>Past devices remembered on this browser</h3>
      <p>These are offline name records, not connected or verified devices. Nothing reconnects or starts a preview from this list. Saved browser data is not an account and can be cleared. A reviewed copy below can keep past names offline. Show remembered devices again to refresh the last read.</p>
      <p role="status" aria-live="polite">{memoryText[remembered?.outcome ?? 'idle']}</p>
      <div className="devices-flow-actions"><button className="outline-button devices-flow-button" disabled={!sessionId || snapshot.rawPending > 0 || memoryPending}
        onClick={() => void controller.current?.loadRemembered()}>Show remembered devices</button>
        {memoryPending && <button className="outline-button devices-flow-button" onClick={() => controller.current?.cancelRemembering()}>Cancel remembered-device change</button>}</div>
      <div className="devices-flow-actions">
        <button className="outline-button devices-flow-button" disabled={!sessionId || snapshot.rawPending > 0 || memoryPending}
          onClick={() => { setImporting(false); setBackupInput(''); void controller.current?.reviewRememberedExport(); }}>Review copy of remembered names</button>
        <button className="outline-button devices-flow-button" disabled={!sessionId || snapshot.rawPending > 0 || memoryPending}
          onClick={() => { controller.current?.cancelRemembering(); setImporting(true); setBackupInput(''); }}>Restore remembered names</button>
      </div>
      {importing && !backupReview && <section className="devices-enrolled-removal" aria-labelledby="devices-backup-import-title">
        <h4 id="devices-backup-import-title" tabIndex={-1} ref={importTitle}>Review a copy of remembered names</h4>
        <p>Paste a complete copy made by this page. Restore works only when this browser’s remembered list is empty. It does not merge, replace or reset saved data.</p>
        <label className="devices-flow-link-label" htmlFor="devices-backup-import">Copy of remembered names</label>
        <textarea id="devices-backup-import" maxLength={REMEMBERED_DEVICE_LIMITS.documentBytes} value={backupInput} disabled={memoryPending}
          onChange={event => setBackupInput(event.currentTarget.value)} />
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={cancelBackup}>Cancel restore</button>
          <button className="primary-button devices-flow-button" disabled={!backupInput || memoryPending || snapshot.rawPending > 0}
            onClick={() => void controller.current?.reviewRememberedImport(backupInput)}>Review names to restore</button></div>
      </section>}
      {backupReview && <section className="devices-enrolled-removal" aria-labelledby="devices-backup-review-title">
        <h4 id="devices-backup-review-title" tabIndex={-1} ref={backupTitle}>{backupReview.action === 'export' ? 'Copy these past names?' : 'Restore these past names?'}</h4>
        <p>Only these reported names and historical public pairing identifiers are included. They do not prove physical identity or permit reconnection. No credentials, inputs, offers, answers, connections or preview permissions are included.</p>
        {!backupReview.records.length && <p>This copy contains no past device names.</p>}
        {!!backupReview.records.length && <ul className="devices-flow-resources">{backupReview.records.map(record => <li key={record.publicKeyId}>
          <h5 style={{ overflowWrap: 'anywhere' }}>{record.label}</h5><p>Offline — past pairing only.</p><p>Past public pairing identifier:</p>
          <output aria-label={`Past public pairing identifier for ${record.label}`} className="devices-enrollment-digest">{record.publicKeyId.match(/.{1,8}/g)?.join(' ')}</output>
        </li>)}</ul>}
        <p>Confirm within 30 seconds. A changed saved list requires a new review. Restore leaves an existing, unreadable or newer saved list unchanged.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={cancelBackup}>Cancel name review</button>
          <button className="primary-button devices-flow-button" disabled={memoryPending || snapshot.rawPending > 0} onClick={() => void confirmBackup()}>
            {backupReview.action === 'export' ? 'Confirm copying remembered names' : 'Confirm restore into empty list'}</button></div>
      </section>}
      {remembered?.backupText !== undefined && <section className="devices-enrolled-removal" aria-labelledby="devices-backup-copy-title">
        <h4 id="devices-backup-copy-title">Copy of remembered names</h4><p>Select and manually copy this text if you want to keep it. Restored names stay offline. Pair again and approve inputs separately before using a device.</p>
        <label className="devices-flow-link-label" htmlFor="devices-backup-copy">Reviewed copy of remembered names</label>
        <textarea id="devices-backup-copy" ref={copyText} readOnly value={remembered.backupText} onFocus={event => event.currentTarget.select()} />
        <button className="outline-button devices-flow-button" onClick={cancelBackup}>Close copy</button>
      </section>}
      {remembered?.records.length === 0 && remembered.outcome === 'ready' && <p>No past devices are remembered on this browser.</p>}
      {!!remembered?.records.length && <ul className="devices-flow-resources">{remembered.records.map(record => <li key={record.publicKeyId}>
        <h4>{record.label}</h4><p>Offline — past pairing only. A fresh connection must be checked independently.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" disabled={snapshot.rawPending > 0 || snapshot.state === 'preparing'} onClick={() => void prepare()}>Pair again</button>
          <button className="outline-button devices-flow-button" disabled={snapshot.rawPending > 0 || memoryPending} onClick={() => setForgetting(record.publicKeyId)}>Forget remembered device</button></div>
      </li>)}</ul>}
      {forgettingRecord && <section className="devices-enrolled-removal" aria-labelledby="devices-forget-title">
        <h4 id="devices-forget-title" tabIndex={-1} ref={forgottenTitle}>Forget {forgettingRecord.label}?</h4>
        <p>Remove only this browser’s past name and pairing record. This does not stop a separate current connection or change the other device.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={() => { setForgetting(undefined); savedTitle.current?.focus(); }}>Keep remembered device</button>
          <button className="primary-button devices-flow-button" disabled={snapshot.rawPending > 0 || memoryPending} onClick={() => void forget()}>Confirm forgetting past device</button></div>
      </section>}
    </section>
  </article>;
}
