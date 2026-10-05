import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyboardTextPipeline, runKeyboardTextExample } from '../examples/device-pipelines/keyboard-text.ts';

test('independent keyboard caller retains committed text through cancellation and route disconnect', () => {
  const result = runKeyboardTextExample();
  assert.equal(result.beforeCommit, 'z'); assert.equal(result.released.text, 'zन');
  assert.equal(result.released.heldKeys, 0); assert.equal(result.released.composition, '');
  assert.equal(result.disconnected.text, 'zन'); assert.equal(result.disconnected.heldKeys, 0);
  assert.equal(result.stopped, true);
  const keys = result.released.events.filter(event => 'code' in event);
  assert.equal(keys.length, 3); assert.equal(keys[0].key, 'z'); assert.equal(keys[1].repeat, true);
});

test('denied keyboard routes admit no source events', () => {
  const example = createKeyboardTextPipeline({ authorize: () => undefined });
  try { assert.equal(example.driver.state().stopped, true); assert.equal(example.state().events.length, 0); }
  finally { example.stop(); }
});

test('default caller clock allows successive reliable events to reach the application', async () => {
  const example = createKeyboardTextPipeline();
  try {
    example.driver.input('insertText', 'a', false); example.runtime.flush();
    await new Promise(resolve => setTimeout(resolve, 5));
    example.driver.input('insertText', 'b', false); example.runtime.flush();
    assert.equal(example.state().text, 'ab');
  } finally { example.stop(); }
});

test('continuing host renews its route lease and still stops at the authorization deadline', () => {
  let time = 1000; const example = createKeyboardTextPipeline({ now: () => time });
  try {
    time = 2600; example.tick(); assert.equal(example.driver.state().stopped, false);
    time = 10900; example.tick(); assert.equal(example.driver.state().stopped, false);
    time = 19500; example.tick(); assert.equal(example.driver.state().stopped, false);
    time = 61000; example.tick(); assert.equal(example.driver.state().stopped, true);
  } finally { example.stop(); }
});

test('rejected reliable publication closes both routes and clears held input', () => {
  let time = 1000; const example = createKeyboardTextPipeline({ now: () => time });
  try {
    example.driver.input('insertText', 'saved', false); example.tick(); time += 5;
    example.driver.key({ code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false,
      modifiers: { shift: false, control: false, alt: false, meta: false } }); example.tick(); time += 5;
    for (let index = 0; index < 65; index++) example.driver.input('insertText', 'x', false);
    example.tick();
    assert.equal(example.driver.state().stopped, true);
    assert.ok(example.connections.every(connection => connection.status().state === 'closed'));
    assert.equal(example.state().heldKeys, 0); assert.equal(example.state().text, 'saved');
  } finally { example.stop(); }
});

test('bounded diagnostic history does not prevent later committed text', () => {
  let time = 1000; const example = createKeyboardTextPipeline({ now: () => time });
  try {
    for (let index = 0; index < 140; index++) { example.driver.input('insertText', 'x', false); example.tick(); time += 5; }
    assert.equal(example.state().text.length, 140);
    assert.ok(example.state().events.length <= 128);
  } finally { example.stop(); }
});
