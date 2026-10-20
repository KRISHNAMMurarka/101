import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Pin the installed public distribution, without importing private platform source. */
export function connectSdkFiles(root) {
  const prefix = 'node_modules/@uynis-connect/connect';
  const walk = path => readdirSync(resolve(root, path), { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'SDK distribution entries must be ordinary files');
    const next = `${path}/${entry.name}`;
    return entry.isDirectory() ? walk(next) : entry.isFile() ? [next] : [];
  });
  return [`${prefix}/package.json`, ...walk(`${prefix}/dist`), ...walk(`${prefix}/assets`)].sort();
}

export function connectSdkPins(root) {
  return Object.fromEntries(connectSdkFiles(root).map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
}

export function verifyConnectSdkProof(proof, root) {
  assert.deepEqual(proof.sdkPackagePins, connectSdkPins(root), 'Evidence must pin the complete installed SDK distribution used by the build');
}
