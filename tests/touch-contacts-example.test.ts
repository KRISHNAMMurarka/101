import assert from 'node:assert/strict';
import test from 'node:test';
import { createTouchContactsPipeline, runTouchContactsExample } from '../examples/device-pipelines/touch-contacts.ts';

// Losing the ID-keyed application state would clear the second simultaneous action on first up.
test('independent touch caller applies two simultaneous contacts and releases cancellation and disconnect', () => {
  const result = runTouchContactsExample();
  assert.deepEqual(result.simultaneous.contacts.map(value => value.id), ['left', 'right']);
  assert.deepEqual(result.oneReleased.contacts.map(value => value.id), ['right']);
  assert.equal(result.cancelled.contacts.length, 0);
  assert.equal(result.disconnected.contacts.length, 0);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.cancelled.events.map(value => value.phase), ['down', 'down', 'up', 'cancel']);
});

test('denied touch route admits no source events', () => {
  const example = createTouchContactsPipeline({ authorize: () => undefined });
  try { assert.equal(example.driver.state().stopped, true); assert.equal(example.state().events.length, 0); }
  finally { example.stop(); }
});

test('reliable queue rejection disconnects and clears every application contact', () => {
  let time = 1000; const example = createTouchContactsPipeline({ now: () => time });
  try {
    example.driver.contact({ id: 'first', phase: 'down', position: { x: 0.25, y: 0.5 }, primary: true }); example.tick(); time += 5;
    example.driver.contact({ id: 'second', phase: 'down', position: { x: 0.75, y: 0.5 }, primary: false }); example.tick(); time += 5;
    assert.equal(example.state().contacts.length, 2);
    for (let i = 0; i < 65; i++) example.driver.contact({ id: 'first', phase: 'move', position: { x: 0.5, y: 0.5 }, primary: true });
    example.tick();
    assert.equal(example.driver.state().stopped, true); assert.equal(example.connection.status().state, 'closed');
    assert.equal(example.state().contacts.length, 0);
  } finally { example.stop(); }
});

test('continuing touch host renews lease and clears contacts at the grant deadline', () => {
  let time = 1000; const example = createTouchContactsPipeline({ now: () => time });
  try {
    example.driver.contact({ id: 'first', phase: 'down', position: { x: 0.25, y: 0.5 }, primary: true }); example.tick();
    for (time of [10000, 19000, 28000, 37000, 46000, 55000]) { example.tick(); assert.equal(example.driver.state().stopped, false); }
    time = 61000; example.tick();
    assert.equal(example.driver.state().stopped, true); assert.equal(example.state().contacts.length, 0);
  } finally { example.stop(); }
});

test('bounded touch event history preserves simultaneous application ownership', () => {
  let time = 1000; const example = createTouchContactsPipeline({ now: () => time });
  try {
    example.driver.contact({ id: 'first', phase: 'down', position: { x: 0.25, y: 0.5 }, primary: true }); example.tick();
    for (let i = 0; i < 140; i++) { time += 5; example.driver.contact({ id: 'first', phase: 'move', position: { x: 0.5, y: 0.5 }, primary: true }); example.tick(); }
    assert.equal(example.state().events.length, 128); assert.equal(example.state().contacts.length, 1);
  } finally { example.stop(); }
});
