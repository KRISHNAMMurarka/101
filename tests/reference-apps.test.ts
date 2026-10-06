import test from 'node:test';
import assert from 'node:assert/strict';

const apps = await import('../examples/reference-apps/applications.ts').catch(() => undefined);
test('five runnable independent reference applications expose distinct public SDK jobs', () => {
  assert.ok(apps, 'Missing independent reference applications');
  assert.deepEqual(apps.REFERENCE_APPLICATIONS.map(item => item.id), ['pointer', 'sensor-dashboard', 'appliance-remote', 'media-sharing', 'collaborative-controls']);
  assert.equal(typeof apps.mountReferenceApplication, 'function');
});
function fixture(profile: 'pointer' | 'sensor' | 'appliance' = 'pointer') {
  let at = 100, released = 0;
  const owner = new AbortController(), effects: { id: string; value: unknown }[] = [];
  const session = apps!.createReferenceSession({ profile, ownerSignal: owner.signal, now: () => at,
    apply(id, observation, context) { if (!context.signal.aborted && context.isCurrent()) effects.push({ id, value: observation.value }); },
    release() { released++; } });
  return { session, owner, effects, released: () => released, at(value: number) { at = value; } };
}
test('neither one owner decision nor declared availability grants a reference route', async () => {
  const f = fixture(); try { assert.equal(f.session.start().ok, false); f.session.approve('source', true); assert.equal(f.session.start().ok, false);
    f.session.approve('source', false); f.session.approve('sink', true); assert.equal(f.session.start().ok, false); assert.equal(f.session.publish('position', { x: 0.2, y: 0.8 }).ok, false); assert.deepEqual(f.effects, []);
  } finally { await f.session.close(); }
});
test('an actual typed reference pointer routes only declared coordinates and releases held contact', async () => {
  const f = fixture(); try { f.session.approve('source', true); f.session.approve('sink', true); assert.equal(f.session.start().ok, true);
    assert.equal(f.session.publish('position', { x: 0.2, y: 0.8 }).ok, true); assert.equal(f.session.publish('contact', true).ok, true); f.session.tick();
    assert.deepEqual(f.effects, [{ id: 'position', value: { x: 0.2, y: 0.8 } }], 'One pending native slot cannot dispatch both recipients in the same turn'); f.session.tick();
    assert.deepEqual(f.effects, [{ id: 'position', value: { x: 0.2, y: 0.8 } }, { id: 'contact', value: true }]);
    assert.equal(f.session.publish('position', { x: 2, y: 0 }).ok, false); f.session.stop(); assert.ok(f.released() >= 2); assert.deepEqual(f.session.snapshot().latest, {});
  } finally { await f.session.close(); }
});
for (const cause of ['source-revoke', 'sink-revoke', 'owner-abort', 'expiry', 'rollback'] as const) test(cause + ' fences old reference producers and requires fresh approval', async () => {
  const f = fixture('sensor'); try { f.session.approve('source', true); f.session.approve('sink', true); assert.equal(f.session.start().ok, true);
    f.session.publish('lateness', 7); f.session.tick(); assert.equal(f.effects.length, 1);
    if (cause === 'source-revoke') f.session.approve('source', false); else if (cause === 'sink-revoke') f.session.approve('sink', false); else if (cause === 'owner-abort') f.owner.abort(); else { f.at(cause === 'expiry' ? 30100 : 99); f.session.tick(); }
    assert.equal(f.session.publish('lateness', 8).ok, false); f.session.tick(); assert.equal(f.effects.length, 1); assert.equal(f.session.snapshot().active, false); assert.deepEqual(f.session.snapshot().latest, {});
    assert.equal(f.session.start().ok, false);
  } finally { await f.session.close(); }
});
test('a software lamp handler acknowledgment does not invent independently observed model state', async () => {
  const f = fixture('appliance'); try { f.session.approve('source', true); f.session.approve('sink', true); assert.equal(f.session.start().ok, true);
    f.session.publish('command', true); f.session.tick(); assert.deepEqual(f.effects, [{ id: 'command', value: true }]); assert.equal(f.session.snapshot().latest.observed, undefined);
    const operation = f.session.snapshot().operations[0]!; assert.equal(operation.handlerResult, 'returned'); assert.equal(operation.effectEvidence, 'none');
    f.at(300); f.session.publish('observed', true); f.session.tick(); assert.deepEqual(f.effects.at(-1), { id: 'observed', value: true });
  } finally { await f.session.close(); }
});
test('an actual pending sink retains the retry reservation until settlement after cancellation', async () => {
  const owner = new AbortController(); let finish!: () => void, effect = 0;
  const session = apps!.createReferenceSession({ profile: 'appliance', now: () => 100, ownerSignal: owner.signal,
    async apply(_id, _value, context) { await new Promise<void>(resolve => { finish = resolve; }); if (context.isCurrent() && !context.signal.aborted) effect++; } });
  try { session.approve('source', true); session.approve('sink', true); assert.equal(session.start().ok, true); session.publish('command', true); session.tick(); assert.equal(session.snapshot().rawPending, 1);
    session.stop(); session.approve('source', true); session.approve('sink', true); assert.equal(session.start().ok, false); assert.equal(session.snapshot().rawPending, 1);
    finish(); await new Promise(resolve => setImmediate(resolve)); assert.equal(session.snapshot().rawPending, 0); assert.equal(effect, 0); assert.equal(session.start().ok, true);
  } finally { finish?.(); await session.close(); }
});
test('a reentrant reference clock cannot dispatch after it cancels the current owner', async () => {
  let cancel = false, effect = 0;
  const session = apps!.createReferenceSession({ profile: 'sensor', ownerSignal: new AbortController().signal,
    now() { if (cancel) session.stop(); return 100; }, apply() { effect++; } });
  try { session.approve('source', true); session.approve('sink', true); assert.equal(session.start().ok, true); cancel = true;
    assert.equal(session.publish('lateness', 1).ok, false); session.tick(); assert.equal(effect, 0); assert.equal(session.snapshot().active, false);
  } finally { await session.close(); }
});
test('reference constructor refuses a structural owner signal before any runtime work', () => {
  assert.throws(() => apps!.createReferenceSession({ profile: 'sensor', ownerSignal: { aborted: false } as AbortSignal, now: () => 100, apply() {} }));
});
