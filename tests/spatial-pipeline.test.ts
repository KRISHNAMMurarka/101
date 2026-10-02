import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpatialJointPipeline, runSpatialJointExample } from '../examples/device-pipelines/spatial-joints.ts';

const identity = { x: 0, y: 0, z: 0, w: 1 };
const fixture = { wrist: { position: { x: 1, y: 0.5, z: -1 }, orientation: identity },
  index: { position: { x: 1.2, y: 0.5, z: -1 }, orientation: identity } };

test('simulated watch-style joints publish through an authorized converted route with provenance', () => {
  const pipeline = createSpatialJointPipeline({ now: () => 1000 });
  try {
    assert.equal(pipeline.publish(fixture).ok, true);
    pipeline.runtime.flush();
    const state = pipeline.state();
    assert.deepEqual(state.joints.wrist.position, { x: -100, y: 50, z: -100 });
    assert.deepEqual(state.joints.index.position, { x: -120, y: 50, z: -100 });
    assert.equal(state.provenance?.simulated, true);
    assert.equal((state.provenance?.conversion as { mirrored: boolean }).mirrored, true);
    assert.equal(state.released, 0);
    assert.throws(() => pipeline.publish({ wrist: { ...fixture.wrist, orientation: { x: 0, y: 0, z: 0, w: 0 } } }));
    pipeline.connection.stop();
    assert.equal(pipeline.state().released, 1);
    assert.deepEqual(pipeline.state().joints, {});
  } finally { pipeline.runtime.close(); }
  assert.equal(runSpatialJointExample().publication, true);
});
