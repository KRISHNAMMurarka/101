'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createEnrolledDeviceInspector } from './enrolled-device';
import type { EnrolledDeviceHandle, EnrolledDeviceInspector, EnrolledDeviceSnapshot } from './enrolled-device';

const empty: EnrolledDeviceSnapshot = Object.freeze({ state: 'idle', outcome: 'idle', rawPending: 0, timerArmed: false });
const outcomeText: Record<string, string> = {
  idle: 'Enroll a resource connection explicitly. Reported inputs are not already running.',
  preparing: 'Preparing a connection code… You can cancel.', 'invitation-ready': 'Use this invitation in the resource device’s connector, then paste its complete offer here.',
  'preparing-answer': 'Preparing the answer… You can cancel.', 'answer-ready': 'Use this answer on the resource device, then compare the complete connection code on both screens.',
  'confirmed-here': 'Confirmed here. Wait for the other screen to confirm.', 'device-enrolled': 'Device connected. Choose inputs before previewing them.',
  cancelled: 'Cancelled. The current device is unchanged.', 'invalid-offer': 'This offer could not be used. Prepare a fresh invitation and use its complete matching offer. The current device is unchanged.',
  'identity-unavailable': 'Could not prepare the connection. Cancel, then retry.', 'connection-unavailable': 'Could not finish the connection. Prepare a fresh invitation and try again.',
  'setup-unavailable': 'The connection did not finish in time. Cancel, then retry after cleanup finishes.',
  'busy-or-unavailable': 'A connection task is still finishing or the attempt limit was reached. Wait for cleanup, or reload to start again.',
  'input-received': 'Input received by this screen’s preview. No other application is using it.', 'preview-waiting': 'Preview approved. Waiting for input…',
  'preview-released': 'Preview input released.', 'preview-stopped': 'Preview stopped. Reconnect and approve again to start another preview.',
  'preview-expired': 'Preview permission expired. Reconnect and approve again.', 'preview-unavailable': 'Input preview became unavailable. Reconnect to try again.',
  'preview-unsupported': 'This input cannot be previewed here. Choose another input or an application that supports it.',
  'connection-expired': 'This connection expired. Prepare a fresh invitation to reconnect.', 'connection-lost': 'This device stopped responding. Check the other screen, then prepare a fresh invitation.',
  stopped: 'Connections stopped. Enroll again when you’re ready.', 'invalid-clock': 'This connection could not stay current. Reload, then enroll again.',
  'cleanup-unconfirmed': 'Access stopped here, but connection cleanup could not be confirmed. Reload before trying again.',
  closed: 'Connections closed.',
};
const operations: Record<string, string> = { read: 'Read', subscribe: 'Live updates', write: 'Change values', invoke: 'Actions' };

/** Ephemeral resource task only; it never mutates the shared legacy room transport or a saved identity. */
export default function EnrolledDevices({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<EnrolledDeviceSnapshot>(empty), [offer, setOffer] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]), [removing, setRemoving] = useState<EnrolledDeviceHandle>();
  const controller = useRef<EnrolledDeviceInspector | undefined>(undefined);
  const owner = useRef(0), title = useRef<HTMLHeadingElement>(null), add = useRef<HTMLButtonElement>(null);
  const inspectTitle = useRef<HTMLHeadingElement>(null), removeButton = useRef<HTMLButtonElement>(null), removeTitle = useRef<HTMLHeadingElement>(null);
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
  const prepare = async () => { setOffer(''); setRemoving(undefined); await controller.current?.prepare(); };
  const cancel = () => { returnToAdd.current = true; controller.current?.cancel(); setOffer(''); };
  const stopConnections = () => { returnToAdd.current = true; controller.current?.stop(); };
  const current = snapshot.current, candidate = snapshot.candidate;
  const pendingTask = !!snapshot.invitation || !!candidate || snapshot.state === 'preparing';
  const status = snapshot.outcome === 'device-removing' ? snapshot.rawPending ? 'Removing the connection… Access has stopped. Cleanup is still finishing.' : 'Device removed. Its connection and previews are closed here.' :
    outcomeText[snapshot.outcome] ?? 'Review the connection and choose an action below.';
  const stopPreview = () => { returnToAdd.current = true; controller.current?.stopPreview(); setChosen([]); };
  const cancelRemoval = () => { setRemoving(undefined); removeButton.current?.focus(); };
  const confirmRemoval = () => {
    if (removing && controller.current?.remove(removing)) { returnToAdd.current = true; setRemoving(undefined); setChosen([]); }
  };
  const toggle = (id: string, checked: boolean) => setChosen(previous => checked ? previous.length < 4 ? [...previous, id] : previous : previous.filter(value => value !== id));
  return <article className="device-card devices-enrolled" aria-labelledby="devices-enrolled-title">
    <div className="device-card-head"><div><h2 id="devices-enrolled-title">Enrolled resource connections</h2>
      <p>Connect a resource device by comparing codes on both screens. Connections on this page last up to one minute.</p></div></div>
    <p className="device-note">Enrollment checks the connection’s key, not its physical make or model. Inputs and names are reported by its connector. Nothing starts without a separate preview approval.</p>
    <div className="devices-flow-actions">
      <button ref={add} className="outline-button devices-flow-button" disabled={!sessionId || snapshot.rawPending > 0 || snapshot.state === 'preparing'} onClick={() => void prepare()}>Enroll resource device</button>
      {(current || pendingTask) && <button className="outline-button devices-flow-button" onClick={stopConnections}>Stop resource connections</button>}
    </div>
    <p className="devices-flow-status" role="status" aria-live="polite" data-enrollment-outcome={snapshot.outcome}>{status}</p>
    {pendingTask && <section className="devices-enrolled-task" aria-labelledby="devices-enrollment-task-title">
      <div className="devices-flow-task-head"><h3 id="devices-enrollment-task-title" tabIndex={-1} ref={title}>Enroll a resource device</h3>
        <button className="outline-button devices-flow-button" onClick={cancel}>Cancel enrollment</button></div>
      <p>Keep both screens open. An invitation identifies this task and does not permit a resource operation. A new task leaves the current device running until you choose its replacement.</p>
      {snapshot.invitation && <>
        <label className="devices-flow-link-label" htmlFor="devices-resource-invitation">Receiver invitation</label>
        <textarea id="devices-resource-invitation" readOnly value={snapshot.invitation} onFocus={event => event.currentTarget.select()} />
        <label className="devices-flow-link-label" htmlFor="devices-resource-offer">Complete resource offer</label>
        <textarea id="devices-resource-offer" maxLength={65536} value={offer} onChange={event => setOffer(event.currentTarget.value)} />
        <button className="outline-button devices-flow-button" disabled={!offer || snapshot.rawPending > 0} onClick={() => void controller.current?.acceptOffer(offer)}>Use resource offer</button>
      </>}
      {snapshot.answer && <><label className="devices-flow-link-label" htmlFor="devices-resource-answer">Receiver answer</label>
        <textarea id="devices-resource-answer" readOnly value={snapshot.answer} onFocus={event => event.currentTarget.select()} /></>}
      {candidate?.comparison && <>
        <p>Compare every group on both screens. Confirm only if the complete codes match.</p>
        <output aria-label="Complete resource connection code" className="devices-enrollment-digest">{candidate.comparison.match(/.{1,8}/g)?.join(' ')}</output>
        {candidate.phase === 'comparison' && <div className="devices-flow-actions">
          <button className="primary-button devices-flow-button" onClick={() => controller.current?.confirm(candidate.comparison!)}>The complete codes match</button>
          <button className="outline-button devices-flow-button" onClick={cancel}>Codes do not match</button>
        </div>}
      </>}
      {candidate?.phase === 'connected' && <button className="primary-button devices-flow-button" onClick={() => controller.current?.activate()}>{current ? 'Replace current resource device' : 'Use enrolled resource device'}</button>}
    </section>}
    {current && <section className="devices-enrolled-task" aria-labelledby="devices-enrolled-inspect-title">
      <div className="devices-flow-task-head"><h3 id="devices-enrolled-inspect-title" tabIndex={-1} ref={inspectTitle}>Inspect {current.label}</h3>
        <button ref={removeButton} className="outline-button devices-flow-button" onClick={() => setRemoving(current.handle)}>Remove resource device</button></div>
      <p>Reported inputs. This connection does not give another application access or let this screen change the device.</p>
      {!current.resources.length && <p>No inputs have been described yet. Wait briefly, or check the connector and reconnect. An empty description is not proof that a device has no inputs.</p>}
      {!!current.resources.length && <ul className="devices-flow-resources">
        {current.resources.map(resource => <li key={resource.id}>
          <div className="devices-flow-resource-head"><h4>{resource.semantic}</h4><span>{resource.previewable ? current.preview === 'receiving' && Object.hasOwn(current.values, resource.id) ? 'Input received' : 'Not approved or not receiving' : 'Unavailable for preview'}</span></div>
          <p>Reported operations: {resource.permissions.map(value => operations[value] ?? value).join(', ')}{resource.unit ? ` · Unit: ${resource.unit}` : ''}</p>
          {resource.previewable ? <label className="devices-enrolled-choice"><input type="checkbox" checked={chosen.includes(resource.id)}
            disabled={current.preview !== 'unapproved' || !chosen.includes(resource.id) && chosen.length >= 4}
            onChange={event => toggle(resource.id, event.currentTarget.checked)} />Preview {resource.semantic}</label> :
            <p>This screen previews only compatible live number, switch and vector inputs. Read-only properties, actions, jobs, media and other formats need a supporting application.</p>}
          {Object.hasOwn(current.values, resource.id) && <output aria-label={`Preview value ${resource.semantic}`} className="devices-enrolled-value">{JSON.stringify(current.values[resource.id])}</output>}
        </li>)}
      </ul>}
      {current.preview === 'unapproved' && <div className="devices-flow-actions"><button className="primary-button devices-flow-button" disabled={!chosen.length}
        onClick={() => controller.current?.preview(chosen)}>Approve selected input preview</button></div>}
      {(current.preview === 'waiting' || current.preview === 'receiving') && <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={stopPreview}>Stop input preview</button></div>}
      {current.preview === 'stopped' && <p>Preview stopped and released. Use Enroll resource device to reconnect and approve a new preview.</p>}
      <p><Link href="/">Choose an application</Link> for other supported inputs.</p>
      {removing === current.handle && <section className="devices-enrolled-removal" aria-labelledby="devices-remove-title">
        <h4 id="devices-remove-title" tabIndex={-1} ref={removeTitle}>Remove this resource connection?</h4>
        <p>This closes its connection and releases this screen’s preview. It does not erase the other device or its saved settings.</p>
        <div className="devices-flow-actions"><button className="outline-button devices-flow-button" onClick={cancelRemoval}>Keep resource device</button>
          <button className="primary-button devices-flow-button" onClick={confirmRemoval}>Confirm resource removal</button></div>
      </section>}
    </section>}
  </article>;
}
