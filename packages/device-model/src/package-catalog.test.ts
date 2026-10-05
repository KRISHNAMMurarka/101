import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAssetReference } from './resource.ts';
import { processorExtensionManifestSha256, processorExtensionSigningBytes } from './extension-release.ts';

const api = await import('./package-catalog.ts').catch(() => undefined);
const source = new Uint8Array(readFileSync(new URL('../../../examples/external-processor/processor.mjs', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../../../examples/external-processor/manifest.json', import.meta.url), 'utf8'));
async function fixture() {
  assert.ok(api, 'inert signed catalog submission API is required');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const reference = await createAssetReference('example:catalog-source', 'blob', source);
  const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
    packageId: manifest.id, version: manifest.version, sequence: 1, abi: '101:processor/1', runtimeVersion: '0.1.0',
    manifest, manifestSha256: await processorExtensionManifestSha256(manifest), source: reference,
    privileges: ['compute-local'], dependencies: [] };
  const sign = async (bytes: Uint8Array<ArrayBuffer>) => Buffer.from(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes)).toString('hex');
  const release = { ...unsigned, signature: await sign(processorExtensionSigningBytes(unsigned)) };
  const report = { schemaVersion: 1, suite: 'processor', scope: 'trusted-in-process', outcome: 'failed',
    checks: [{ id: 'manifest', status: 'failed' }], limits: { maxFixtureCases: 32, maxCallbacks: 256, maxResources: 128, asyncTimeoutMs: 1000 },
    limitations: ['Local deterministic fixtures; no physical-device or plugin-isolation certification.',
      'Trusted synchronous code cannot be preempted; memory and uninstrumented resources are not measured.'] };
  const submission = { schemaVersion: 1, profile: 'local-reviewed-processor-catalog/1', ownerId: 'catalog-owner', release,
    docs: { title: 'Temperature switch', instructions: 'Configure Celsius thresholds, then review resource access separately.', license: 'MIT' },
    provenance: { builderId: 'example:local-builder', builderVersion: '1.0.0', sourceRevision: '1'.repeat(64),
      sourceSha256: reference.sha256, buildSha256: '2'.repeat(64) },
    authorEvidence: { fixtureSha256: '3'.repeat(64), reportSha256: await api.catalogSha256(report), report } };
  return { keys, source, sign, submission: { ...submission, signature: await sign(api.catalogSubmissionSigningBytes(submission)) } };
}

test('catalog authenticates the actual release bytes and all authored metadata', async () => {
  const f = await fixture();
  assert.equal(await api!.verifyCatalogSubmission(f.submission, f.source, f.keys.publicKey), true);
  for (const changed of [
    { ...f.submission, docs: { ...f.submission.docs, instructions: 'Changed instructions' } },
    { ...f.submission, provenance: { ...f.submission.provenance, buildSha256: '4'.repeat(64) } },
    { ...f.submission, authorEvidence: { ...f.submission.authorEvidence, fixtureSha256: '5'.repeat(64) } },
  ]) assert.equal(await api!.verifyCatalogSubmission(changed, f.source, f.keys.publicKey), false);
  const altered = f.source.slice(); altered[0] = altered[0]! ^ 1;
  assert.equal(await api!.verifyCatalogSubmission(f.submission, altered, f.keys.publicKey), false);
});

test('catalog submission accepts inert author claims but rejects unknown authority and executable fields', async () => {
  const f = await fixture();
  const parsed = api!.parseCatalogSubmission(f.submission);
  assert.equal(parsed.authorEvidence.report.outcome, 'failed');
  assert.ok(Object.isFrozen(parsed.docs));
  for (const extra of [{ factory: () => {} }, { import: 'file:///private/secret' }, { grant: { allowed: true } }])
    assert.throws(() => api!.parseCatalogSubmission({ ...f.submission, ...extra }));
  let invoked = false;
  const getter = { ...f.submission };
  Object.defineProperty(getter, 'docs', { enumerable: true, get() { invoked = true; return f.submission.docs; } });
  assert.throws(() => api!.parseCatalogSubmission(getter)); assert.equal(invoked, false);
  assert.throws(() => api!.parseCatalogSubmission({ ...f.submission, docs: { ...f.submission.docs, instructions: 'x'.repeat(16_385) } }));
});

test('closed review scalars reject executable coercion without invoking package code', async () => {
  const f = await fixture(); let invoked = false;
  const report = f.submission.authorEvidence.report;
  const review = { schemaVersion: 1, profile: 'local-reviewed-processor-catalog/1', ownerId: 'catalog-owner',
    reviewerId: 'example:reviewer', packageId: manifest.id, version: manifest.version, sequence: 1, reviewedAt: 1000,
    decision: { toString() { invoked = true; return 'approved'; } }, submissionSha256: '1'.repeat(64),
    releaseSha256: '2'.repeat(64), sourceSha256: f.submission.release.source.sha256, docsSha256: '3'.repeat(64),
    provenanceSha256: '4'.repeat(64), fixtureSha256: '5'.repeat(64), reportSha256: f.submission.authorEvidence.reportSha256,
    report, signature: '0'.repeat(128) };
  assert.throws(() => api!.parseCatalogReviewAttestation(review)); assert.equal(invoked, false);
});

test('submission verification captures source bytes before asynchronous digest work', async () => {
  const f = await fixture(), mutable = f.source.slice();
  const pending = api!.verifyCatalogSubmission(f.submission, mutable, f.keys.publicKey); mutable.fill(0);
  assert.equal(await pending, true, 'verification uses its own original byte snapshot');
});
