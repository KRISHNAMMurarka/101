import assert from 'node:assert/strict';
import test from 'node:test';
import { isSdkBrowserPublicFile } from '../tools/sdk-browser-inventory.mjs';

// Exact additional paths from the actual seven-package producer at6a58a1a4.
for (const path of ['examples/onboarding/consumer.mjs', 'examples/onboarding/onboarding.mjs', 'examples/telemetry-owner.mjs']) {
  test('browser inventory accepts shipped connect file ' + path, () => {
    assert.equal(isSdkBrowserPublicFile('@101/connect', path), true);
  });
}

test('existing compiled SDK assets and source examples remain accepted', () => {
  for (const path of ['LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts',
    'schema/device-descriptor.json', 'examples/hid-switch.js', 'examples/hid-switch.d.ts', 'examples/hid-switch.ts'])
    assert.equal(isSdkBrowserPublicFile('@101/connect', path), true, path);
});

test('additional mjs examples stay confined to their exact connect package paths', () => {
  const extra = ['examples/onboarding/consumer.mjs', 'examples/onboarding/onboarding.mjs', 'examples/telemetry-owner.mjs'];
  for (const name of ['device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'])
    for (const path of extra) assert.equal(isSdkBrowserPublicFile('@101/' + name, path), false, name + ':' + path);
  for (const path of ['examples/private.mjs', 'examples/onboarding/private.mjs', 'examples/onboarding/../consumer.mjs',
    'examples/onboarding/consumer.mjs/extra', '/examples/onboarding/consumer.mjs', 'examples/telemetry-owner.mjs.backup'])
    assert.equal(isSdkBrowserPublicFile('@101/connect', path), false, path);
});

test('non-string inventory paths are refused without coercion', () => {
  const opaque = { toString() { throw Error('Path coercion must not execute'); } };
  for (const value of [undefined, null, 0, opaque]) assert.equal(isSdkBrowserPublicFile('@101/connect', value), false);
});
