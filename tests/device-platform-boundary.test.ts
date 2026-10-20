import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import test from 'node:test';
import * as connect from '@uynis-connect/connect';

const root = resolve(import.meta.dirname, '..');
const excluded = new Set(['node_modules', 'dist', 'build', 'target', 'obj', 'bin', 'fixtures']);
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name) || entry.name.startsWith('.')) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:ts|tsx|mjs|js)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
}

test('Games consumes the public package without a private device implementation', () => {
  const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(metadata.dependencies['@uynis-connect/connect'], 'file:../uynis-connect/sdk/connect');
  const forbidden = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:@101\/(?:adapter-[^"'/]+|transport-[^"'/]+|device-model|device-runtime|device-web|connect|pairing|protocol|session|hardware|diagnostics|devkit|replay|motion|vision|audio)(?:["'/])|@uynis-connect\/connect\/[^"']+|[^"']*uynis-connect\/(?:sdk|services|agents)\/)/;
  for (const directory of ['app', 'apps', 'games', 'packages']) {
    for (const file of sources(resolve(root, directory))) assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, relative(root, file));
  }
  for (const name of ['PeerDataTransport', 'SecureWebSocketTransport', 'WebRTCTransport', 'BroadcastChannelTransport',
    'KeyboardAdapter', 'GamepadAdapter', 'PointerAdapter', 'BrowserCameraAdapter', 'BrowserMotionAdapter']) {
    assert.equal(name in connect, false, `${name} must remain inside Connect`);
  }
});

test('the platform has one maintained home after cutover', () => {
  for (const name of ['device-model', 'device-runtime', 'device-web', 'connect', 'pairing', 'protocol', 'session',
    'hub-server', 'hardware', 'diagnostics', 'devkit', 'replay', 'motion', 'vision', 'audio',
    'adapter-keyboard', 'adapter-gamepad', 'adapter-pointer', 'adapter-camera', 'adapter-motion', 'adapter-watch',
    'adapter-hid', 'adapter-bluetooth', 'adapter-serial', 'transport-webrtc', 'transport-websocket']) {
    assert.equal(existsSync(resolve(root, 'packages', name, 'src')), false, name);
  }
  for (const name of ['controller-native', 'desktop-hub', 'watch-ios', 'watch-wear']) {
    assert.equal(existsSync(resolve(root, 'apps', name, 'package.json')), false, name);
  }
});
