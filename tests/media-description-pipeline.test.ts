import assert from 'node:assert/strict';
import test from 'node:test';
import { runMediaDescriptionExample } from '../examples/device-pipelines/media-description.ts';

test('simulated media description proposes only host-probed compatible resources', () => {
  assert.deepEqual(runMediaDescriptionExample(), {
    kind: 'embedded-simulated-media-description',
    codec: 'video/vp8',
    widthPx: 640,
    heightPx: 480,
    unavailableMicrophone: true,
    unsupportedCodec: true,
    workingRoute: false,
  });
});
