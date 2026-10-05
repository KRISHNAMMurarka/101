import assert from 'node:assert/strict';
import test from 'node:test';
import { createGesturePipeline, runGestureExample } from './gestures.ts';

test('separately granted gesture routes preserve transitions, wheel units and release on disconnect', () => {
  const result = runGestureExample();
  assert.deepEqual(result.transitions.map(event => [event.kind, event.phase]), [
    ['tap', 'end'], ['press', 'start'], ['press', 'end'], ['scroll', 'start'], ['scroll', 'cancel'],
  ]);
  assert.equal(result.wheels[0]?.mode, 'line');
  assert.equal(result.wheels[0]?.y, 3);
  assert.equal(result.beforeStop.heldGestures, 0);
  assert.equal(result.afterStop.heldGestures, 0);
  assert.equal(result.stopped, true);
});

test('denied wheel route closes the whole gesture source without leaving held input', () => {
  const pipeline = createGesturePipeline({ now: () => 1000, authorize(request) {
    if (request.source.capabilityId === 'wheel') return;
    return { expiresAt: 61000, maxHz: 1000, maxAgeMs: 1000 };
  } });
  try {
    assert.equal(pipeline.start.some(result => !result.ok), true);
    assert.equal(pipeline.driver.state().stopped, true);
    assert.equal(pipeline.state().heldGestures, 0);
  } finally { pipeline.stop(); }
});
