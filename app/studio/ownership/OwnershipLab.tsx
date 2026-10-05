'use client';

import { createInputOwnershipExample } from '@/examples/device-pipelines/input-ownership';
import InputOwnershipPanel from '@/app/components/InputOwnershipPanel';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ownership-lab.module.css';

type Example = ReturnType<typeof createInputOwnershipExample>;
type View = ReturnType<Example['state']>;
const arrows: Record<string, [number, number]> = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] };

export default function OwnershipLab() {
  const current = useRef<Example | undefined>(undefined);
  const captures = useRef(new Map<string, { element: HTMLDivElement; pointerId: number }>());
  const [example, setExample] = useState<Example>();
  const [view, setView] = useState<View>();
  const [partitioned, setPartitioned] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [restart, setRestart] = useState(0);
  const refresh = useCallback(() => { const active = current.current; if (active) setView(active.state()); }, []);
  const releaseCapture = useCallback((sourceId: string) => {
    const capture = captures.current.get(sourceId); captures.current.delete(sourceId);
    if (capture) try { if (capture.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId); } catch { /* Native capture was already lost. */ }
  }, []);
  useEffect(() => {
    let active = true, frame = 0;
    const next = createInputOwnershipExample({ partitioned, onChange() { if (active) refresh(); } });
    current.current = next;
    const init = window.setTimeout(() => { if (active) { setExample(next); setView(next.state()); setStopped(false); } }, 0);
    const tick = () => { if (!active) return; next.tick(); refresh(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    const interrupt = () => { for (const source of next.sources) releaseCapture(source.id); next.interrupt(); refresh(); };
    const hidden = () => { if (document.hidden) interrupt(); };
    window.addEventListener('blur', interrupt); window.addEventListener('pagehide', interrupt); document.addEventListener('visibilitychange', hidden);
    return () => {
      active = false; clearTimeout(init); cancelAnimationFrame(frame);
      window.removeEventListener('blur', interrupt); window.removeEventListener('pagehide', interrupt); document.removeEventListener('visibilitychange', hidden);
      for (const source of next.sources) releaseCapture(source.id);
      next.stop(); if (current.current === next) current.current = undefined;
    };
  }, [partitioned, refresh, releaseCapture, restart]);
  return <main className={styles.page} data-testid="ownership-lab">
    <header><Link href="/studio">101 Studio</Link><span>LOCAL INPUT OWNERSHIP</span></header>
    <h1>Keep control until you choose.</h1>
    <p>Try two browser inputs on an application surface. Review a request, decline it, transfer control, or use separate declared surfaces. This lab grants typed application input only; it does not move a system cursor or verify a remote person.</p>
    <label className={styles.mode}>Surface policy <select aria-label="Surface policy" value={partitioned ? 'partitioned' : 'exclusive'} onChange={event => {
      current.current?.stop(); setExample(undefined); setView(undefined); setPartitioned(event.target.value === 'partitioned');
    }}><option value="partitioned">Independent left and right</option><option value="exclusive">One shared surface</option></select></label>
    {example && view ? <>
      <InputOwnershipPanel controller={example.controller} />
      <section className={styles.sources} aria-label="Local input producers">
        {example.sources.map(source => <section key={source.id}>
          <h2>{source.label}</h2><p>Drag to move. Arrow keys move; Space holds contact; Escape releases. Buttons provide the same controls.</p>
          {/* A relative pad combines movement/contact; adjacent native buttons provide every keyboard action. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div className={styles.pad} role="group" aria-label={`${source.label} pad`} tabIndex={stopped ? -1 : 0}
            onPointerDown={event => { if (stopped || captures.current.has(source.id)) return; const rect = event.currentTarget.getBoundingClientRect();
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { source.driver.release(); return; }
              captures.current.set(source.id, { element: event.currentTarget, pointerId: event.pointerId });
              source.driver.begin(event.pointerId, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height); refresh(); }}
            onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); source.driver.move(event.pointerId, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height); }}
            onPointerUp={event => { source.driver.end(event.pointerId); if (captures.current.get(source.id)?.pointerId === event.pointerId) releaseCapture(source.id); refresh(); }}
            onPointerCancel={event => { source.driver.end(event.pointerId); if (captures.current.get(source.id)?.pointerId === event.pointerId) releaseCapture(source.id); refresh(); }}
            onLostPointerCapture={event => { source.driver.end(event.pointerId); if (captures.current.get(source.id)?.pointerId === event.pointerId) captures.current.delete(source.id); refresh(); }}
            onBlur={() => { releaseCapture(source.id); source.driver.release(); refresh(); }}
            onKeyDown={event => {
              const direction = arrows[event.key]; if (direction) { event.preventDefault(); source.driver.nudge(...direction); }
              else if (event.key === ' ' || event.key === 'Escape') { event.preventDefault(); if (event.key === 'Escape') source.driver.release(); else source.driver.setContact(true); } refresh();
            }} onKeyUp={event => { if (event.key === ' ') { event.preventDefault(); source.driver.setContact(false); refresh(); } }}>Drag or use arrow keys</div>
          <div className={styles.buttons}>
            {Object.entries(arrows).map(([key, direction]) => <button className="outline-button" key={key} disabled={stopped} onClick={() => { source.driver.nudge(...direction); refresh(); }}>{source.label} {key.slice(5).toLowerCase()}</button>)}
            <button className="outline-button" disabled={stopped} aria-pressed={source.driver.state().contact} onClick={() => { source.driver.setContact(!source.driver.state().contact); refresh(); }}>{source.label} contact</button>
          </div>
        </section>)}
      </section>
      <section className={styles.surfaces} aria-label="Application outputs">
        {view.surfaces.map(surface => <div key={surface.id} className={styles.surface} role="img" aria-label={`Application surface ${surface.id}`}
          data-testid={`application-surface-${surface.id}`} data-contact={surface.contact} data-x={surface.position?.x ?? ''} data-y={surface.position?.y ?? ''}>
          <span>{surface.id} · {surface.contact ? 'contact held' : 'contact released'}</span>
          {surface.position ? <i className={styles.marker} style={{ left: `${surface.position.x * 100}%`, top: `${surface.position.y * 100}%` }} /> : <b>No active input</b>}
        </div>)}
      </section>
      <div className={styles.buttons}>
        <button className="outline-button" disabled={stopped} aria-pressed={!view.grantsEnabled} onClick={() => example.setGrantsEnabled(!view.grantsEnabled)}>Deny new host grants</button>
        <button className="outline-button" disabled={stopped} onClick={() => { for (const source of example.sources) releaseCapture(source.id); example.interrupt(); }}>Release all and cancel requests</button>
        <button className="outline-button" disabled={stopped} onClick={() => { for (const source of example.sources) releaseCapture(source.id); example.stop(); setStopped(true); refresh(); }}>Close controls</button>
        {stopped ? <button className="outline-button" onClick={() => { setExample(undefined); setView(undefined); setRestart(value => value + 1); }}>Restart controls</button> : null}
      </div>
      <p role="status" aria-label="Local delivery counters">Grants: {view.grants} · queue admissions: {view.accepted} · observed frames: {view.frames} · releases: {view.releases}</p>
    </> : <p role="status">Preparing local controls…</p>}
  </main>;
}
