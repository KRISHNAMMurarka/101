import assert from 'node:assert/strict';
import test from 'node:test';
import { createRichInputPipeline, runRichInputExample } from '../examples/device-pipelines/rich-input.ts';

const modifiers = { shift: false, control: false, alt: false, meta: false };
const key = { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false, modifiers };
const contact = { id: 'pointer:1', phase: 'down', position: { x: 0.2, y: 0.8 }, primary: true };
const pen = { id: 'pointer:2', phase: 'down', position: { x: 0.4, y: 0.6 }, primary: true,
  pressure: 0.5, tiltX: -20, tiltY: 30, twist: 120 };

test('six separately authorized event routes keep edges, composition and deltas in order', () => {
  let now = 1000;
  const pipeline = createRichInputPipeline({ now: () => now });
  try {
    assert.ok(pipeline.start.every(result => result.ok));
    const events = [
      ['contacts', contact], ['contacts', { ...contact, phase: 'up' }],
      ['pen', pen], ['pen', { ...pen, phase: 'up', pressure: 0 }],
      ['keys', key], ['keys', { ...key, phase: 'up' }],
      ['text', { compositionId: 'ime:1', phase: 'end', text: 'न' }],
      ['text', { compositionId: 'ime:1', phase: 'commit', text: 'न' }],
      ['wheel', { x: 0, y: -120, z: 0, mode: 'pixel', modifiers }],
      ['wheel', { x: 0, y: -80, z: 0, mode: 'pixel', modifiers }],
      ['relativeMotion', { x: 4, y: -2, unit: 'css-px', locked: true }],
      ['relativeMotion', { x: 3, y: 1, unit: 'css-px', locked: true }],
    ] as const;
    for (const [capability, value] of events) {
      now += 2;
      assert.equal(pipeline.publish(capability, value).ok, true);
      pipeline.runtime.flush();
    }
    const log = pipeline.state().log;
    assert.deepEqual(log.map(event => event.capability), events.map(event => event[0]));
    assert.deepEqual(log.map(event => event.value), events.map(event => event[1]));
    assert.equal(log.length, 12);
    assert.equal(Object.isFrozen(log), true);
    const before = log.length;
    assert.throws(() => pipeline.publish('keys', { ...key, phase: 'up', repeat: true }));
    pipeline.runtime.flush();
    assert.equal(pipeline.state().log.length, before);
    pipeline.stop();
    assert.equal(pipeline.state().releases, 6);
    assert.deepEqual(pipeline.state().log, []);
  } finally { pipeline.runtime.close(); }
  const example = runRichInputExample();
  assert.equal(example.kind, 'embedded-simulated-input');
  assert.equal(example.events, 12);
});

test('delivered relative motion keeps flowing beyond queue evidence capacity', () => {
  let now = 1000;
  const pipeline = createRichInputPipeline({ now: () => now });
  try {
    for (let index = 0; index < 100; index++) {
      now += 2;
      assert.equal(pipeline.publish('relativeMotion', { x: 1, y: -1, unit: 'css-px', locked: true }).ok, true, `event ${index + 1}`);
      pipeline.runtime.flush();
    }
    assert.equal(pipeline.connections.relativeMotion.status().pending, 0);
    assert.equal(pipeline.state().log.length, 100);
  } finally { pipeline.runtime.close(); }
});

test('rich input routes remain usable after the default runtime lease window', () => {
  let now = 1000;
  const pipeline = createRichInputPipeline({ now: () => now });
  try {
    now = 2501;
    assert.equal(pipeline.publish('keys', key).ok, true);
    pipeline.runtime.flush();
    assert.equal(pipeline.state().log.length, 1);
    assert.equal(pipeline.connections.keys.status().state, 'active');
    now = 9000;
    assert.ok(Object.values(pipeline.renew()).every(result => result.ok));
    now = 15000;
    assert.equal(pipeline.publish('keys', { ...key, phase: 'up' }).ok, true);
    pipeline.runtime.flush();
    assert.equal(pipeline.state().log.length, 2);
  } finally { pipeline.runtime.close(); }
});
