'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createLocalGamepadTask } from './gamepad-task';
import type { GamepadTaskReason, GamepadTaskSnapshot, LocalGamepadTask } from './gamepad-task';
import styles from '../resources/resource-task.module.css';

const initial: GamepadTaskSnapshot = Object.freeze({ phase: 'idle', reason: 'idle', choices: [], axes: [], buttons: [],
  runs: 0, actions: 0, cleanupUnconfirmed: false, owned: Object.freeze({ providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 }) });
const messages: Record<GamepadTaskReason, string> = {
  idle: 'Nothing is reading gamepad input. Find a gamepad when you are ready.',
  permission: 'Review the selected gamepad and allow each part before starting.',
  waiting: 'Waiting for a current reading. Keep this page in focus, or Stop to finish.',
  active: 'The selected gamepad is showing input on this page.',
  invalid: 'This choice is no longer valid. Stop and find gamepads again.',
  unsupported: 'This browser cannot read these gamepad inputs. You can return or try another browser.',
  unavailable: 'No usable gamepad was reported. Connect a gamepad, press one of its buttons while this page is in focus, then Stop and find again.',
  denied: 'Gamepad access was blocked. Check browser permission or restrictions, then choose Find gamepads again. You can also return to Connections.',
  busy: 'Earlier work is still finishing. Wait before finding another gamepad.',
  closed: 'Gamepad access is closed.',
  lost: 'The selected gamepad disconnected or changed. Find it again and review fresh permissions.',
  hidden: 'Input stopped when this page was hidden. Find and review again to continue.',
  unfocused: 'Input stopped when this page lost focus. Find and review again to continue.',
  expired: 'The permission window ended. Find and review again to continue.',
  stopped: 'Input stopped and displayed readings cleared. Find and review again to continue.',
  cancelled: 'The request ended before input could start. Stop and find again.',
  quota: 'This page reached its attempt limit. Reload before trying again.',
  'cleanup-unconfirmed': 'Access stopped, but cleanup could not be confirmed. Reload before trying again.',
};

export default function GamepadView() {
  const [snapshot, setSnapshot] = useState<GamepadTaskSnapshot>(initial), [ready, setReady] = useState(false);
  const current = useRef<LocalGamepadTask | undefined>(undefined), lifetime = useRef({ epoch: 0 });
  const findButton = useRef<HTMLButtonElement>(null), reviewTitle = useRef<HTMLHeadingElement>(null), status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const life = lifetime.current, epoch = ++life.epoch, owner = new AbortController();
    const installed = createLocalGamepadTask({ owner: owner.signal, now: () => performance.now(),
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: token => window.clearTimeout(token as number),
      onChange() {
        if (life.epoch === epoch && current.current === installed && !owner.signal.aborted) {
          const next = installed.snapshot();
          setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        }
      } });
    current.current = installed;
    queueMicrotask(() => { if (life.epoch === epoch && !owner.signal.aborted) setReady(true); });
    const hidden = () => { if (document.hidden) installed.stop('hidden'); };
    const blur = () => installed.stop('unfocused'), leave = () => installed.stop();
    document.addEventListener('visibilitychange', hidden); window.addEventListener('blur', blur); window.addEventListener('pagehide', leave);
    return () => {
      life.epoch++; current.current = undefined;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', leave);
      owner.abort(); installed.close();
    };
  }, []);
  const handle = snapshot.review?.handle;
  useEffect(() => { if (handle) reviewTitle.current?.focus(); }, [handle]);
  useEffect(() => { if (snapshot.phase === 'stopped' || snapshot.phase === 'closed') status.current?.focus(); }, [snapshot.phase]);
  const stop = () => { current.current?.stop(); findButton.current?.focus(); };
  const unavailable = !ready || snapshot.cleanupUnconfirmed || snapshot.phase === 'closed' || snapshot.actions >= 64;
  const finding = snapshot.owned.providers === 0 && !snapshot.review;
  const reading = snapshot.phase === 'active';
  const statusText = snapshot.actions >= 64 && !reading ? messages.quota : snapshot.phase === 'available'
    ? snapshot.choices.length ? 'Choose a reported gamepad. No input is reading yet.' : messages.unavailable
    : messages[snapshot.reason];
  return <main className={styles.page} data-gamepad-phase={snapshot.phase}>
    <Link href="#gamepad-readings" className={styles.skip}>Skip to gamepad readings</Link>
    <header><p><Link href="/connections">Back to Connections</Link></p><h1>Check a gamepad here</h1>
      <p>Choose a gamepad and see its reported buttons and axes on this page.</p></header>
    <p>Nothing reads input on arrival. This page uses only the gamepad you choose. Input is not saved, sent to another screen or used to control other apps.</p>
    <p>Access lasts up to ten seconds after you start. Leaving, hiding, losing focus or pressing Stop clears the readings. There is no automatic renewal.</p>
    <p ref={status} className={styles.status} role="status" aria-live="polite" tabIndex={-1}>{statusText}</p>
    <section className={styles.panel} aria-labelledby="gamepad-choice-title">
      <h2 id="gamepad-choice-title">Choose a gamepad</h2>
      <p>Connect a gamepad and press one of its buttons with this page in focus. The browser may need that press before it reports a gamepad.</p>
      <div className={styles.actions}>
        <button ref={findButton} disabled={unavailable || !finding || snapshot.runs >= 4} onClick={() => current.current?.inspect()}>Find gamepads</button>
        <button disabled={!ready || snapshot.owned.providers === 0 && !snapshot.review} onClick={stop}>Stop gamepad access</button>
      </div>
      {snapshot.runs >= 4 && finding && <p>The find limit for this page has been reached. Reload before finding again.</p>}
      {snapshot.owned.providers > 0 && !!snapshot.choices.length && <div className={styles.choices}>{snapshot.choices.map(choice => <section key={choice.index}>
        <h3>{choice.label}</h3><p>{choice.axes} reported axes; {choice.buttons} reported buttons.</p>
        <button disabled={unavailable || reading || !!snapshot.review} aria-pressed={snapshot.selected?.index === choice.index}
          onClick={() => current.current?.select(choice.index)}>Choose {choice.label}</button>
      </section>)}</div>}
      {snapshot.owned.providers > 0 && snapshot.selected && <p>Selected: {snapshot.selected.label}, with {snapshot.selected.axes} reported axes and {snapshot.selected.buttons} reported buttons.</p>}
      <div className={styles.actions}>
        <button disabled={unavailable || snapshot.owned.providers === 0 || !snapshot.selected || reading || !!snapshot.review} onClick={() => current.current?.review()}>Review local use</button>
      </div>
      {snapshot.review && snapshot.phase === 'review' && <section aria-labelledby="gamepad-review-title">
        <h2 id="gamepad-review-title" ref={reviewTitle} tabIndex={-1}>Allow this brief local use</h2>
        <p>Recipient: this page only. Read the selected gamepad, provide its reported inputs and display those inputs here for up to ten seconds. Review expires after five seconds; Stop and review again if needed.</p>
        <div className={styles.actions}>{(['capture', 'source', 'display'] as const).map(part => <button key={part}
          disabled={unavailable || snapshot.review?.[part]} onClick={() => { if (handle) current.current?.approve(handle, part); }}>
          {snapshot.review?.[part] ? 'Allowed: ' : 'Allow '}{part === 'capture' ? 'selected gamepad reading' : part === 'source' ? 'reported inputs' : 'display on this page'}
        </button>)}
          <button disabled={unavailable || !snapshot.review.capture || !snapshot.review.source || !snapshot.review.display}
            onClick={() => { if (handle) current.current?.start(handle); }}>Start local preview</button>
          <button onClick={stop}>Cancel review</button>
        </div>
      </section>}
    </section>
    <section id="gamepad-readings" className={styles.panel} aria-labelledby="gamepad-readings-title">
      <h2 id="gamepad-readings-title">Local gamepad readings</h2>
      <p>Axes show the values the browser reports. Button numbers describe their reported order; their physical names and layout may differ.</p>
      {(!reading || !snapshot.axes.length && !snapshot.buttons.length) && <p>No current gamepad readings are displayed.</p>}
      {reading && !!snapshot.axes.length && <div className={styles.outputs}>{snapshot.axes.map(axis => <div key={axis.label}>
        <p>{axis.label}</p><meter aria-label={axis.label} min={-1} max={1} value={axis.value} />
        <output aria-label={`${axis.label} value`}>{axis.value.toFixed(2)}</output>
      </div>)}</div>}
      {reading && !!snapshot.buttons.length && <div className={styles.outputs}>{snapshot.buttons.map(button => <div key={button.id}>
        <p>{button.label}</p><output aria-label={`${button.label} state`}>{!button.observed ? 'No change received' : button.pressed ? 'Pressed' : 'Released'}</output>
        {button.pressure !== undefined && <p>Value in last button report: {button.pressure.toFixed(2)}</p>}
      </div>)}</div>}
      <p>The first report can show a button already held. Button values belong to the last pressed or released report; they do not show continuous pressure or when a physical press began. Readings clear when they are no longer current; stopped input always needs fresh review.</p>
      <p>Use Tab and Enter or Space to operate this page. You can stop with the on-screen button or skip this preview.</p>
      <Link href="/connections" className={styles.skip}>Skip and return to Connections</Link>
    </section>
  </main>;
}
