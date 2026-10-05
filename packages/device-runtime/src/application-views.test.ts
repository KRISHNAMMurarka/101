import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationViews } from './application-views.ts';
import type { ApplicationViewRequest } from './application-views.ts';

function fixture() {
  let at = 100, steps = 0, stops = 0;
  const accepted: ApplicationViewRequest[] = [];
  const allowed = new Set(['alice:public', 'alice:private', 'bob:public']);
  const controller = createApplicationViews({ applicationId: 'room', sessionId: 'session', clockDomain: 'app-clock', now: () => at,
    engine: { step: () => ({ public: ++steps, private: 42 }), stop: () => { stops++; } },
    views: [
      { id: 'public', value: { type: 'scalar', unit: '1', min: 0, max: 1000 }, project: state => (state as { public: number }).public },
      { id: 'private', value: { type: 'scalar', unit: '1', min: 0, max: 1000 }, project: state => (state as { private: number }).private },
    ], authorize(request) {
      accepted.push(request);
      if (allowed.has(`${request.principalId}:${request.viewId}`)) return { expiresAt: at + 1000, maxHz: 120, maxAgeMs: 1000 };
    } });
  return { controller, allowed, accepted, advance(ms = 20) { at += ms; }, steps: () => steps, stops: () => stops };
}

test('two independent displays consume one authoritative simulation turn and private state stays scoped', () => {
  const f = fixture(), left: number[] = [], right: number[] = [], privateView: number[] = [];
  assert.equal(f.controller.attach({ viewId: 'public', outputId: 'left', principalId: 'alice', apply: o => { left.push(o.value as number); }, release() {} }).ok, true);
  assert.equal(f.controller.attach({ viewId: 'public', outputId: 'right', principalId: 'bob', apply: o => { right.push(o.value as number); }, release() {} }).ok, true);
  assert.equal(f.controller.attach({ viewId: 'private', outputId: 'owner', principalId: 'alice', apply: o => { privateView.push(o.value as number); }, release() {} }).ok, true);
  let leaked = false;
  assert.equal(f.controller.attach({ viewId: 'private', outputId: 'intruder', principalId: 'bob', apply: () => { leaked = true; }, release() {} }).ok, false);
  assert.equal(f.controller.tick(), true); f.advance(); assert.equal(f.controller.tick(), true);
  assert.equal(f.steps(), 2); assert.deepEqual(left, [1, 2]); assert.deepEqual(right, [1, 2]); assert.deepEqual(privateView, [42, 42]); assert.equal(leaked, false);
  assert.equal(f.accepted.every(r => r.applicationId === 'room' && r.sessionId === 'session' && r.sourceOperation === 'subscribe' && r.sinkOperation === 'write'), true);
  f.controller.stop(); assert.equal(f.stops(), 1);
});

test('output replacement requires fresh permission; a stale handle cannot stop its replacement', () => {
  const f = fixture(), values: number[] = [];
  const attach = () => f.controller.attach({ viewId: 'public', outputId: 'screen', principalId: 'alice', apply: o => { values.push(o.value as number); }, release() {} });
  const old = attach(); assert.equal(old.ok, true); if (!old.ok) return;
  assert.equal(attach().ok, false); old.value.stop();
  const fresh = attach(); assert.equal(fresh.ok, true); old.value.stop(); f.controller.tick();
  assert.deepEqual(values, [1]); assert.equal(f.accepted.length, 2); f.controller.stop();
});

test('revocation, expiry and stop clear only owned displays and abort late rendering', async () => {
  const f = fixture(); let release = 0, signal: AbortSignal | undefined, isCurrent: (() => boolean) | undefined, finish!: () => void;
  const pending = f.controller.attach({ viewId: 'private', outputId: 'screen', principalId: 'alice',
    apply(_o, context) { signal = context.signal; isCurrent = context.isCurrent; return new Promise<void>(resolve => { finish = resolve; }); }, release() { release++; } });
  assert.equal(pending.ok, true); f.controller.tick(); assert.equal(signal?.aborted, false);
  assert.equal(f.controller.revoke('alice'), 1); assert.equal(signal?.aborted, true); assert.equal(isCurrent?.(), false); assert.equal(release, 1);
  finish(); await Promise.resolve();
  const expiring = f.controller.attach({ viewId: 'public', outputId: 'other', principalId: 'bob', apply() { throw new Error('expired render'); }, release() { release++; } });
  assert.equal(expiring.ok, true); f.advance(1001); f.controller.tick();
  assert.equal(release, 2); assert.equal(f.controller.status().outputs, 0); f.controller.stop(); f.controller.stop(); assert.equal(f.stops(), 1);
});

test('backwards or throwing clocks and failed engines retire all authority', () => {
  const f = fixture(); f.controller.tick(); f.advance(-1); assert.equal(f.controller.tick(), false); assert.equal(f.controller.status().state, 'stopped'); assert.equal(f.stops(), 1);
  let throws = false, calls = 0;
  const c = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now() { if (throws) throw new Error('clock'); return 1; },
    engine: { step() { calls++; throw new Error('private app failure'); }, stop() {} },
    views: [{ id: 'v', value: { type: 'boolean' }, project: () => true }], authorize: () => undefined });
  assert.equal(c.tick(), false); assert.equal(c.status().reason, 'engine-unavailable'); assert.equal(calls, 1); throws = true; assert.equal(c.tick(), false);
});

test('a failed projection retires its view without stopping unrelated displays or exposing the snapshot', () => {
  let at = 0, good = 0, bad = 0;
  const c = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now: () => at,
    engine: { step: () => ({ secret: 'never expose' }), stop() {} }, views: [
      { id: 'good', value: { type: 'boolean' }, project: () => true },
      { id: 'bad', value: { type: 'boolean' }, project: () => ({ secret: 'wrong frame' }) }], authorize: () => ({ expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 }) });
  c.attach({ viewId: 'good', outputId: 'one', principalId: 'p', apply() { good++; }, release() {} });
  c.attach({ viewId: 'bad', outputId: 'two', principalId: 'p', apply() { bad++; }, release() {} });
  c.tick(); at += 20; c.tick(); assert.equal(good, 2); assert.equal(bad, 0); assert.equal(c.status().state, 'active');
  assert.equal(c.attach({ viewId: 'bad', outputId: 'retry', principalId: 'p', apply() {}, release() {} }).ok, false);
  assert.equal(JSON.stringify(c.status()).includes('secret'), false); c.stop();
});

test('quotas and reentrant consent cannot add extra output authority', () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) assert.equal(f.controller.attach({ viewId: 'public', outputId: `screen-${i}`, principalId: 'alice', apply() {}, release() {} }).ok, true);
  assert.equal(f.controller.attach({ viewId: 'public', outputId: 'extra', principalId: 'alice', apply() {}, release() {} }).ok, false);
  assert.equal(f.controller.status().outputs, 16); f.controller.stop();
  const c: ReturnType<typeof createApplicationViews> = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now: () => 0, engine: { step: () => true, stop() {} },
    views: [{ id: 'v', value: { type: 'boolean' }, project: () => true }], authorize() { c.stop(); return { expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 }; } });
  assert.equal(c.attach({ viewId: 'v', outputId: 'o', principalId: 'p', apply() { throw new Error('orphan render'); }, release() {} }).ok, false);
  assert.equal(c.status().outputs, 0);
});

test('immutable bounded frames and simulation reentrancy preserve one shared snapshot', () => {
  let ticks = 0, projections = 0;
  const c: ReturnType<typeof createApplicationViews> = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now: () => 0,
    engine: { step() { ticks++; assert.equal(c.tick(), false); return { position: 2 }; }, stop() {} }, views: [{ id: 'v', value: { type: 'scalar', unit: '1', min: 0, max: 10 }, project(state) {
      projections++; assert.equal(Object.isFrozen(state), true); return (state as { position: number }).position;
    } }], authorize: () => ({ expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 }) });
  for (const outputId of ['a', 'b']) c.attach({ viewId: 'v', outputId, principalId: 'p', apply() {}, release() {} });
  assert.equal(c.tick(), true); assert.equal(ticks, 1); assert.equal(projections, 1); c.stop();
});

test('display attachment clock reads do not shorten the authoritative simulation interval', () => {
  let at = 100;
  const intervals: number[] = [];
  const c = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now: () => at,
    engine: { step(turn) { intervals.push(turn.elapsedMs); return true; }, stop() {} },
    views: [{ id: 'v', value: { type: 'boolean' }, project: () => true }], authorize: () => ({ expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 }) });
  c.tick(); at = 110;
  c.attach({ viewId: 'v', outputId: 'screen', principalId: 'p', apply() {}, release() {} });
  at = 120; c.tick(); assert.deepEqual(intervals, [0, 20]); c.stop();
});

test('clock failure aborts display authority and grant accessors never execute', () => {
  let unavailable = false, reads = 0, releases = 0;
  const c = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now() { if (unavailable) throw new Error('clock lost'); return 100; },
    engine: { step: () => true, stop() {} }, views: [{ id: 'v', value: { type: 'boolean' }, project: () => true }],
    authorize(request) {
      if (request.outputId === 'getter') return { get expiresAt() { reads++; return 1000; }, maxHz: 120, maxAgeMs: 1000 };
      return { expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 };
    } });
  assert.equal(c.attach({ viewId: 'v', outputId: 'getter', principalId: 'p', apply() {}, release() {} }).ok, false); assert.equal(reads, 0);
  assert.equal(c.attach({ viewId: 'v', outputId: 'screen', principalId: 'p', apply() {}, release() { releases++; } }).ok, true);
  c.tick(); unavailable = true; assert.equal(c.tick(), false); assert.equal(c.status().reason, 'clock-unavailable'); assert.equal(releases, 1);
});

test('an accidentally asynchronous engine is retired without an unhandled rejection or display effect', async () => {
  let effects = 0;
  const c = createApplicationViews({ applicationId: 'a', sessionId: 's', clockDomain: 'clock', now: () => 100,
    engine: { step: () => Promise.reject(new Error('private asynchronous failure')), stop() {} },
    views: [{ id: 'v', value: { type: 'boolean' }, project: () => true }], authorize: () => ({ expiresAt: 1000, maxHz: 120, maxAgeMs: 1000 }) });
  c.attach({ viewId: 'v', outputId: 'screen', principalId: 'p', apply() { effects++; }, release() {} });
  assert.equal(c.tick(), false); assert.equal(c.status().reason, 'engine-unavailable'); assert.equal(effects, 0);
  await new Promise<void>(resolve => setImmediate(resolve));
});
