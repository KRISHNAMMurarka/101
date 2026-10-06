'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createLocalResourceTask, localResourceChoices, localResourcesCompatible } from './resource-task';
import type { LocalResourceReview, LocalResourceTask, LocalResourceTaskSnapshot } from './resource-task';
import styles from './resource-task.module.css';

const empty: LocalResourceTaskSnapshot = Object.freeze({ state: 'idle', reason: 'idle', rawPending: 0,
  startPending: false, attempts: 0, publications: 0, deliveries: 0, cleanupUnconfirmed: false,
  owned: Object.freeze({ registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0 }) });
const text: Record<string, string> = {
  idle: 'Choose an input and a compatible output. Nothing is running yet.',
  'review-ready': 'Review this choice, then allow the input and output separately.',
  'approval-ready': 'Your choice is ready once both sides are allowed. Start when you are ready.',
  active: 'Connected on this page. Use the selected control below.',
  cancelled: 'Review cancelled. A current connection stays running.', declined: 'Choice declined. A current connection stays running.',
  incompatible: 'Those controls do not share a supported value. Choose a compatible output.',
  expired: 'Connection permission expired. Choose and allow both sides again.',
  'review-expired': 'This review expired. Review a fresh choice and allow both sides again.',
  stopped: 'Connection stopped and its output released. Review a fresh choice to start again.',
  revoked: 'Permission removed. Its output is released. Review a fresh choice to start again.',
  hidden: 'Connection stopped when this page was hidden. Review a fresh choice to start again.',
  'connection-lost': 'The connection ended. Review a fresh choice to retry.',
  'output-unavailable': 'The selected output could not continue. Review a fresh choice to retry.',
  'invalid-clock': 'This connection could not stay current. Reload before starting again.',
  'owner-revoked': 'This page no longer owns the connection. Reload to start again.',
  'cleanup-unconfirmed': 'Access stopped, but cleanup could not be confirmed. Reload before starting again.',
  quota: 'This page reached its attempt limit. Stop, then reload to make another choice.',
  busy: 'The previous task is still finishing. Wait before choosing again.',
  denied: 'Allow both the selected input and output before starting.', unavailable: 'The connection could not start. Review a fresh choice to retry.',
  cancelledStart: 'The start was cancelled. Review a fresh choice to retry.', closed: 'Connection closed.',
};
const label = (id: string) => [...localResourceChoices.sources, ...localResourceChoices.outputs].find(item => item.id === id)?.label ?? 'Page control';

export default function ResourceTaskView() {
  const [snapshot, setSnapshot] = useState<LocalResourceTaskSnapshot>(empty), [sourceId, setSourceId] = useState('page-slider'),
    [outputId, setOutputId] = useState('page-meter'), [slider, setSlider] = useState(50), [toggle, setToggle] = useState(false),
    [error, setError] = useState(''), [ready, setReady] = useState(false);
  const controller = useRef<LocalResourceTask | undefined>(undefined), generation = useRef(0), reviewButton = useRef<HTMLButtonElement>(null),
    reviewTitle = useRef<HTMLHeadingElement>(null), activeTitle = useRef<HTMLHeadingElement>(null), returnFocus = useRef(false);
  const meter = useRef<HTMLMeterElement>(null), number = useRef<HTMLOutputElement>(null), indicator = useRef<HTMLOutputElement>(null);
  const lastReview = useRef(snapshot.candidate?.handle), lastCurrent = useRef<LocalResourceReview | undefined>(undefined);
  useEffect(() => {
    const turn = ++generation.current, owner = new AbortController();
    const owns = () => generation.current === turn && controller.current === installed && !owner.signal.aborted;
    const installed = createLocalResourceTask({ owner: owner.signal, now: () => performance.now(),
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: handle => window.clearTimeout(handle as number),
      apply(id, observation, context) {
        if (!owns() || context.signal.aborted || !context.isCurrent() || !owns()) return;
        if (id === 'page-meter' && meter.current) { meter.current.value = observation.value as number; meter.current.dataset.receiving = 'true'; }
        if (id === 'page-number' && number.current) { number.current.value = String(observation.value); number.current.dataset.receiving = 'true'; }
        if (id === 'page-indicator' && indicator.current) { indicator.current.value = observation.value ? 'On' : 'Off'; indicator.current.dataset.receiving = 'true'; }
      },
      release(id) {
        if (id === 'page-meter' && meter.current) { meter.current.value = 0; meter.current.dataset.receiving = 'false'; }
        if (id === 'page-number' && number.current) { number.current.value = 'Waiting'; number.current.dataset.receiving = 'false'; }
        if (id === 'page-indicator' && indicator.current) { indicator.current.value = 'Waiting'; indicator.current.dataset.receiving = 'false'; }
      },
      onChange(value) { if (owns()) setSnapshot(value); },
    });
    controller.current = installed; setSnapshot(installed.snapshot()); setReady(true);
    const stop = () => { if (owns()) { returnFocus.current = true; installed.stop('hidden'); setToggle(false); } };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', stop); window.addEventListener('blur', stop);
    return () => {
      // Fence status callbacks before closing, while display release still owns its exact elements.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++; controller.current = undefined;
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', stop); window.removeEventListener('blur', stop);
      owner.abort(); void installed.close().then(() => {
        const retired = installed.snapshot();
        // Redacted lifecycle readback for owned page observers; no handle, value, identity, or authority is emitted.
        window.dispatchEvent(new CustomEvent('101-local-resource-retired', { detail: Object.freeze({ state: retired.state,
          rawPending: retired.rawPending, startPending: retired.startPending, owned: retired.owned,
          cleanupUnconfirmed: retired.cleanupUnconfirmed }) }));
      });
    };
  }, []);
  useEffect(() => {
    if (snapshot.candidate?.handle !== lastReview.current) {
      lastReview.current = snapshot.candidate?.handle;
      if (snapshot.candidate) { returnFocus.current = false; reviewTitle.current?.focus(); }
    }
    const currentHandle = snapshot.current?.handle;
    if (currentHandle !== lastCurrent.current) {
      const previous = lastCurrent.current; lastCurrent.current = currentHandle;
      if (currentHandle) { returnFocus.current = false; activeTitle.current?.focus(); }
      else if (previous) { setToggle(false); if (document.activeElement === document.body) returnFocus.current = true; }
    }
    if (returnFocus.current && !snapshot.candidate && !snapshot.startPending && snapshot.rawPending === 0) {
      returnFocus.current = false; reviewButton.current?.focus();
    }
  }, [snapshot]);
  const compatible = localResourcesCompatible(sourceId, outputId);
  const unavailable = snapshot.startPending || snapshot.rawPending > 0 || snapshot.cleanupUnconfirmed || snapshot.state === 'closed' || snapshot.state === 'closing';
  const review = () => { setError(''); const result = controller.current?.review(sourceId, outputId); if (result && !result.ok) setError(result.reason); };
  const start = async () => {
    const candidate = snapshot.candidate, installed = controller.current; if (!candidate || !installed) return;
    setError(''); const result = await installed.start(candidate.handle);
    if (controller.current === installed && !result.ok) setError(result.reason === 'cancelled' ? 'cancelledStart' : result.reason);
  };
  const cancel = (decline: boolean) => {
    const candidate = snapshot.candidate; if (!candidate) return; returnFocus.current = true;
    if (decline) controller.current?.decline(candidate.handle); else controller.current?.cancel(candidate.handle);
    setError('');
  };
  const stop = () => { returnFocus.current = true; controller.current?.stop(); setToggle(false); setError(''); };
  const status = snapshot.startPending ? 'Connecting this choice… You can stop.' : snapshot.rawPending && !snapshot.current ?
    'Access stopped. The last output operation is still finishing.' : text[error || snapshot.reason] ?? 'Review a fresh choice to continue.';
  return <main className={styles.page} data-resource-task-state={snapshot.state} data-resource-task-raw={snapshot.rawPending}
    data-resource-task-registrations={snapshot.owned.registrations} data-resource-task-routes={snapshot.owned.routes}
    data-resource-task-timers={snapshot.owned.producerTimers + snapshot.owned.expiryTimers} data-resource-task-deliveries={snapshot.deliveries}>
    <Link href="#resource-choice" className={styles.skip}>Skip to control choice</Link>
    <header><p><Link href="/connections">Connections</Link></p><h1>Connect page controls</h1>
      <p>Choose an input and where it can act. Allow both sides, use them, and stop when you are done.</p></header>
    <p>These controls run on this page. They do not connect to nearby equipment. Each approved choice stops after at most 30 seconds.</p>
    <section id="resource-choice" className={styles.panel} aria-labelledby="resource-choice-title" tabIndex={-1}>
      <h2 id="resource-choice-title">Choose input and output</h2>
      <div className={styles.choices}><label>Page input<select value={sourceId} onChange={event => setSourceId(event.currentTarget.value)}>
        {localResourceChoices.sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label><label>Page output<select value={outputId} onChange={event => setOutputId(event.currentTarget.value)}>
        {localResourceChoices.outputs.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label></div>
      <p>{compatible ? 'These choices share a supported value.' : 'These choices cannot connect. Choose a matching number or switch output.'}</p>
      <p>Number controls can use the meter or number readout. Switch controls use the switch readout. Other device formats and actions are not connected here.</p>
      <button ref={reviewButton} onClick={review} disabled={!ready || !compatible || unavailable}>Review selected connection</button>
    </section>
    <p className={styles.status} role="status" aria-live="polite" data-resource-task-reason={snapshot.reason}>{status}</p>
    {snapshot.candidate && <section className={styles.panel} aria-labelledby="resource-review-title">
      <h2 id="resource-review-title" ref={reviewTitle} tabIndex={-1}>Review selected connection</h2>
      <p>{label(snapshot.candidate.sourceId)} → {label(snapshot.candidate.outputId)}</p>
      <p>Allowing the input does not allow an output. Both choices apply only to this connection and expire together.</p>
      <div className={styles.actions}>
        <button disabled={snapshot.candidate.sourceApproved || unavailable} onClick={() => controller.current?.approve(snapshot.candidate!.handle, 'source')}>{snapshot.candidate.sourceApproved ? 'Input allowed' : 'Allow selected input'}</button>
        <button disabled={snapshot.candidate.outputApproved || unavailable} onClick={() => controller.current?.approve(snapshot.candidate!.handle, 'output')}>{snapshot.candidate.outputApproved ? 'Output allowed' : 'Allow selected output'}</button>
        <button disabled={!snapshot.candidate.sourceApproved || !snapshot.candidate.outputApproved || unavailable} onClick={() => void start()}>{snapshot.current ? 'Replace current connection' : 'Start selected connection'}</button>
        <button onClick={() => cancel(false)}>Cancel review</button><button onClick={() => cancel(true)}>Decline choice</button>
      </div>
      {snapshot.current && <p>The current connection stays running during this review. Replacement first stops and releases its output.</p>}
    </section>}
    <section className={styles.panel} aria-labelledby="resource-active-title">
      <h2 id="resource-active-title" ref={activeTitle} tabIndex={-1}>Use page controls</h2>
      <p>{snapshot.current ? `${label(snapshot.current.sourceId)} is connected to ${label(snapshot.current.outputId)}.` : 'No page control is connected.'}</p>
      <label>Page slider value<input type="range" min={0} max={100} step={1} value={slider} disabled={snapshot.current?.sourceId !== 'page-slider'}
        onChange={event => { const value = event.currentTarget.valueAsNumber; setSlider(value);
          if (snapshot.current?.sourceId === 'page-slider') controller.current?.publish(snapshot.current.handle, value); }} /></label>
      <button aria-pressed={toggle} disabled={snapshot.current?.sourceId !== 'page-toggle'} onClick={() => { const value = !toggle; setToggle(value);
        if (snapshot.current?.sourceId === 'page-toggle') controller.current?.publish(snapshot.current.handle, value); }}>Toggle page switch</button>
      <p>The page timer counts actual timer callbacks from 0 to 100, then wraps. It is not a sensor or an elapsed-time measurement.</p>
      <div className={styles.outputs}>
        <label>Page meter<meter ref={meter} min={0} max={100} data-receiving="false" aria-label="Connected page meter" /></label>
        <label>Number readout<output ref={number} aria-label="Connected number readout" data-receiving="false">Waiting</output></label>
        <label>Switch readout<output ref={indicator} aria-label="Connected switch readout" data-receiving="false">Waiting</output></label>
      </div>
      {(snapshot.current || snapshot.startPending) && <div className={styles.actions}><button onClick={stop}>Stop connection</button>
        {snapshot.current && <><button onClick={() => { returnFocus.current = true; controller.current?.revoke('source'); setToggle(false); }}>Remove input permission</button>
          <button onClick={() => { returnFocus.current = true; controller.current?.revoke('output'); setToggle(false); }}>Remove output permission</button></>}</div>}
      <p>Changing selection does not change an active connection. Stop or explicitly approve a replacement. Leaving or hiding this page stops it.</p>
    </section>
  </main>;
}
