import assert from 'node:assert/strict';
import test from 'node:test';
import { getHapticOutputProfile } from './haptic-profile.ts';
import { parseSignalValue } from './sample.ts';

test('preset profiles accept only declared commands and disclose platform-controlled values', () => {
  const expo = getHapticOutputProfile('app:expo-haptic-presets/1');
  assert.equal(expo.duration.control, 'platform-preset');
  assert.equal(expo.duration.maxRequestedMs, undefined);
  assert.equal(expo.intensity.control, 'platform-preset');
  assert.equal(expo.physicalCancellation, 'unsupported');
  for (const preset of ['tap', 'impact', 'warning']) assert.equal(parseSignalValue(preset, expo.capability.value), preset);
  for (const command of ['custom', { preset: 'tap', duration: 1 }, { preset: 'impact', intensity: 0.5 }])
    assert.throws(() => parseSignalValue(command, expo.capability.value));
  assert.throws(() => getHapticOutputProfile('invented'));
  assert.ok(Object.isFrozen(expo.capability));
});

test('browser presets declare bounded requested timings without intensity or physical evidence', () => {
  const profile = getHapticOutputProfile('app:browser-haptic-presets/1');
  assert.deepEqual(profile.requestedPatterns, { tap: [15], impact: [35], warning: [50, 35, 50] });
  assert.equal(profile.duration.maxRequestedMs, 135);
  assert.equal(profile.intensity.control, 'unsupported');
  assert.equal(profile.capability.kind, 'command');
  assert.equal(profile.capability.delivery.mode, 'reliable');
  assert.equal(profile.capability.delivery.maxAgeMs, 100);
  assert.equal(profile.capability.ownership?.mode, 'exclusive');
});
