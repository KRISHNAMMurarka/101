import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derToP1363 } from '../../../../../packages/device-web/src/identity-format.ts';

// Run with: node --experimental-strip-types .../qa/ios-producer.mjs [simulator|macos]
// Simulator mode requires an already booted iOS simulator. macOS is algorithm
// evidence only and cannot qualify iOS storage or a hardware protection claim.
const platform = process.argv[2] ?? 'simulator';
assert.ok(platform === 'simulator' || platform === 'macos');
const directory = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), '101-identity-producer-'));
try {
  const binary = join(temporary, 'identity-producer');
  const flags = platform === 'simulator' ? [
    '-target', 'arm64-apple-ios15.1-simulator', '-sdk',
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim(),
  ] : [];
  execFileSync('xcrun', ['swiftc', ...flags, join(directory, '../ios/One01IdentityStore.swift'),
    join(directory, 'ios-producer.swift'), '-o', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
  let candidate;
  let output;
  if (platform === 'simulator') {
    const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { encoding: 'utf8' }));
    const candidates = Object.entries(devices.devices).filter(([runtime]) => runtime.includes('iOS'))
      .flatMap(([, values]) => values);
    assert.equal(candidates.length, 1, 'Boot exactly one iOS simulator for the producer check');
    candidate = candidates[0].name;
    output = execFileSync('xcrun', ['simctl', 'spawn', candidates[0].udid, binary], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } else {
    candidate = 'macOS host Security.framework';
    output = execFileSync(binary, [], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  }
  const fixture = JSON.parse(output);
  const raw = new Uint8Array(Buffer.from(fixture.publicKey, 'base64'));
  const message = new Uint8Array(Buffer.from(fixture.message, 'base64'));
  const signature = derToP1363(new Uint8Array(Buffer.from(fixture.signature, 'base64')));
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), true);
  message[0] ^= 1;
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), false);
  assert.equal(fixture.sha256, createHash('sha256').update(Buffer.from(fixture.message, 'base64')).digest('base64'));
  console.log(JSON.stringify({ platform, candidate, result: 'Security producer DER → strict P1363 → WebCrypto verified; tampering and native bounds rejected', storageLifecycle: 'unverified' }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
