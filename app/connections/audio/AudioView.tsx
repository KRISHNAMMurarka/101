'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createLocalAudioTask } from './audio-task';
import type { AudioTaskSnapshot, LocalAudioTask } from './audio-task';
import styles from '../resources/resource-task.module.css';

const initial: AudioTaskSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', muted: false, volume: 0.25,
  runs: 0, actions: 0, rawPending: 0, cleanupUnconfirmed: false,
  owned: Object.freeze({ producers: 0, providers: 0, runtimes: 0, sources: 0, outputs: 0, routes: 0, timers: 0 }) });
const messages: Readonly<Record<string, string>> = {
  idle: 'Sound is off. Review the tone, private connection and browser sound before starting.',
  permission: 'Allow each part of this sound setup separately, then choose Start tone.',
  opening: 'Preparing the approved tone. Stop is available while you wait.',
  active: 'The browser accepted this sound setup. Use volume, Mute or Stop below.',
  unsupported: 'This browser cannot make this sound setup. You can skip it or try another browser.',
  unavailable: 'Sound could not start. Stop and review a fresh setup, or return to Connections.',
  denied: 'Sound was blocked. Check your browser sound permission, then Stop and review again.',
  invalid: 'This review is no longer valid. Stop and review a fresh setup.',
  busy: 'Earlier sound work is still finishing. Wait before trying a fresh setup.',
  lost: 'The sound connection ended. Stop and review again to continue.',
  hidden: 'Sound stopped when this page was hidden. Review again to continue.',
  unfocused: 'Sound stopped when this page lost focus. Review again to continue.',
  expired: 'The time limit ended and sound stopped. Review again for a fresh setup.',
  stopped: 'Sound stopped. A fresh setup needs all three permissions again.',
  cancelled: 'The sound request ended before it could start. Review again to continue.',
  quota: 'This page reached its setup limit. Reload before trying again.',
  closed: 'Sound is closed.',
  'cleanup-unconfirmed': 'Sound stopped, but cleanup could not be confirmed. A fresh setup is unavailable here.',
};
const parts = ['source', 'route', 'output'] as const;
const reviews = {
  source: { title: 'Tone source', text: 'Allow this page to create one steady tone for this setup. It uses no microphone, recording or existing audio.', allow: 'Allow tone source', review: 'Review tone source' },
  route: { title: 'Private connection', text: 'Allow this page’s tone to reach only the local browser sound output for this setup. It is not shared with another screen.', allow: 'Allow private connection', review: 'Review private connection' },
  output: { title: 'Browser sound', text: 'Allow the approved tone to play through this browser’s current sound destination. This page does not choose a speaker or headphones.', allow: 'Allow browser sound', review: 'Review browser sound' },
};

export default function AudioView() {
  const [snapshot, setSnapshot] = useState<AudioTaskSnapshot>(initial), [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const task = useRef<LocalAudioTask | undefined>(undefined), audio = useRef<HTMLAudioElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null), status = useRef<HTMLParagraphElement>(null);
  const lifetime = useRef({ epoch: 0 });
  useEffect(() => {
    const life = lifetime.current, epoch = ++life.epoch, owner = new AbortController();
    let ownedElement: HTMLAudioElement | undefined;
    const installed = createLocalAudioTask({ owner: owner.signal, now: () => performance.now(),
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: token => window.clearTimeout(token as number),
      output: {
        play(stream) {
          const element = audio.current;
          if (!element) return Promise.reject(Error('unavailable'));
          ownedElement = element;
          element.srcObject = stream;
          return element.play();
        },
        clear() {
          const element = ownedElement;
          if (element) { try { element.pause(); } finally { element.srcObject = null; } ownedElement = undefined; }
        },
      },
      onChange() {
        if (life.epoch === epoch && task.current === installed && !owner.signal.aborted) {
          const next = installed.snapshot();
          setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        }
      },
    });
    task.current = installed;
    queueMicrotask(() => { if (life.epoch === epoch && !owner.signal.aborted) setReady(true); });
    const hidden = () => { if (document.hidden) void installed.stop('hidden'); };
    const blur = () => { void installed.stop('unfocused'); }, leave = () => { void installed.stop(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('blur', blur); window.addEventListener('pagehide', leave);
    return () => {
      life.epoch++; task.current = undefined;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', leave);
      owner.abort(); void installed.close().catch(() => {});
    };
  }, []);
  const handle = snapshot.review?.handle;
  useEffect(() => { if (handle) reviewTitle.current?.focus(); }, [handle]);
  useEffect(() => { if (snapshot.phase === 'stopped' || snapshot.phase === 'closed') status.current?.focus(); }, [snapshot.phase]);
  const work = (operation: (value: LocalAudioTask) => unknown) => {
    const value = task.current;
    if (!value) return;
    const life = lifetime.current, epoch = life.epoch;
    const failed = () => {
      if (life.epoch === epoch && task.current === value) setNotice('This sound setup could not continue. Stop and review again.');
      void value.stop().catch(() => {});
    };
    setNotice('');
    try { void Promise.resolve(operation(value)).catch(failed); }
    catch { failed(); }
  };
  const busy = snapshot.rawPending > 0 || snapshot.phase === 'opening' || snapshot.phase === 'settling';
  const unavailable = !ready || busy || snapshot.cleanupUnconfirmed || snapshot.phase === 'closed' || snapshot.actions >= 64;
  const active = snapshot.phase === 'active';
  const exhausted = snapshot.runs >= 4 && !snapshot.review;
  const approved = snapshot.review?.source && snapshot.review.route && snapshot.review.output;
  return <main className={styles.page} data-audio-phase={snapshot.phase}>
    <Link href="#audio-controls" className={styles.skip}>Skip to sound controls</Link>
    <header><p><Link href="/connections">Back to Connections</Link></p><h1>Try sound here</h1>
      <p>Review a steady tone made on this page, then try the browser’s current sound destination.</p></header>
    <p>No sound plays on arrival. The tone is not saved, recorded or shared with another screen.</p>
    <p>Each approved setup lasts up to ten seconds from Start, including preparation. Leaving or hiding this page stops it.</p>
    {/* eslint-disable-next-line jsx-a11y/media-has-caption -- The non-speech tone is described in text and has equivalent visible controls. */}
    <audio ref={audio} preload="none" aria-hidden="true" />
    <section className={styles.panel} aria-labelledby="audio-status-title">
      <h2 id="audio-status-title">Sound setup</h2>
      <p ref={status} className={styles.status} role="status" tabIndex={-1}>{busy && snapshot.phase !== 'opening'
        ? messages.busy : messages[snapshot.reason] ?? messages.unavailable}</p>
      {notice && <p role="alert">{notice}</p>}
      {snapshot.cleanupUnconfirmed && <p>Cleanup could not be confirmed. Keep sound stopped; this page cannot start a fresh setup.</p>}
      <div className={styles.actions}><button type="button" disabled={!ready} onClick={() => work(value => value.stop())}>Stop</button></div>
    </section>
    <section className={styles.panel} aria-labelledby="audio-permissions-title">
      <h2 id="audio-permissions-title">Review sound permissions</h2>
      <p>The tone source, its private connection and browser sound are separate choices. None starts sound on its own.</p>
      <div className={styles.actions}>{parts.map(part => <button type="button" key={part}
        disabled={unavailable || active || exhausted || !!snapshot.review?.[part]}
        onClick={() => work(value => { if (!value.snapshot().review) value.review(); else reviewTitle.current?.focus(); })}>{reviews[part].review}</button>)}</div>
      {snapshot.review && <div>
        <h3 ref={reviewTitle} tabIndex={-1}>Allow this local sound setup?</h3>
        <p>Review these choices within five seconds. Start uses the same review and all three approvals.</p>
        {parts.map(part => <div key={part}><h4>{reviews[part].title}</h4><p>{reviews[part].text}</p>
          <button type="button" disabled={unavailable || snapshot.review?.[part]} onClick={() => {
            const current = snapshot.review; if (current) work(value => value.approve(current.handle, part));
          }}>{snapshot.review?.[part] ? 'Allowed for this setup' : reviews[part].allow}</button></div>)}
        <button type="button" onClick={() => work(value => value.stop())}>Decline and stop</button>
      </div>}
    </section>
    <section id="audio-controls" className={styles.panel} aria-labelledby="audio-controls-title">
      <h2 id="audio-controls-title" tabIndex={-1}>Sound controls</h2>
      <p>Start plays only the approved page tone. Browser playback may be blocked; you can stop, review again or skip it.</p>
      <div className={styles.actions}><button type="button" disabled={unavailable || active || !approved}
        onClick={() => { const current = snapshot.review; if (current) work(value => value.start(current.handle)); }}>Start tone</button>
        <button type="button" disabled={unavailable || !active} aria-pressed={snapshot.muted}
          onClick={() => work(value => value.setMuted(!snapshot.muted))}>{snapshot.muted ? 'Unmute' : 'Mute'}</button></div>
      <label>Sound volume <input type="range" min={0} max={0.5} step={0.05} value={snapshot.volume}
        disabled={unavailable || !active} aria-valuetext={snapshot.volume === 0 ? 'Silent' : `${Math.round(snapshot.volume * 100)} out of 50`}
        onChange={event => work(value => value.setVolume(Number(event.target.value)))} /></label>
      <p>The page reports the browser request, without confirming what you hear. Use your device’s sound controls to change its current destination.</p>
      <p>Use Tab and Enter or Space for the buttons, and arrow keys for volume.</p>
      <Link href="/connections" className={styles.skip}>Skip and return to Connections</Link>
    </section>
  </main>;
}
