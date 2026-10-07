import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserGamepadEnvironment } from '@101/connect';

const api = await import('./gamepad-task.ts').catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
test('selected gamepad readings require a local task with separate capture, source and display review', () => {
  assert.equal(typeof api?.createLocalGamepadTask, 'function', 'Missing selected local gamepad task');
});

function pad(index = 1, axes = [0.25, -0.5], buttonCount = 2, pressed = false): NonNullable<ReturnType<NonNullable<BrowserGamepadEnvironment['getGamepads']>>[number]> {
  return { index, id: 'private-software-pad', connected: true, axes,
    buttons: Array.from({ length: buttonCount }, () => ({ pressed, value: pressed ? 0.75 : 0 })), timestamp: 17.5 };
}
function fixture(change: { missing?: boolean; read?: () => ReturnType<NonNullable<BrowserGamepadEnvironment['getGamepads']>>; clock?: () => number;
  notify?: () => void; cancelThrows?: boolean; removalThrows?: boolean; timerHook?: (run: () => void) => void } = {}) {
  let at = 100, next = 0, calls = 0, hidden = false, focused = true;
  const owner = new AbortController(), target = new EventTarget(), document = new EventTarget();
  const listeners = new Map<EventListenerOrEventListenerObject | null, string>();
  const pads: (ReturnType<typeof pad> | null)[] = [null, pad()];
  const frames = new Map<number, FrameRequestCallback>(), timers = new Map<number, { run: () => void; due: number; delay: number }>();
  const task = api!.createLocalGamepadTask({ owner: owner.signal, now: change.clock ?? (() => at), onChange: change.notify,
    setTimer(run, delay) { change.timerHook?.(run); const id = ++next; timers.set(id, { run, due: at + delay, delay }); return id; },
    clearTimer(token) { timers.delete(token as number); },
    environment: { ...(change.missing ? {} : { getGamepads() { calls++; return change.read ? change.read() : pads; } }),
      requestAnimationFrame(run) { const id = ++next; frames.set(id, run); return id; },
      cancelAnimationFrame(id) { if (change.cancelThrows) throw new Error('Private cancellation failure'); frames.delete(id); },
      target: { addEventListener(name, listener, flags) { listeners.set(listener, name); target.addEventListener(name, listener, flags); }, removeEventListener(name, listener) {
        if (change.removalThrows) throw new Error('Private removal failure'); listeners.delete(listener); target.removeEventListener(name, listener);
      } }, document, hidden: () => hidden, focused: () => focused } });
  function timer(delta?: number) {
    const entry = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (!entry) { if (delta !== undefined) at += delta; return; }
    timers.delete(entry[0]); at = delta === undefined ? entry[1].due : at + delta; entry[1].run();
  }
  function frame() { at += 20; const work = [...frames.values()]; frames.clear(); for (const run of work) run(at); timer(0); }
  function review() { assert.equal(task.inspect(), true); assert.equal(task.select(1), true); const handle = task.review(); assert.ok(handle); return handle; }
  function start() { const handle = review(); for (const part of ['capture', 'source', 'display'] as const) assert.equal(task.approve(handle, part), true); assert.equal(task.start(handle), true); return handle; }
  return { task, pads, owner, target, document, frames, timers, listeners, review, start, frame, timer,
    now: () => at, calls: () => calls, at(value: number) { at = value; },
    hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    blur() { focused = false; target.dispatchEvent(new Event('blur')); },
    disconnect() { const event = new Event('gamepaddisconnected'); Object.defineProperty(event, 'gamepad', { value: pad() }); target.dispatchEvent(event); },
    close() { task.close(); } };
}

test('construction is inert and inventory exposes only actual slots and counts', () => {
  const f = fixture(); try {
    assert.equal(f.calls(), 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.task.snapshot().owned, { providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 });
    f.pads[0] = pad(0, [1], 0); assert.equal(f.task.inspect(), true);
    assert.deepEqual(f.task.snapshot().choices, [{ index: 0, axes: 1, buttons: 0, label: 'Gamepad 1' }, { index: 1, axes: 2, buttons: 2, label: 'Gamepad 2' }]);
    assert.equal(f.frames.size, 0); assert.equal(JSON.stringify(f.task.snapshot()).includes('private-software-pad'), false);
  } finally { f.close(); }
});
for (const state of ['missing', 'empty', 'denied'] as const) test(`${state} inventory fails closed without capture or route resources`, () => {
  const f = fixture({ missing: state === 'missing', ...(state === 'denied' ? { read() { throw new DOMException('Private blocked browser', 'SecurityError'); } } : {}) });
  try { if (state === 'empty') f.pads.splice(0); assert.equal(f.task.inspect(), state === 'empty'); assert.equal(f.task.snapshot().reason, state === 'missing' ? 'unsupported' : state === 'denied' ? 'denied' : 'waiting'); assert.equal(f.frames.size, 0); assert.equal(f.task.snapshot().owned.routes, 0); }
  finally { f.close(); }
});

test('all three approvals belong to one opaque review and remain capture-free until approved start', () => {
  const f = fixture(); try {
    const handle = f.review(); assert.equal(f.task.start(handle), false); assert.equal(f.task.approve({ ...handle }, 'capture'), false);
    assert.equal(f.task.approve(handle, 'capture'), true); assert.equal(f.task.approve(handle, 'capture'), false);
    assert.equal(f.task.approve(handle, 'source'), true); assert.equal(f.task.start(handle), false); assert.equal(f.frames.size, 0);
    assert.equal(f.task.approve(handle, 'display'), true); assert.equal(f.task.start(handle), true); assert.equal(f.task.start(handle), false);
    assert.equal(f.task.snapshot().owned.routes, 2); assert.equal(f.task.snapshot().owned.sinks, 2);
  } finally { f.close(); }
});

test('review expires without capture and its old handle cannot approve a fresh selection', () => {
  const f = fixture(); try {
    const old = f.review(); f.at(old.expiresAt); assert.equal(f.task.approve(old, 'capture'), false); assert.equal(f.frames.size, 0);
    const fresh = f.review(); assert.notEqual(fresh, old); assert.equal(f.task.approve(old, 'capture'), false);
  } finally { f.close(); }
});
for (const replacement of ['id', 'axes', 'buttons', 'slot'] as const) test(`${replacement} replacement after review cannot silently use a new provider selection`, () => {
  const f = fixture(); try {
    const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p);
    f.pads[1] = replacement === 'id' ? { ...pad(), id: 'replacement-private-id' } : replacement === 'axes' ? pad(1, [0]) : replacement === 'buttons' ? pad(1, [0, 0], 3) : pad(0);
    assert.equal(f.task.start(handle), false); assert.equal(f.task.snapshot().reason, replacement === 'slot' ? 'unavailable' : 'lost'); assert.equal(f.frames.size, 0);
  } finally { f.close(); }
});

test('selected disconnect is detected during review and reconnection needs new review', () => {
  const f = fixture(); try {
    const handle = f.review(); f.disconnect(); f.timer(); assert.equal(f.task.snapshot().reason, 'lost'); assert.equal(f.task.approve(handle, 'capture'), false);
    assert.ok(f.review()); assert.equal(f.task.snapshot().review?.capture, false);
  } finally { f.close(); }
});

test('actual axes and reliable button edges reach local display and last pressure changes only on edges', () => {
  const f = fixture(); try {
    f.start(); f.pads[1] = pad(1, [0.5, -1], 2, true); f.frame(); f.timer();
    assert.deepEqual(f.task.snapshot().axes.map(v => v.value), [0.5, -1]); assert.ok(f.task.snapshot().buttons.every(v => v.pressed && v.pressure === 0.75 && v.observed));
    f.pads[1] = { ...pad(1, [0.5, -1], 2, true), buttons: [{ pressed: true, value: 0.25 }, { pressed: true, value: 0.25 }] }; f.frame();
    assert.ok(f.task.snapshot().buttons.every(v => v.pressure === 0.75));
    assert.equal(JSON.stringify(f.task.snapshot()).includes('provenance'), false);
  } finally { f.close(); }
});

test('one real maximum button burst drains before the genuine producer deadline', () => {
  const f = fixture(); try {
    f.pads[1] = pad(1, Array(16).fill(0.5), 32, false); f.start(); f.pads[1] = pad(1, Array(16).fill(0.5), 32, true); f.frame();
    const polled = f.now(); for (let i = 0; i < 34; i++) f.timer();
    assert.ok(f.now() - polled < 100); assert.equal(f.task.snapshot().phase, 'active'); assert.equal(f.task.snapshot().axes.length, 16);
    assert.equal(f.task.snapshot().buttons.filter(v => v.pressed).length, 32); assert.equal(f.timers.size, 1);
  } finally { f.close(); }
});

test('stale latest axes blank while real held state remains until a genuine edge or provider loss', () => {
  const f = fixture(); try { f.start(); f.pads[1] = pad(1, [1, 1], 2, true); f.frame(); f.timer(); f.timer(101);
    assert.deepEqual(f.task.snapshot().axes, []); assert.ok(f.task.snapshot().buttons.every(v => v.pressed && v.pressure === 0.75)); }
  finally { f.close(); }
});

for (const cause of ['stop', 'owner', 'close', 'hide', 'blur', 'disconnect'] as const) test(`${cause} clears readings and all logical owned resources`, () => {
  const f = fixture(); try { f.start(); f.pads[1] = pad(1, [1, 0], 2, true); f.frame(); f.timer();
    if (cause === 'stop') f.task.stop(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'close') f.close(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur(); else f.disconnect();
    if (!['stop', 'owner', 'close'].includes(cause)) f.timer();
    assert.deepEqual(f.task.snapshot().axes, []); assert.ok(f.task.snapshot().buttons.every(v => !v.pressed && v.pressure === undefined));
    assert.deepEqual(f.task.snapshot().owned, { providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 }); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test('review delay does not extend the original ten second active deadline', () => {
  const f = fixture(); try { const handle = f.review(); f.at(5000); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p);
    assert.equal(f.task.start(handle), true); f.at(14999); f.timer(0); assert.equal(f.task.snapshot().phase, 'active'); f.at(15000); f.timer(0);
    assert.equal(f.task.snapshot().reason, 'expired'); assert.equal(f.frames.size, 0); }
  finally { f.close(); }
});

test('clock and native read reentrancy fence late setup and start', () => {
  for (const cause of ['clock', 'read'] as const) {
    let armed = false; const f: ReturnType<typeof fixture> = fixture(cause === 'clock' ? { clock() { if (armed) f.task.stop(); return 100; } } : { read() { if (armed) f.task.stop(); return f.pads; } });
    try { const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p); armed = true;
      assert.equal(f.task.start(handle), false); assert.equal(f.frames.size, 0); assert.equal(f.task.snapshot().owned.runtimes, 0); }
    finally { f.close(); }
  }
});

test('observer close and throwing observer cannot resurrect reviewed or active resources', () => {
  for (const mode of ['close', 'throw'] as const) { let armed = false; const f: ReturnType<typeof fixture> = fixture({ notify() { if (!armed) return; if (mode === 'close') f.close(); else throw new Error('Private observer'); } });
    try { assert.equal(f.task.inspect(), true); assert.equal(f.task.select(1), true); armed = true; assert.equal(f.task.review(), undefined); assert.equal(f.frames.size, 0); assert.equal(f.task.snapshot().owned.runtimes, 0); }
    finally { f.close(); }
  }
});

test('cleanup uncertainty quarantines retries rather than claiming trusted native teardown', () => {
  for (const cause of ['cancel', 'remove'] as const) { const f = fixture({ cancelThrows: cause === 'cancel', removalThrows: cause === 'remove' });
    try { f.start(); f.task.stop(); assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.snapshot().reason, 'cleanup-unconfirmed'); assert.equal(f.task.inspect(), false); }
    finally { f.close(); }
  }
});

test('task limits runs, actions and timer callbacks without renewing authority', () => {
  const f = fixture(); try { for (let i = 0; i < 4; i++) { f.start(); f.task.stop(); } const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p);
    assert.equal(f.task.start(handle), false); assert.equal(f.task.snapshot().runs, 4); assert.equal(f.task.snapshot().reason, 'quota'); }
  finally { f.close(); }
  const g = fixture(); try { for (let i = 0; i < 65; i++) g.task.inspect(); assert.equal(g.task.snapshot().actions, 64); assert.equal(g.task.snapshot().reason, 'quota'); }
  finally { g.close(); }
});

test('clock-driven nested actions cannot bypass the action fence or create a second runtime', () => {
  let armed = false, nested = 0; const f: ReturnType<typeof fixture> = fixture({ clock() { if (armed) { armed = false; nested++; assert.equal(f.task.inspect(), false); assert.equal(f.task.review(), undefined); } return 100; } });
  try { const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p); armed = true;
    assert.equal(f.task.start(handle), true); assert.equal(nested, 1); assert.equal(f.task.snapshot().owned.runtimes, 1); }
  finally { f.close(); }
});

test('the actual permission expiry is fixed before a slow native return and closes every route', () => {
  let slow = false; const f: ReturnType<typeof fixture> = fixture({ read() { if (slow) { slow = false; f.at(f.now() + 2500); } return f.pads; } });
  try { const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p);
    const start = f.now(); slow = true; assert.equal(f.task.start(handle), true); assert.equal(f.now(), start + 2500);
    f.at(start + 9999); f.timer(0); assert.equal(f.task.snapshot().phase, 'active');
    f.at(start + 10000); f.timer(0); assert.equal(f.task.snapshot().reason, 'expired'); assert.equal(f.task.snapshot().owned.routes, 0); }
  finally { f.close(); }
});

test('late task and provider callbacks cannot revive an old run after recovery', () => {
  const f = fixture(); try { f.start(); const lateTimer = [...f.timers.values()][0]!.run, lateFrame = [...f.frames.values()][0]!;
    f.task.stop(); f.start(); lateTimer(); lateFrame(f.now()); assert.equal(f.task.snapshot().phase, 'active');
    assert.equal(f.task.snapshot().owned.runtimes, 1); assert.equal(f.timers.size, 1); assert.equal(f.frames.size, 1); assert.deepEqual(f.task.snapshot().axes, []); }
  finally { f.close(); }
});

test('synchronous timer ports and late installation after owner abort are fenced and cleaned', () => {
  for (const cause of ['sync', 'owner'] as const) {
    let armed = false; const f: ReturnType<typeof fixture> = fixture({ timerHook(run) { if (!armed) return; if (cause === 'sync') run(); else f.owner.abort(); } });
    try { assert.equal(f.task.inspect(), true); assert.equal(f.task.select(1), true); armed = true; assert.equal(f.task.review(), undefined);
      assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.task.snapshot().owned.providers, 0); }
    finally { f.close(); }
  }
});

test('finite timer budget covers all reviewed lifetimes rather than restarting with each review', () => {
  const f = fixture(); try { assert.equal(f.task.inspect(), true); assert.equal(f.task.select(1), true);
    for (let review = 0; review < 5; review++) { assert.ok(f.task.review()); for (let i = 0; i < 200; i++) f.timer(); }
    assert.equal(f.task.snapshot().reason, 'quota'); assert.equal(f.timers.size, 0);
    assert.equal(f.task.snapshot().owned.providers, 0); }
  finally { f.close(); }
});

test('invalid clocks and unsupported producer values fail closed without leaking native text', () => {
  for (const cause of ['rollback', 'throw', 'bad-axis'] as const) { let bad = false; const f: ReturnType<typeof fixture> = fixture(cause === 'bad-axis' ? {} : { clock() { if (bad && cause === 'throw') throw new Error('Private clock details'); return bad ? 99 : 100; } });
    try { f.start(); if (cause === 'bad-axis') f.pads[1] = pad(1, [2, 0]); else bad = true;
      f.frame(); f.timer(); assert.equal(f.task.snapshot().owned.routes, 0); assert.equal(f.frames.size, 0);
      assert.equal(JSON.stringify(f.task.snapshot()).includes('Private'), false); }
    finally { f.close(); }
  }
});

test('selecting a pad keeps capture and task timers inert while the player reads instructions', () => {
  const f = fixture(); try { assert.equal(f.task.inspect(), true); assert.equal(f.task.select(1), true);
    assert.equal(f.timers.size, 0, 'Selected instructions must not spend the finite timer budget'); assert.equal(f.frames.size, 0);
    f.at(30100); const review = f.task.review(); assert.ok(review); assert.equal(review.expiresAt, 35100); assert.equal(f.timers.size, 1); }
  finally { f.close(); }
});

test('observer inspect and select reentry during retirement cannot orphan a hidden provider', () => {
  let entered = false, innerInspect: boolean | undefined, innerSelect: boolean | undefined;
  const f: ReturnType<typeof fixture> = fixture({ notify() {
    if (entered) return; entered = true; innerInspect = f.task.inspect(); innerSelect = f.task.select(1);
  } });
  try { assert.equal(f.task.inspect(), true); assert.equal(entered, true); assert.equal(innerInspect, false); assert.equal(innerSelect, false);
    assert.equal(f.task.select(1), true); assert.ok(f.listeners.size > 0);
    f.task.stop(); assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.task.snapshot().owned, { providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 }); }
  finally { f.close(); }
});

test('approved start fixes its deadline before additional clock or provider callouts', () => {
  let clockAt = 100, advancing = false, first: number | undefined;
  const f = fixture({ clock() { const value = clockAt; if (advancing) { first ??= value; clockAt++; } return value; } });
  try { const handle = f.review(); for (const p of ['capture', 'source', 'display'] as const) f.task.approve(handle, p);
    advancing = true; assert.equal(f.task.start(handle), true); advancing = false; assert.ok(first !== undefined);
    clockAt = first + 10000; f.timer(0); assert.equal(f.task.snapshot().reason, 'expired'); assert.equal(f.task.snapshot().owned.routes, 0); }
  finally { f.close(); }
});

for (const boundary of ['stop', 'expiry'] as const) test(`retirement observer cannot reacquire access during ${boundary}`, () => {
  let armed = false, entered = false, innerInspect: boolean | undefined, innerSelect: boolean | undefined;
  const f: ReturnType<typeof fixture> = fixture({ notify() {
    if (!armed || entered) return;
    entered = true; innerInspect = f.task.inspect(); innerSelect = f.task.select(1);
  } });
  try {
    f.start(); const readsBefore = f.calls(); armed = true;
    if (boundary === 'stop') f.task.stop();
    else { f.at(10100); f.timer(0); }
    assert.equal(entered, true);
    assert.equal(innerInspect, false, 'Withdrawal must remain reserved through status notification');
    assert.equal(innerSelect, false);
    assert.equal(f.calls(), readsBefore, 'Status notification must not perform a new native inventory read');
    assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.task.snapshot().owned, { providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 });
  } finally { f.close(); }
});

test('owner close during withdrawal notification preserves closed status and cleared access', () => {
  let armed = false;
  const f: ReturnType<typeof fixture> = fixture({ notify() { if (armed) f.owner.abort(); } });
  try {
    f.start(); armed = true; f.task.stop();
    assert.equal(f.task.snapshot().phase, 'closed'); assert.equal(f.task.snapshot().reason, 'closed');
    assert.equal(f.listeners.size, 0); assert.equal(f.task.inspect(), false);
    assert.deepEqual(f.task.snapshot().owned, { providers: 0, runtimes: 0, routes: 0, sinks: 0, timers: 0 });
  } finally { f.close(); }
});

test('initial held state and subsequent release and press preserve actual button reports without continuous pressure', () => {
  const f = fixture();
  try {
    f.pads[1] = pad(1, [0, 0], 2, true); f.start(); f.frame(); f.timer();
    assert.ok(f.task.snapshot().buttons.every(button => button.observed && button.pressed && button.pressure === 0.75));
    f.pads[1] = { ...pad(1, [0, 0], 2, true), buttons: [{ pressed: true, value: 0.25 }, { pressed: true, value: 0.25 }] };
    f.frame(); f.timer();
    assert.ok(f.task.snapshot().buttons.every(button => button.pressed && button.pressure === 0.75));
    f.pads[1] = pad(1, [0, 0], 2, false); f.frame(); f.timer();
    assert.ok(f.task.snapshot().buttons.every(button => button.observed && !button.pressed && button.pressure === 0));
    f.pads[1] = { ...pad(1, [0, 0], 2, true), buttons: [{ pressed: true, value: 0.5 }, { pressed: true, value: 0.5 }] };
    f.frame(); f.timer();
    assert.ok(f.task.snapshot().buttons.every(button => button.observed && button.pressed && button.pressure === 0.5));
  } finally { f.close(); }
});
