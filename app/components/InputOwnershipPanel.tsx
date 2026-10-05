'use client';

import type { InputOwnershipController, InputOwnershipSnapshot } from '@101/connect';
import { useEffect, useId, useRef, useState } from 'react';

const button = { minHeight: 44, minWidth: 44 };
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 'var(--space-xs)', alignItems: 'center' };
const messages = { ready: 'Choose an input and request control.', requested: 'The current input keeps control while this request is reviewed.',
  declined: 'Request declined. Current control stays with its owner.', cancelled: 'Request cancelled. Current control stays with its owner.',
  'request-expired': 'Request expired. Request again when ready.', transferred: 'Control allowed. Release it when finished.', released: 'Control released. Request again to continue.',
  'route-lost': 'Input stopped and held contact was released. Request again to recover.',
  'activation-failed': 'Control could not start. The previous input was released. Restore access and request again.', closed: 'Controls closed.' };

/** Host-local consent. Labels do not identify remote people, and choices never grant browser/OS permissions. */
export default function InputOwnershipPanel({ controller }: { controller: InputOwnershipController }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<InputOwnershipSnapshot>(() => controller.snapshot());
  const [selected, setSelected] = useState(controller.snapshot().sources[0]?.id ?? '');
  const focus = useRef<string | undefined>(undefined);
  const focusState = snapshot.slots.map(slot => `${slot.id}:${slot.state}:${slot.owner?.epoch ?? 0}:${slot.request?.id ?? ''}`).join('|');
  useEffect(() => {
    const update = () => setSnapshot(controller.snapshot()); update();
    return controller.subscribe(update);
  }, [controller]);
  useEffect(() => {
    const target = focus.current; if (!target) return;
    // Wait for native click focus to settle; cancel the owned frame on state loss/unmount.
    const frame = requestAnimationFrame(() => {
      if (focus.current !== target) return; focus.current = undefined;
      const element = document.getElementById(target) as HTMLButtonElement | null;
      if (element && !element.disabled) element.focus();
      else if (element) document.getElementById(`${target}-release`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusState]);
  const label = (sourceId: string) => snapshot.sources.find(source => source.id === sourceId)?.label ?? 'Selected input';
  return <section aria-labelledby={`${id}-title`} data-testid="input-ownership-panel">
    <h2 id={`${id}-title`}>Who controls the surface?</h2>
    <p>These inputs belong to this local application. A second request keeps the current input active until you allow a transfer. Allow only the displayed input and surface.</p>
    {snapshot.remainingActivationAttempts === 0 ? <p role="status">Request limit reached. Release control, then close and restart controls to request again.</p> : null}
    <label htmlFor={`${id}-source`}>Input requesting control</label>
    <select id={`${id}-source`} value={selected} disabled={snapshot.closed} onChange={event => setSelected(event.target.value)}
      style={{ ...button, color: 'var(--paper)', background: 'var(--ink)', border: '1px solid var(--line)', padding: 'var(--space-xs)', maxWidth: '100%' }}>
      {snapshot.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
    </select>
    {snapshot.slots.map((slot, index) => <section key={slot.id} aria-labelledby={`${id}-slot-${index}`} data-testid={`ownership-slot-${slot.id}`}
      style={{ border: '1px solid var(--line)', padding: 'var(--space-sm)', marginBlock: 'var(--space-sm)', minWidth: 0 }}>
      <h3 id={`${id}-slot-${index}`}>{slot.id === 'exclusive' ? snapshot.destination : `${snapshot.destination} · ${slot.id}`}</h3>
      <p data-testid={`ownership-owner-${slot.id}`}>Current input: <strong>{slot.owner ? label(slot.owner.sourceId) : 'None'}</strong></p>
      <p role="status" aria-live="polite">{messages[slot.outcome]}</p>
      {slot.request ? <>
        <p>Requested input: <strong>{label(slot.request.sourceId)}</strong>. Position and contact only, for at most one minute.</p>
        <div style={row}>
          <button id={`${id}-allow-${index}`} className="outline-button" style={button} disabled={snapshot.remainingActivationAttempts === 0} onClick={() => {
            focus.current = `${id}-request-${index}`; controller.decide(slot.request!.id, slot.request!.expectedOwnerEpoch, true);
          }}>
            {slot.owner ? `Allow transfer to ${label(slot.request.sourceId)}` : `Allow ${label(slot.request.sourceId)}`}</button>
          <button className="outline-button" style={button} onClick={() => { focus.current = `${id}-request-${index}`; controller.decide(slot.request!.id, slot.request!.expectedOwnerEpoch, false); }}>Decline request</button>
          <button className="outline-button" style={button} onClick={() => { focus.current = `${id}-request-${index}`; controller.cancel(slot.request!.id); }}>Cancel request</button>
        </div>
      </> : null}
      <button id={`${id}-request-${index}`} className="outline-button" style={button} disabled={snapshot.closed || snapshot.remainingActivationAttempts === 0 || !!slot.request || slot.owner?.sourceId === selected}
        onClick={() => { focus.current = `${id}-allow-${index}`; controller.request(selected, slot.id); }}>{slot.state === 'failed' ? 'Request again' : `Request control of ${slot.id === 'exclusive' ? 'surface' : slot.id}`}</button>
      <button id={`${id}-request-${index}-release`} className="outline-button" style={{ ...button, marginInlineStart: 'var(--space-xs)' }} disabled={!slot.owner || snapshot.closed}
        onClick={() => { if (slot.owner) controller.release(slot.id, slot.owner.epoch); }}>Release {slot.id === 'exclusive' ? 'control' : slot.id}</button>
    </section>)}
  </section>;
}
