import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMediaManifest, planMediaBinding } from './media.ts';
import type { MediaHostProbe } from './media.ts';

const video = { type: 'track', id: 'media:camera', media: 'video', direction: 'capture', codecs: ['video/vp8'],
  video: { widthPx: { min: 320, max: 1920 }, heightPx: { min: 240, max: 1080 }, frameRateHz: { min: 15, max: 60 } } };
const audio = { type: 'track', id: 'media:microphone', media: 'audio', direction: 'capture', codecs: ['audio/opus'],
  audio: { sampleRateHz: { min: 16000, max: 48000 }, channels: { min: 1, max: 2 } } };
const canvas = { type: 'render-target', id: 'media:canvas', media: 'video', geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } };
const manifest = { schemaVersion: 1, id: 'media:example', tracks: [video, audio], renderTargets: [canvas] };

test('media manifest freezes exact track, codec, capture and geometry descriptions', () => {
  const parsed = parseMediaManifest(manifest);
  assert.deepEqual(parsed, manifest);
  assert.equal(Object.isFrozen(parsed.tracks[0].codecs), true);
  assert.equal(Object.isFrozen(parsed.renderTargets[0].geometry), true);
  assert.throws(() => parseMediaManifest({ ...manifest, working: true }));
  assert.throws(() => parseMediaManifest({ ...manifest, tracks: [{ ...video, ready: true }, audio] }));
  assert.throws(() => parseMediaManifest({ ...manifest, tracks: [video, { ...audio, id: video.id }] }));
  assert.throws(() => parseMediaManifest({ ...manifest, tracks: [{ ...video, codecs: ['video/vp8', 'video/vp8'] }] }));
  assert.throws(() => parseMediaManifest({ ...manifest, tracks: [{ ...video, codecs: ['audio/opus'] }] }));
  assert.throws(() => parseMediaManifest({ ...manifest, renderTargets: [{ ...canvas, geometry: { widthPx: 0, heightPx: 480, pixelRatio: 1 } }] }));
});

test('audio output requires exact live sample rate and channel count', () => {
  const speaker = { ...audio, id: 'media:speaker', direction: 'output' };
  const described = parseMediaManifest({ schemaVersion: 1, id: 'media:audio-pair', tracks: [audio, speaker], renderTargets: [] });
  const probe = {
    source: { resourceId: audio.id, registrationId: 'microphone-1', state: 'available', codecs: ['audio/opus'],
      audio: { sampleRateHz: 48000, channels: 2 } },
    target: { resourceId: speaker.id, registrationId: 'speaker-1', state: 'available', codecs: ['audio/opus'],
      audio: { sampleRateHz: 48000, channels: 2 } },
  } as const;
  const result = planMediaBinding(described, audio.id, speaker.id, probe);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.audio, { sampleRateHz: 48000, channels: 2 });
  assert.deepEqual(planMediaBinding(described, audio.id, speaker.id, { ...probe,
    target: { ...probe.target, audio: { sampleRateHz: 48000, channels: 1 } } }), { ok: false, reason: 'geometry' });
});

test('a concrete available provider can propose an exact video-to-canvas binding', () => {
  const parsed = parseMediaManifest(manifest);
  const probe = {
    source: { resourceId: video.id, registrationId: 'source-1', state: 'available', codecs: ['video/vp8'],
      video: { widthPx: 640, heightPx: 480, frameRateHz: 30 } },
    target: { resourceId: canvas.id, registrationId: 'sink-1', state: 'available', codecs: ['video/vp8'],
      geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } },
  } as const;
  const result = planMediaBinding(parsed, video.id, canvas.id, probe);
  assert.deepEqual(result, { ok: true, value: { sourceId: video.id, targetId: canvas.id,
    sourceRegistrationId: 'source-1', targetRegistrationId: 'sink-1', codec: 'video/vp8',
    video: { widthPx: 640, heightPx: 480, frameRateHz: 30 } } });
  assert.equal(result.ok && Object.isFrozen(result.value), true);
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, { ...probe,
    source: { ...probe.source, state: 'denied' } }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, { ...probe,
    target: { ...probe.target, codecs: ['video/h264'] } }), { ok: false, reason: 'codec' });
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, { ...probe,
    target: { ...probe.target, geometry: { widthPx: 1280, heightPx: 720, pixelRatio: 1 } } }), { ok: false, reason: 'geometry' });
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, { ...probe,
    source: { ...probe.source, resourceId: 'media:camera-b' } }), { ok: false, reason: 'probe' });
});

test('a probe without the selected resource identity cannot authorize a proposal', () => {
  const parsed = parseMediaManifest(manifest);
  const foreignCameraProbe = {
    source: { registrationId: 'camera-b-live-registration', state: 'available', codecs: ['video/vp8'],
      video: { widthPx: 640, heightPx: 480, frameRateHz: 30 } },
    target: { resourceId: canvas.id, registrationId: 'sink-1', state: 'available', codecs: ['video/vp8'],
      geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } },
  } as const;
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, foreignCameraProbe as unknown as MediaHostProbe),
    { ok: false, reason: 'probe' });
});

test('the host probe wrapper rejects accessors without executing them', () => {
  const parsed = parseMediaManifest(manifest);
  let reads = 0;
  const host = {
    get source() { reads += 1; return { resourceId: video.id, registrationId: 'source-1', state: 'available', codecs: ['video/vp8'],
      video: { widthPx: 640, heightPx: 480, frameRateHz: 30 } }; },
    target: { resourceId: canvas.id, registrationId: 'sink-1', state: 'available', codecs: ['video/vp8'],
      geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } },
  } as const;
  assert.deepEqual(planMediaBinding(parsed, video.id, canvas.id, host as MediaHostProbe), { ok: false, reason: 'probe' });
  assert.equal(reads, 0);
});
