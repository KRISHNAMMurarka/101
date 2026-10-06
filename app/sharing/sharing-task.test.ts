import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharingTask } from './sharing-task.ts';

function fixture() {
  let at = 1000;
  const task = createSharingTask({ now: () => at });
  const accept = (source = 'first', slot = 'left', duration: 30 | 60 = 30) => {
    assert.equal(task.request(source, slot, duration, true), true);
    const request = task.snapshot().slots.find(value => value.id === slot)!.request!;
    assert.equal(task.decide(request.id, true), true);
    at += 20; task.tick(); at += 20; task.tick();
  };
  return { task, accept, advance: (delta: number) => { for (let left = delta; left > 0;) { const step = Math.min(left, 20); at += step; task.tick(); left -= step; } } };
}

test('requests are inert and source opt-in is independently required', () => {
  const { task } = fixture();
  assert.equal(task.request('first', 'left', 30, false), false);
  assert.equal(task.request('first', 'left', 30, true), true);
  task.nudge('first', .2, 0); task.contact('first', true); task.tick();
  assert.equal(task.snapshot().slots[0].held, false);
  assert.equal(task.snapshot().slots[0].position, undefined);
  const request = task.snapshot().slots[0].request!;
  assert.equal(task.decide(request.id, false), true);
  assert.equal(task.snapshot().slots[0].owner, undefined);
  task.close();
});

test('real runtime effects stay on declared partitions and revoking one releases only it', () => {
  const { task, accept, advance } = fixture();
  accept('first', 'left'); accept('second', 'right');
  task.contact('first', true); task.contact('second', true); advance(20);
  task.nudge('first', .1, 0); task.nudge('second', -.1, 0); advance(20);
  assert.deepEqual(task.snapshot().slots.map(slot => slot.held), [true, true]);
  assert.ok(task.snapshot().slots[0].position!.x > .5);
  assert.ok(task.snapshot().slots[1].position!.x < .5);
  const preview = task.previewRevoke('left')!;
  assert.equal(preview.recipients[0].sourceId, 'first');
  assert.equal(task.confirmPreview(preview), true);
  assert.equal(task.snapshot().slots[0].held, false);
  assert.equal(task.snapshot().slots[1].held, true);
  task.close();
});

test('pending decline/cancel retain incumbent; transfer releases its held output', () => {
  const { task, accept, advance } = fixture(); accept(); task.contact('first', true); advance(20);
  assert.equal(task.request('second', 'left', 60, true), true);
  let request = task.snapshot().slots[0].request!;
  assert.equal(task.snapshot().slots[0].held, true);
  assert.equal(task.decide(request.id, false), true);
  assert.equal(task.snapshot().slots[0].held, true);
  assert.equal(task.request('second', 'left', 60, true), true);
  request = task.snapshot().slots[0].request!;
  assert.equal(task.cancel(request.id), true);
  assert.equal(task.snapshot().slots[0].held, true);
  accept('second', 'left', 60);
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'second');
  assert.equal(task.snapshot().slots[0].held, false);
  task.contact('first', true); advance(20);
  assert.equal(task.snapshot().slots[0].held, false);
  task.close();
});

test('absolute grants never renew past selected duration; fresh opt-in and approval recover', () => {
  const { task, accept, advance } = fixture(); accept(); task.contact('first', true); advance(20);
  const endsAt = task.snapshot().slots[0].endsAt;
  advance(10000); assert.equal(task.snapshot().slots[0].endsAt, endsAt);
  advance(20000); assert.equal(task.snapshot().slots[0].owner, undefined);
  assert.equal(task.snapshot().slots[0].held, false);
  task.contact('first', true); advance(20); assert.equal(task.snapshot().slots[0].held, false);
  accept(); task.contact('first', true); advance(20); assert.equal(task.snapshot().slots[0].held, true);
  task.close();
});

test('request expiry cannot displace incumbent; stale decisions are denied', () => {
  const { task, accept, advance } = fixture(); accept('first', 'left', 60);
  task.request('second', 'left', 30, true); const request = task.snapshot().slots[0].request!;
  advance(30001);
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'first');
  assert.equal(task.decide(request.id, true), false);
  assert.equal(task.snapshot().slots[0].outcome, 'request-expired'); task.close();
});

test('stale/forged revoke previews cannot revoke replacement and retain a readable retry', () => {
  const { task, accept } = fixture(); accept();
  const preview = task.previewRevoke('left')!;
  accept('second', 'left');
  assert.equal(task.confirmPreview(preview), false);
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'second');
  assert.equal(task.snapshot().notice, 'review-changed');
  assert.equal(task.confirmPreview({ ...preview }), false);
  assert.equal(task.confirmPreview(task.previewRevoke('left')!), true); task.close();
});

test('policy change previews affected routes; cancel preserves both, switch restores no grants', () => {
  const { task, accept, advance } = fixture(); accept(); accept('second', 'right');
  task.contact('first', true); task.contact('second', true); advance(20);
  const preview = task.previewPolicy('exclusive')!;
  assert.equal(preview.recipients.length, 2);
  task.cancelPreview(); assert.deepEqual(task.snapshot().slots.map(slot => slot.held), [true, true]);
  assert.equal(task.confirmPreview(preview), false);
  assert.equal(task.confirmPreview(task.previewPolicy('exclusive')!), true);
  assert.equal(task.snapshot().policy, 'exclusive'); assert.equal(task.snapshot().slots.length, 1);
  assert.equal(task.snapshot().slots[0].owner, undefined);
  task.contact('first', true); advance(20); assert.equal(task.snapshot().slots[0].held, false);
  accept('first', 'exclusive'); task.close();
});

test('actual readiness loss releases route; reconnect cannot restore authority', () => {
  const { task, accept, advance } = fixture(); accept(); task.contact('first', true); advance(20);
  task.setAvailable('first', false); advance(20);
  assert.equal(task.snapshot().slots[0].owner, undefined); assert.equal(task.snapshot().slots[0].held, false);
  assert.equal(task.request('first', 'left', 30, true), false);
  task.setAvailable('first', true); task.contact('first', true); advance(20);
  assert.equal(task.snapshot().slots[0].held, false); accept(); task.close();
});

test('interrupt/close fence late producer callbacks and preserve fresh recovery', () => {
  const { task, accept, advance } = fixture(); accept(); task.contact('first', true); advance(20);
  task.interrupt(); task.contact('first', true); advance(20);
  assert.equal(task.snapshot().slots[0].held, false); accept();
  task.close(); assert.equal(task.contact('first', true), false); task.tick();
  assert.equal(task.snapshot().closed, true); assert.equal(task.snapshot().slots[0].held, false);
  assert.equal(task.request('second', 'right', 30, true), false);
});

test('reentrant clock close and observer close cannot issue grants or effects', () => {
  let closeClock = false; let task: ReturnType<typeof createSharingTask>;
  task = createSharingTask({ now: () => { if (closeClock) task.close(); return 1000; } });
  closeClock = true; assert.equal(task.request('first', 'left', 30, true), false); assert.equal(task.snapshot().closed, true);
  let retire = false;
  task = createSharingTask({ now: () => 1000, onChange: () => { if (retire) task.close(); } });
  retire = true; assert.equal(task.request('first', 'left', 30, true), false); assert.equal(task.snapshot().closed, true);
});

test('invalid/backwards clock retires authority permanently and no unbounded request history', () => {
  let at = 1000; const task = createSharingTask({ now: () => at });
  for (let i = 0; i < 64; i++) { assert.equal(task.request('first', 'left', 30, true), true); task.cancel(task.snapshot().slots[0].request!.id); }
  assert.equal(task.request('first', 'left', 30, true), false); assert.equal(task.snapshot().remainingRequests, 0);
  assert.ok(task.snapshot().transitions.length <= 64);
  at = 0; task.tick(); assert.equal(task.snapshot().closed, true);
});

test('a policy preview cannot stop an owner approved after the preview', () => {
  const { task, accept } = fixture();
  const preview = task.previewPolicy('exclusive')!;
  accept('first', 'left');
  assert.equal(task.confirmPreview(preview), false);
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'first');
  assert.equal(task.snapshot().policy, 'partitioned');
  assert.equal(task.snapshot().notice, 'review-changed'); task.close();
});

test('one issued control cannot accidentally share two independently reviewed sides', () => {
  const { task, accept } = fixture(); accept('first', 'left');
  assert.equal(task.request('first', 'right', 30, true), false);
  assert.equal(task.snapshot().slots[1].request, undefined);
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'first'); task.close();
});

test('a control waiting longer than freshness starts a fresh producer only after approval', () => {
  const { task, accept, advance } = fixture();
  advance(500); accept(); advance(20);
  assert.deepEqual(task.snapshot().slots[0].position, { x: .5, y: .5 });
  task.contact('first', true); advance(20); assert.equal(task.snapshot().slots[0].held, true);
  task.confirmPreview(task.previewRevoke('left')!); advance(500); accept(); advance(20);
  assert.equal(task.snapshot().slots[0].held, false);
  assert.deepEqual(task.snapshot().slots[0].position, { x: .5, y: .5 }); task.close();
});

test('a request expiring during the decision clock read keeps the incumbent grant', () => {
  let at = 1000, armed = false, reads = 0;
  const task = createSharingTask({ now: () => { if (armed && ++reads === 2) at += 2; return at; } });
  task.request('first', 'left', 60, true); task.decide(task.snapshot().slots[0].request!.id, true);
  at += 40; task.tick(); task.request('second', 'left', 30, true);
  const request = task.snapshot().slots[0].request!;
  while (at < request.expiresAt - 1) { at = Math.min(at + 20, request.expiresAt - 1); task.tick(); }
  const incumbentEndsAt = task.snapshot().slots[0].endsAt;
  armed = true; assert.equal(task.decide(request.id, true), false); armed = false;
  assert.equal(task.snapshot().slots[0].endsAt, incumbentEndsAt);
  assert.equal(task.snapshot().slots[0].duration, 60);
  at += 20; task.tick();
  assert.equal(task.snapshot().slots[0].owner?.sourceId, 'first');
  task.contact('first', true); at += 20; task.tick(); assert.equal(task.snapshot().slots[0].held, true);
  task.close();
});
