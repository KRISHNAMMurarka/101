import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derToP1363 } from '../../../../../packages/device-web/src/identity-format.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), '101-identity-keychain-'));
const application = 'com.oneohone.link.identityqa';
const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { encoding: 'utf8' }));
const candidates = Object.entries(devices.devices).filter(([runtime]) => runtime.includes('iOS')).flatMap(([, values]) => values);
assert.equal(candidates.length, 1, 'Boot exactly one iOS simulator for the disposable storage fixture');
const device = candidates[0];
const simctl = (...args) => {
  try { return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`Isolated iOS fixture ${args[0]} failed`); }
};
let installed = false;
try {
  const applications = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: simctl('listapps', device.udid), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }));
  assert.equal(applications[application], undefined, 'QA bundle must not already exist');
  const bundle = join(temporary, 'IdentityFixture.app');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${application}</string><key>CFBundleExecutable</key><string>IdentityFixture</string>
    <key>CFBundleName</key><string>IdentityFixture</string><key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
    <key>MinimumOSVersion</key><string>16.4</string><key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
    <key>LSRequiresIPhoneOS</key><true/><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  </dict></plist>`);
  const entitlements = join(temporary, 'entitlements.plist');
  writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>application-identifier</key><string>101LOCALQA.${application}</string>
    <key>keychain-access-groups</key><array><string>101LOCALQA.${application}</string></array>
  </dict></plist>`);
  const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-ios16.4-simulator', '-sdk', sdk,
    join(directory, '../ios/One01IdentityStore.swift'), join(directory, 'ios-storage.swift'), '-o', join(bundle, 'IdentityFixture')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, bundle], { stdio: ['ignore', 'pipe', 'pipe'] });
  simctl('install', device.udid, bundle);
  installed = true;
  simctl('launch', device.udid, application);
  const container = simctl('get_app_container', device.udid, application, 'data').trim();
  let fixture;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { fixture = JSON.parse(readFileSync(join(container, 'Documents/result.json'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal(fixture?.result, 'passed', `Native Keychain fixture failed: ${fixture?.failureType ?? 'no result'}`);
  assert.notEqual(fixture.cleanup, 'failed');
  assert.equal(fixture.protection, 'os-keystore');
  const raw = new Uint8Array(Buffer.from(fixture.publicKey, 'base64'));
  const message = new Uint8Array(Buffer.from(fixture.message, 'base64'));
  const signature = derToP1363(new Uint8Array(Buffer.from(fixture.signature, 'base64')));
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), true);
  message[0] ^= 1;
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), false);
  console.log(JSON.stringify({ result: 'Security Keychain create/load/idempotence/remove/rotation and DER → P1363 → WebCrypto verified',
    candidate: device.name, hardwareProtection: 'unverified', expoBridgeRuntime: 'unverified' }));
} finally {
  if (installed) simctl('uninstall', device.udid, application);
  rmSync(temporary, { recursive: true, force: true });
}
