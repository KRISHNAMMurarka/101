import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionOwnership } from './connection-ownership.ts';

test('pairing candidates retain the owner until explicit transfer, including decline and replacement', () => {
  const events: string[] = [], connection = (id: string) => ({ dispose() { events.push(`release:${id}`); } });
  const state = createConnectionOwnership<ReturnType<typeof connection>>();
  const first = connection('first'), second = connection('second'), third = connection('third');
  state.stage(first); assert.equal(state.activate(first, () => true), true);
  state.stage(second); assert.equal(state.current(), first); assert.equal(events.length, 0);
  state.discard(); assert.equal(state.current(), first); assert.deepEqual(events, ['release:second']);
  state.stage(second); state.stage(third); assert.equal(state.current(), first);
  assert.equal(state.activate(second, () => { throw new Error('Stale candidate must not run'); }), false);
  assert.equal(state.activate(third, () => { events.push('start:third'); return true; }), true);
  assert.equal(state.current(), third); assert.deepEqual(events, ['release:second', 'release:second', 'release:first', 'start:third']);
  state.clear(); state.clear(); assert.equal(events.filter(value => value === 'release:third').length, 1);
});

test('failed transfer releases both connections and a reentrant close cannot resurrect authority', () => {
  const state = createConnectionOwnership<{ dispose(): void }>();
  let releases = 0;
  const first = { dispose() { releases++; } }, second = { dispose() { releases++; } };
  state.stage(first); state.activate(first, () => true); state.stage(second);
  assert.equal(state.activate(second, () => false), false);
  assert.equal(state.current(), undefined); assert.equal(state.pending(), undefined); assert.equal(releases, 2);
  state.stage(first); state.activate(first, () => true); state.stage(second);
  assert.equal(state.activate(second, () => { state.clear(); return true; }), false);
  assert.equal(state.current(), undefined); assert.equal(state.pending(), undefined); assert.equal(releases, 4);
});
