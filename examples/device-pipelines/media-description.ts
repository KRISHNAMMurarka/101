import { parseMediaManifest, planMediaBinding } from '@101/connect';

/** Static and simulated provider data; no capture or output route is started. */
export function runMediaDescriptionExample() {
  const video = { type: 'track', id: 'media:camera', media: 'video', direction: 'capture', codecs: ['video/vp8'],
    video: { widthPx: { min: 320, max: 1280 }, heightPx: { min: 240, max: 720 }, frameRateHz: { min: 15, max: 60 } } };
  const microphone = { type: 'track', id: 'media:microphone', media: 'audio', direction: 'capture', codecs: ['audio/opus'],
    audio: { sampleRateHz: { min: 16000, max: 48000 }, channels: { min: 1, max: 2 } } };
  const speaker = { ...microphone, id: 'media:speaker', direction: 'output' };
  const canvas = { type: 'render-target', id: 'media:canvas', media: 'video',
    geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } };
  const manifest = parseMediaManifest({ schemaVersion: 1, id: 'media:simulated-example',
    tracks: [video, microphone, speaker], renderTargets: [canvas] });
  const videoProbe = {
    source: { resourceId: video.id, registrationId: 'simulated-camera', state: 'available', codecs: ['video/vp8'],
      video: { widthPx: 640, heightPx: 480, frameRateHz: 30 } },
    target: { resourceId: canvas.id, registrationId: 'simulated-canvas', state: 'available', codecs: ['video/vp8'],
      geometry: { widthPx: 640, heightPx: 480, pixelRatio: 1 } },
  } as const;
  const planned = planMediaBinding(manifest, video.id, canvas.id, videoProbe);
  if (!planned.ok) throw new Error(`Simulated video description rejected: ${planned.reason}`);
  const unavailableMicrophone = planMediaBinding(manifest, microphone.id, speaker.id, {
    source: { resourceId: microphone.id, registrationId: 'simulated-microphone', state: 'denied', codecs: ['audio/opus'],
      audio: { sampleRateHz: 48000, channels: 2 } },
    target: { resourceId: speaker.id, registrationId: 'simulated-speaker', state: 'available', codecs: ['audio/opus'],
      audio: { sampleRateHz: 48000, channels: 2 } },
  });
  const unsupportedCodec = planMediaBinding(manifest, video.id, canvas.id, {
    ...videoProbe, target: { ...videoProbe.target, codecs: ['video/h264'] },
  });
  return Object.freeze({ kind: 'embedded-simulated-media-description', codec: planned.value.codec,
    widthPx: planned.value.video?.widthPx, heightPx: planned.value.video?.heightPx,
    unavailableMicrophone: !unavailableMicrophone.ok && unavailableMicrophone.reason === 'unavailable',
    unsupportedCodec: !unsupportedCodec.ok && unsupportedCodec.reason === 'codec',
    workingRoute: false });
}
