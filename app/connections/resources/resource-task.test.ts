import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalResourceTask, localResourceChoices, LOCAL_RESOURCE_LIMITS } from './resource-task.ts';
import type { LocalResourceReview, LocalResourceTask, LocalResourceTaskOptions } from './resource-task.ts';

// Software scheduling seam only. Routing/recipe/schema/authorization are the real public SDK.
function fixture(extra: Partial<LocalResourceTaskOptions> = {}) {
  let at = 0, next = 0;
  const owner = new AbortController(), timers = new Map<number, { at: number; run: () => void }>();
  const effects: { output: string; value: unknown }[] = [], released: string[] = [];
  const task = createLocalResourceTask({ owner: owner.signal, now: () => at,
    setTimer(run, delay) { const id = ++next; timers.set(id, { at: at + delay, run }); return id; },
    clearTimer(id) { timers.delete(id as number); },
    apply(output, observation) { effects.push({ output, value: observation.value }); },
    release(output) { released.push(output); }, ...extra });
  return { task, owner, effects, released, timers, setAt(value: number) { at = value; },
    advance(value: number) { at = value; const due = [...timers].filter(([, timer]) => timer.at <= at);
      for (const [id, timer] of due) { if (!timers.delete(id)) continue; timer.run(); } },
  };
}
function approved(task: LocalResourceTask, source = 'page-slider', output = 'page-meter') {
  const reviewed = task.review(source, output); assert.ok(reviewed.ok);
  assert.equal(task.approve(reviewed.value, 'source').ok, true);
  assert.equal(task.approve(reviewed.value, 'output').ok, true);
  return reviewed.value;
}
const send = (task: LocalResourceTask, value: unknown) => task.publish(task.snapshot().current?.handle ?? Object.freeze({}) as LocalResourceReview, value);

test('inert catalog and review allocate no live registrations or producer work', async () => {
  const h = fixture();
  try {
    assert.equal(localResourceChoices.sources.length, 3); assert.equal(localResourceChoices.outputs.length, 3);
    assert.equal(h.task.review('page-slider', 'page-meter').ok, true);
    assert.deepEqual(h.task.snapshot().owned, { registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0 });
    assert.equal(h.effects.length, 0); assert.equal(h.timers.size, 0);
  } finally { await h.task.close(); }
});

test('both independent approvals precede actual typed route effects', async () => {
  const h = fixture();
  try {
    const review = h.task.review('page-slider', 'page-number'); assert.ok(review.ok);
    assert.equal((await h.task.start(review.value)).ok, false);
    h.task.approve(review.value, 'source'); assert.equal((await h.task.start(review.value)).ok, false);
    assert.equal(h.effects.length, 0); assert.equal(h.task.snapshot().owned.registrations, 0);
    h.task.approve(review.value, 'output'); assert.equal((await h.task.start(review.value)).ok, true);
    assert.equal(send(h.task, 42).ok, true);
    assert.deepEqual(h.effects, [{ output: 'page-number', value: 42 }]);
    assert.equal(h.task.publish(Object.freeze({}) as LocalResourceReview, true).ok, false);
    assert.equal(send(h.task, 101).ok, false);
    h.task.stop(); assert.deepEqual(h.released, ['page-number']);
  } finally { await h.task.close(); }
});

test('incompatible, foreign and forged reviews cannot gain resource authority', async () => {
  const h = fixture(), other = fixture();
  try {
    assert.equal(h.task.review('page-toggle', 'page-meter').ok, false);
    assert.equal(h.task.review('__proto__', 'page-number').ok, false);
    const foreign = approved(other.task);
    assert.equal(h.task.approve(foreign, 'source').ok, false);
    assert.equal((await h.task.start(foreign)).ok, false);
    assert.equal((await h.task.start(Object.freeze({}) as typeof foreign)).ok, false);
    assert.equal(h.effects.length, 0);
  } finally { await h.task.close(); await other.task.close(); }
});

test('decline, cancellation and incompatible review preserve the exact incumbent', async () => {
  const h = fixture();
  try {
    const first = approved(h.task); await h.task.start(first); send(h.task, 21);
    const candidate = h.task.review('page-toggle', 'page-indicator'); assert.ok(candidate.ok);
    h.task.cancel(candidate.value);
    assert.equal(h.task.snapshot().current?.sourceId, 'page-slider'); assert.equal(h.released.length, 0);
    assert.equal(h.task.review('page-toggle', 'page-number').ok, false);
    const declined = h.task.review('page-ticks', 'page-number'); assert.ok(declined.ok);
    h.task.decline(declined.value); h.setAt(100); send(h.task, 22);
    assert.deepEqual(h.effects.map(value => value.value), [21, 22]); assert.equal(h.released.length, 0);
  } finally { await h.task.close(); }
});

test('explicit replacement releases old output before new activation and ignores old selection', async () => {
  const order: string[] = [], h = fixture({ apply(id) { order.push('apply:' + id); }, release(id) { order.push('release:' + id); } });
  try {
    await h.task.start(approved(h.task)); send(h.task, 30);
    await h.task.start(approved(h.task, 'page-toggle', 'page-indicator')); send(h.task, true);
    assert.deepEqual(order, ['apply:page-meter', 'release:page-meter', 'apply:page-indicator']);
    assert.equal(h.task.publish(Object.freeze({}) as LocalResourceReview, 90).ok, false);
  } finally { await h.task.close(); }
});

test('the actual recipe route lease reaches its approved absolute deadline without renewal', async () => {
  const h = fixture();
  try {
    await h.task.start(approved(h.task)); h.advance(2000);
    assert.equal(send(h.task, 5).ok, true);
    assert.equal(h.task.snapshot().state, 'active', 'RecipeSession default 1500ms must not truncate the reviewed task');
    h.advance(LOCAL_RESOURCE_LIMITS.lifetimeMs); assert.equal(h.task.snapshot().current, undefined);
    assert.deepEqual(h.released, ['page-meter']); assert.equal(h.timers.size, 0);
    assert.equal(send(h.task, 5).ok, false);
  } finally { await h.task.close(); }
});

test('actual owner signal revocation releases the held output and cannot replay a review', async () => {
  const h = fixture();
  try {
    const review = approved(h.task); await h.task.start(review); send(h.task, 60);
    h.owner.abort(); assert.equal(h.task.snapshot().current, undefined);
    assert.deepEqual(h.released, ['page-meter']); assert.equal((await h.task.start(review)).ok, false);
    assert.deepEqual(h.task.snapshot().owned, { registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0 });
  } finally { await h.task.close(); }
});

test('stop while the real RecipeSession awaits its consent microtask cannot dispatch late', async () => {
  const h = fixture();
  try {
    const pending = h.task.start(approved(h.task)); h.task.stop();
    assert.equal((await pending).ok, false); assert.equal(h.effects.length, 0);
    assert.equal(h.task.snapshot().rawPending, 0); assert.equal(h.task.snapshot().owned.registrations, 0);
  } finally { await h.task.close(); }
});

test('close inside a sink callout waits for genuinely held returned work', async () => {
  let finish!: () => void, closed = false, retained: Promise<void> | undefined;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const h = fixture({ apply() { retained = task.close(); void retained.then(() => { closed = true; }); return held; } }), task = h.task;
  try {
    await task.start(approved(task)); send(task, 2);
    await Promise.resolve(); assert.equal(closed, false); assert.equal(task.snapshot().rawPending, 1);
    finish(); await retained; assert.equal(closed, true); assert.equal(task.snapshot().rawPending, 0);
  } finally { finish(); await task.close(); }
});

test('reentrant clock owner-abort cannot install registrations after approval', async () => {
  let armed = false;
  const owner = new AbortController(); const h = fixture({ owner: owner.signal, now() { if (armed) owner.abort(); return 0; } }), task = h.task;
  try {
    const review = approved(task); armed = true; assert.equal((await task.start(review)).ok, false);
    assert.equal(task.snapshot().owned.registrations, 0); assert.equal(h.effects.length, 0);
  } finally { await task.close(); }
});

test('a timer factory that stops before returning leaves no owned late timer', async () => {
  let armed = false, next = 0;
  const native = new Map<number, () => void>();
  const h = fixture({ setTimer(run) { if (armed) task.stop(); const id = ++next; native.set(id, run); return id; }, clearTimer(id) { native.delete(id as number); } }), task = h.task;
  try {
    const review = approved(task); armed = true; assert.equal((await task.start(review)).ok, false);
    assert.equal(native.size, 0); assert.equal(task.snapshot().current, undefined);
  } finally { await task.close(); }
});

test('actual timer software observations are bounded and all timer work retires on stop', async () => {
  const h = fixture();
  try {
    await h.task.start(approved(h.task, 'page-ticks', 'page-number')); h.advance(100); h.advance(200);
    assert.deepEqual(h.effects.map(value => value.value), [1, 2]);
    h.task.stop(); h.advance(300); assert.equal(h.effects.length, 2); assert.equal(h.timers.size, 0);
    assert.equal(h.task.snapshot().owned.producerTimers, 0);
  } finally { await h.task.close(); }
});

test('rapid actual public publications coalesce the last value while preserving its original source stamp', async () => {
  const observed: { value: unknown; at: number; sequence: number }[] = [];
  const h = fixture({ apply(_output, observation) { observed.push({ value: observation.value, at: observation.timestamp, sequence: observation.sequence }); } });
  try {
    await h.task.start(approved(h.task)); send(h.task, 10);
    h.setAt(10); assert.equal(send(h.task, 20).ok, true);
    h.setAt(20); assert.equal(send(h.task, 30).ok, true);
    assert.deepEqual(observed.map(row => row.value), [10]); h.advance(100);
    assert.deepEqual(observed, [{ value: 10, at: 0, sequence: 1 }, { value: 30, at: 20, sequence: 3 }]);
    h.task.stop(); assert.equal(h.timers.size, 0);
  } finally { await h.task.close(); }
});

test('logical stop keeps an actual held delivery reserved and refuses a replacement until it settles', async () => {
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  const h = fixture({ apply() { return held; } });
  try {
    await h.task.start(approved(h.task)); send(h.task, 20); h.task.stop();
    assert.equal(h.task.snapshot().rawPending, 1);
    const next = approved(h.task, 'page-toggle', 'page-indicator'); assert.equal((await h.task.start(next)).ok, false);
    finish(); await held; await Promise.resolve(); assert.equal(h.task.snapshot().rawPending, 0);
    assert.equal((await h.task.start(next)).ok, true);
  } finally { finish(); await h.task.close(); }
});

test('an output-only approval and an expired review do not grant a source', async () => {
  const h = fixture();
  try {
    const review = h.task.review('page-toggle', 'page-indicator'); assert.ok(review.ok);
    h.task.approve(review.value, 'output'); assert.equal((await h.task.start(review.value)).ok, false);
    h.setAt(LOCAL_RESOURCE_LIMITS.lifetimeMs); assert.equal(h.task.approve(review.value, 'source').ok, false);
    assert.equal(h.effects.length, 0); assert.equal(h.task.snapshot().owned.registrations, 0);
  } finally { await h.task.close(); }
});

test('an old source epoch cannot borrow a fresh approval for the same selected source and output', async () => {
  const h = fixture();
  try {
    const old = approved(h.task); await h.task.start(old); h.task.stop();
    const current = approved(h.task); await h.task.start(current);
    assert.equal(h.task.publish(old, 77).ok, false); assert.equal(h.effects.length, 0);
    assert.equal(h.task.publish(current, 33).ok, true); assert.deepEqual(h.effects.map(row => row.value), [33]);
  } finally { await h.task.close(); }
});
