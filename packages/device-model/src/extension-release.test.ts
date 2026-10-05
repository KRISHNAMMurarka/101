import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAssetReference } from './resource.ts';

const api = await import('./extension-release.ts').catch(() => undefined);
const source = new Uint8Array(readFileSync(new URL('../../../examples/external-processor/processor.mjs', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../../../examples/external-processor/manifest.json', import.meta.url), 'utf8'));

test('signed reviewed release verifies the actual external processor bytes before activation', async () => {
  assert.ok(api, 'reviewed extension verification API must exist');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
    packageId: manifest.id, version: manifest.version, sequence: 1, abi: '101:processor/1', runtimeVersion: '0.1.0',
    manifest, manifestSha256: await api.processorExtensionManifestSha256(manifest),
    source: await createAssetReference('example:processor-source', 'blob', source), privileges: ['compute-local'], dependencies: [] };
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
    api.processorExtensionSigningBytes(unsigned)));
  const release = { ...unsigned, signature: Buffer.from(signature).toString('hex') };
  assert.equal(await api.verifyProcessorExtensionRelease(release, source, keys.publicKey), true);
  assert.equal(await api.verifyProcessorExtensionRelease(release, new TextEncoder().encode('tampered'), keys.publicKey), false);
  assert.equal(await api.verifyProcessorExtensionRelease({ ...release, sequence: 2 }, source, keys.publicKey), false);
  assert.equal(await api.verifyProcessorExtensionRelease({ ...release, manifestSha256: '0'.repeat(64) }, source, keys.publicKey), false);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  assert.equal(await api.verifyProcessorExtensionRelease(release, source, other.publicKey), false);
  const copied = api.parseProcessorExtensionRelease(release);
  assert.ok(Object.isFrozen(copied.manifest.configuration));
  assert.equal(copied.manifest.codeSha256, createHash('sha256').update(source).digest('hex'));
  for (const changed of [{ privileges: ['network'] }, { dependencies: ['remote'] }, { runtimeVersion: '0.2.0' },
    { abi: 'unknown' }, { manifest: { ...manifest, assets: [{ reference: unsigned.source, license: 'MIT' }] } },
    { source: { ...unsigned.source, sha256: '0'.repeat(64) } },
    { source: { ...unsigned.source, byteLength: 256 * 1024 + 1 } }, { credential: 'forbidden' }, { conformance: 'passed' }]) {
    assert.throws(() => api.parseProcessorExtensionRelease({ ...release, ...changed }));
  }
  let getters = 0;
  assert.throws(() => api.parseProcessorExtensionRelease(Object.defineProperty({}, 'manifest', {
    enumerable: true, get() { getters++; return manifest; },
  })));
  assert.equal(getters, 0);
});
