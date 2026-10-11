'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createLocalCameraTask } from './camera-task';
import type { CameraAxis, CameraTaskReason, CameraTaskSnapshot, LocalCameraTask } from './camera-task';
import type { BrowserCameraFrame } from '@101/connect';
import styles from '../resources/resource-task.module.css';

const empty: CameraTaskSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', runs: 0, actions: 0, rawPending: 0, captureCallbacksPending: 0,
  cleanupUnconfirmed: false, choices: Object.freeze([]), controls: Object.freeze([]), controlState: 'idle', previewVisible: false,
  focusSupported: false, exposureSupported: false, owned: Object.freeze({ callers: 0, timers: 0 }) });
const labels: Record<CameraAxis, string> = { zoom: 'Zoom setting', pan: 'Pan setting', tilt: 'Tilt setting' };
const messages: Record<CameraTaskReason, string> = {
  idle: 'Nothing is running. List cameras only when you want to choose one.', choice: 'Choose one camera, then review how it may be used on this page.',
  review: 'Allow the selected camera, its preview frames and their display separately. Nothing starts until you press Start.',
  opening: 'Starting the local preview. You can stop while you wait.', active: 'The preview is local to this page. Stop whenever you are done.',
  stopped: 'Camera access stopped. List cameras and review fresh permissions to try again.', hidden: 'Camera access stopped when this page was hidden or lost focus. Review fresh permissions to retry.',
  revoked: 'Permission removed. Review a fresh choice to use the camera again.', closed: 'Camera access is closed.',
  denied: 'Camera use was not allowed. Check browser camera access, then list cameras and review a fresh choice.', invalid: 'Choose a number within the reported range and step.',
  busy: 'The previous work is still finishing. Wait before choosing again.', quota: 'This page reached its attempt limit. Stop, then reload before trying again.',
  expired: 'Permission expired. List cameras and review fresh permissions to start again.', lost: 'The selected camera or its preview ended. Stop, then review a fresh choice.',
  unsupported: 'This choice is not available in this browser. Choose another supported camera or setting.',
  unavailable: 'The selected camera could not start. Stop, then review a fresh choice or check browser permission.',
  cancelled: 'The request was cancelled. Wait for it to finish, then review a fresh choice.',
  'cleanup-unconfirmed': 'Access stopped, but cleanup could not be confirmed. Reload before trying again.',
};
function clear(canvas: HTMLCanvasElement | null) { canvas?.getContext('2d')?.clearRect(0, 0, 8, 8); }

export default function CameraView() {
  const [snapshot, setSnapshot] = useState<CameraTaskSnapshot>(empty), [choice, setChoice] = useState(''), [setting, setSetting] = useState(''),
    [error, setError] = useState<CameraTaskReason | undefined>(undefined);
  const current = useRef<LocalCameraTask | undefined>(undefined), canvas = useRef<HTMLCanvasElement>(null), inventoryButton = useRef<HTMLButtonElement>(null),
    captureTitle = useRef<HTMLHeadingElement>(null), settingTitle = useRef<HTMLHeadingElement>(null), status = useRef<HTMLParagraphElement>(null),
    generation = useRef({ epoch: 0 }), stopFocusPending = useRef(false);
  useEffect(() => {
    const lifetime = generation.current, epoch = ++lifetime.epoch, owner = new AbortController(), ownedCanvas = canvas.current;
    const owns = () => lifetime.epoch === epoch && current.current === installed && !owner.signal.aborted;
    const preview = (frame: BrowserCameraFrame | undefined) => {
      if (!owns()) return; const output = ownedCanvas; if (!output || canvas.current !== output) return;
      if (!frame) { clear(output); return; }
      const context = output.getContext('2d'); if (!context || !owns() || !installed.isPreviewCurrent()) { clear(output); return; }
      const bytes = new Uint8ClampedArray(256); let offset = 0;
      for (const row of frame.rows) for (const byte of row) bytes[offset++] = byte;
      const image = new ImageData(bytes, 8, 8);
      if (!owns() || !installed.isPreviewCurrent()) { clear(output); return; }
      context.putImageData(image, 0, 0);
      if (!owns() || !installed.isPreviewCurrent()) clear(output);
    };
    const installed = createLocalCameraTask({ owner: owner.signal, now: () => performance.now(),
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: token => window.clearTimeout(token as number),
      onPreview: preview, onChange() { if (owns()) setSnapshot(installed.snapshot()); } });
    current.current = installed;
    const background = () => { if (owns()) void installed.stop('hidden'); };
    const hidden = () => { if (document.hidden) background(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', background); window.addEventListener('blur', background);
    return () => {
      // Clear this exact output before retiring its display epoch. Late returns can
      // finish cleanup, but cannot paint or clear a replacement page's canvas.
      try { clear(ownedCanvas); } catch { /* A failed output clear must still retire camera access. */ }
      lifetime.epoch++; current.current = undefined;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', background); window.removeEventListener('blur', background);
      owner.abort(); void installed.close().then(() => {
        const final = installed.snapshot();
        window.dispatchEvent(new CustomEvent('101-local-camera-retired', { detail: Object.freeze({ phase: final.phase,
          rawPending: final.rawPending, captureCallbacksPending: final.captureCallbacksPending, cleanupUnconfirmed: final.cleanupUnconfirmed, owned: final.owned }) }));
      });
    };
  }, []);
  const captureHandle = snapshot.captureReview?.handle, controlHandle = snapshot.controlReview?.handle;
  useEffect(() => { if (captureHandle) captureTitle.current?.focus(); }, [captureHandle]);
  useEffect(() => { if (controlHandle) settingTitle.current?.focus(); }, [controlHandle]);
  useEffect(() => {
    if (!stopFocusPending.current || snapshot.phase !== 'stopped' || snapshot.rawPending > 0 || snapshot.owned.callers > 0) return;
    // Focus after the recovery action is enabled in the committed DOM.
    stopFocusPending.current = false;
    (snapshot.cleanupUnconfirmed ? status.current : inventoryButton.current)?.focus();
  }, [snapshot.phase, snapshot.rawPending, snapshot.owned.callers, snapshot.cleanupUnconfirmed]);
  const unavailable = snapshot.phase === 'closed' || snapshot.cleanupUnconfirmed || snapshot.rawPending > 0;
  const list = async () => {
    const installed = current.current; if (!installed) return; setError(undefined);
    const result = await installed.inventory(); if (current.current !== installed) return;
    if (result.ok) setChoice(String(result.value[0]?.ordinal ?? '')); else setError(result.reason);
    setSnapshot(installed.snapshot());
  };
  const review = () => {
    setError(undefined); const selected = snapshot.choices.find(item => String(item.ordinal) === choice);
    if (!selected) { setError('denied'); return; } const result = current.current?.reviewCapture(selected); if (result && !result.ok) setError(result.reason);
  };
  const start = async () => {
    const installed = current.current, review = snapshot.captureReview?.handle; if (!installed || !review) return;
    setError(undefined); const result = await installed.start(review); if (current.current !== installed) return;
    if (!result.ok) setError(result.reason); setSnapshot(installed.snapshot());
  };
  const stop = () => {
    const installed = current.current; if (!installed) return; stopFocusPending.current = true; setError(undefined); setSetting('');
    void installed.stop().then(() => { if (current.current === installed) setSnapshot(installed.snapshot()); });
  };
  const reviewSetting = (axis: CameraAxis) => {
    setError(undefined); const result = current.current?.reviewControl(axis);
    if (result?.ok) setSetting(String(result.value.facts.current)); else if (result) setError(result.reason);
  };
  const connectSetting = () => {
    const review = snapshot.controlReview?.handle; if (!review) return; setError(undefined);
    const result = current.current?.connectControl(review); if (result && !result.ok) setError(result.reason);
  };
  const changeSetting = () => {
    setError(undefined); if (setting.trim() === '') { setError('invalid'); return; }
    const result = current.current?.setSetting(Number(setting)); if (result && !result.ok) setError(result.reason);
  };
  const captureReview = snapshot.captureReview, controlReview = snapshot.controlReview;
  const statusText = snapshot.phase === 'stopping' ? 'Access stopped. Previously issued work is still finishing; a new choice is blocked until it returns.' :
    snapshot.phase === 'inventory' ? 'Listing cameras. No camera preview has started. You can stop.' :
      snapshot.phase === 'choice' && snapshot.choices.length === 0 ? 'No camera is available here. Check camera access in your browser settings, then use Stop camera access and list cameras again.' :
      snapshot.rawPending > 0 && snapshot.phase === 'active' ? 'The setting request is finishing. You can stop; an already sent request may still take effect.' : messages[error ?? snapshot.reason];
  return <main className={styles.page} data-camera-phase={snapshot.phase} data-camera-raw={snapshot.rawPending} data-camera-preview={snapshot.previewVisible}>
    <Link href="#camera-choice" className={styles.skip}>Skip to camera choice</Link>
    <header><p><Link href="/connections">Back to Connections</Link></p><h1>Camera on this page</h1>
      <p>Choose a camera, allow a local preview, and separately review any camera setting you want to use.</p></header>
    <p>Nothing opens on arrival. Each approved preview lasts at most 30 seconds, counted before the camera starts. Leaving, hiding or stopping this page ends access.</p>
    <p ref={status} className={styles.status} role="status" aria-live="polite" tabIndex={-1}>{statusText}</p>
    <section id="camera-choice" className={styles.panel} aria-labelledby="camera-choice-title">
      <h2 id="camera-choice-title">Choose one camera</h2>
      <button ref={inventoryButton} disabled={unavailable || snapshot.owned.callers > 0 || snapshot.phase === 'inventory' || snapshot.phase === 'opening' || snapshot.runs >= 4}
        onClick={() => void list()}>List cameras</button>
      <label>Camera<select value={choice} disabled={unavailable || snapshot.choices.length === 0 || snapshot.phase === 'active' || snapshot.phase === 'opening'} onChange={event => setChoice(event.currentTarget.value)}>
        <option value="">Choose a camera</option>{snapshot.choices.map(item => <option key={item.ordinal} value={String(item.ordinal)}>Camera {item.ordinal}</option>)}
      </select></label>
      <p>The list uses numbered choices. No preview starts when you change the choice. Stop first to refresh the list.</p>
      <div className={styles.actions}><button disabled={unavailable || !choice || snapshot.phase === 'active' || snapshot.phase === 'opening'} onClick={review}>Review selected camera</button>
        <button disabled={snapshot.phase === 'idle' || snapshot.phase === 'closed' || snapshot.phase === 'stopped'} onClick={stop}>Stop camera access</button></div>
    </section>
    {captureReview && snapshot.phase === 'review' && <section className={styles.panel} aria-labelledby="camera-review-title">
      <h2 id="camera-review-title" ref={captureTitle} tabIndex={-1}>Review Camera {captureReview.handle.ordinal}</h2>
      <p>Camera use, preview frames and their display need separate permissions. This page does not save or send your preview.</p>
      <div className={styles.actions}>{(['capture', 'source', 'preview'] as const).map(part => <button key={part} disabled={unavailable || captureReview[part]}
        onClick={() => { const result = current.current?.approveCapture(captureReview.handle, part); if (result && !result.ok) setError(result.reason); }}>
        {captureReview[part] ? 'Allowed: ' : 'Allow '}{part === 'capture' ? 'selected camera use' : part === 'source' ? 'preview frames' : 'preview display on this page'}</button>)}
        <button disabled={unavailable || !captureReview.capture || !captureReview.source || !captureReview.preview} onClick={() => void start()}>Start local preview</button>
        <button onClick={stop}>Cancel camera review</button></div>
    </section>}
    <section className={styles.panel} aria-labelledby="camera-preview-title">
      <h2 id="camera-preview-title">Local preview</h2>
      <figure><canvas ref={canvas} width={8} height={8} role="img" aria-label={snapshot.previewVisible ? 'Small current sample from the selected camera' : 'No current camera preview'}
        style={{ width: '16rem', maxWidth: '100%', imageRendering: 'pixelated' }} />
        <figcaption>This tiny 8×8 sample is scaled up. It is not a full-resolution view.</figcaption></figure>
      <p>{snapshot.previewVisible ? 'A current local sample is shown.' : 'No current preview is shown.'}</p>
      <button disabled={snapshot.phase !== 'active'} onClick={() => { const installed = current.current; if (installed) void installed.revokeCapture('preview'); }}>Remove preview permission</button>
    </section>
    <section className={styles.panel} aria-labelledby="camera-settings-title">
      <h2 id="camera-settings-title">Reported camera settings</h2>
      <p>Only settings reported by the selected camera are offered. A reported value does not confirm movement, an angle or magnification. Focus and exposure controls are not connected here.</p>
      {snapshot.phase !== 'active' && <p>Start an approved preview to see available settings.</p>}
      {snapshot.phase === 'active' && snapshot.controls.length === 0 && <p>No supported setting is reported for this choice. The preview can continue.</p>}
      <div className={styles.actions}>{snapshot.controls.map(item => <button key={item.axis} disabled={unavailable || !!snapshot.activeAxis} onClick={() => reviewSetting(item.axis)}>Review {labels[item.axis].toLowerCase()}</button>)}</div>
      <p>One setting can be enabled per preview. Stop and make a fresh camera choice to select another setting.</p>
      {controlReview && <section aria-labelledby="camera-setting-review-title">
        <h3 id="camera-setting-review-title" ref={settingTitle} tabIndex={-1}>Review {labels[controlReview.handle.axis].toLowerCase()}</h3>
        <p>Reported range: {controlReview.handle.facts.min} to {controlReview.handle.facts.max}, step {controlReview.handle.facts.step}. Reported starting value: {controlReview.handle.facts.current}.</p>
        {!snapshot.activeAxis && <div className={styles.actions}>{(['control', 'source', 'target'] as const).map(part => <button key={part} disabled={unavailable || controlReview[part]}
          onClick={() => { const result = current.current?.approveControl(controlReview.handle, part); if (result && !result.ok) setError(result.reason); }}>
          {controlReview[part] ? 'Allowed: ' : 'Allow '}{part === 'control' ? 'changing this setting' : part === 'source' ? 'commands from this page' : 'this setting to receive commands'}</button>)}
          <button disabled={unavailable || !controlReview.control || !controlReview.source || !controlReview.target} onClick={connectSetting}>Enable reviewed setting</button>
          <button onClick={stop}>Cancel setting review and stop</button></div>}
        <label>{labels[controlReview.handle.axis]}<input type="number" value={setting} min={controlReview.handle.facts.min} max={controlReview.handle.facts.max} step={controlReview.handle.facts.step}
          disabled={unavailable || snapshot.activeAxis !== controlReview.handle.axis} onChange={event => setSetting(event.currentTarget.value)} /></label>
        <button disabled={unavailable || snapshot.activeAxis !== controlReview.handle.axis} onClick={changeSetting}>Request reported setting</button>
        <p>{snapshot.reportedSetting === undefined ? 'No completed setting report is shown.' : `The camera reported setting ${snapshot.reportedSetting}. This does not confirm a physical effect.`}</p>
      </section>}
    </section>
  </main>;
}
