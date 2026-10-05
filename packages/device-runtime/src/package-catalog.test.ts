import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as model from '../../device-model/src/package-catalog.ts';
import { createAssetReference } from '../../device-model/src/resource.ts';
import { processorExtensionManifestSha256, processorExtensionSigningBytes } from '../../device-model/src/extension-release.ts';
import { createTemperatureBand } from '../../../examples/external-processor/processor.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === '@101/device-model' ? new URL('../../device-model/src/index.ts', import.meta.url).href : specifier, context);
} });
test.after(() => hooks.deregister());
const api = await import('./package-catalog.ts').catch(() => undefined);
const { runProcessorConformance } = await import('./conformance.ts');
const source = new Uint8Array(readFileSync(new URL('../../../examples/external-processor/processor.mjs', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../../../examples/external-processor/manifest.json', import.meta.url), 'utf8'));
const vectors = { configuration: { onAt: 30, offAt: 28 }, invalidConfiguration: { onAt: 'bad', offAt: 28 },
  invalidInputs: { temperature: 'bad' }, cases: [{ inputs: { temperature: 30 }, outputs: { switch: true } },
    { inputs: { temperature: 29 } }, { inputs: { temperature: 28 }, outputs: { switch: false } }] };
async function setup() {
  assert.ok(api, 'local catalog submission and independent review workflow is required');
  const keys = async () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const [publisher, reviewer, owner] = await Promise.all([keys(), keys(), keys()]);
  const sign = async (key: CryptoKey, bytes: Uint8Array<ArrayBuffer>) => Buffer.from(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, bytes)).toString('hex');
  const values = new Map<string, string>();
  let now = 1000, floor = 0, granted = true, publisherCurrent = true, reviewerCurrent = true;
  let publisherKey = publisher.publicKey, reviewerKey = reviewer.publicKey;
  let reviewerFloor = 1;
  const storage = {
    async read(key: string) { return values.get(key); },
    isCurrent(key: string, expected: string | undefined) { return values.get(key) === expected; },
    async compareAndSwap(key: string, expected: string | undefined, value: string, guard: { signal: AbortSignal; isCurrent(): boolean }) {
      if (values.get(key) !== expected || guard.signal.aborted || !guard.isCurrent() || guard.signal.aborted) return false;
      values.set(key, value); return true;
    },
  };
  const options = (role: 'author' | 'reviewer' | 'owner') => ({ ownerId: 'catalog-owner', role,
    principalId: role === 'author' ? 'example:publisher' : role === 'reviewer' ? 'example:reviewer' : 'catalog-owner', storage,
    now: () => now, ownerTrust: () => ({ key: owner.publicKey, minimumRevision: floor }),
    publisherTrust: (id: string) => id === 'example:publisher' && publisherCurrent ? { key: publisherKey, minimumSequence: 1 } : undefined,
    reviewerTrust: (id: string) => id === 'example:reviewer' && reviewerCurrent ? { key: reviewerKey, minimumSequence: reviewerFloor } : undefined,
    signOwnerSnapshot: (bytes: Uint8Array<ArrayBuffer>) => sign(owner.privateKey, bytes),
    authorize: () => granted ? { expiresAt: now + 60_000, isCurrent: () => granted } : undefined,
  });
  const author = api.createLocalPackageCatalog(options('author'));
  const review = api.createLocalPackageCatalog(options('reviewer'));
  const manage = api.createLocalPackageCatalog(options('owner'));
  const submission = async (version = '1.0.0', sequence = 1, docs = 'Review thresholds and request resource access separately.') => {
    const reference = await createAssetReference('example:catalog-source', 'blob', source);
    const manifest = { ...base, version, codeSha256: reference.sha256 };
    const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:publisher',
      packageId: manifest.id, version, sequence, abi: '101:processor/1', runtimeVersion: '0.1.0', manifest,
      manifestSha256: await processorExtensionManifestSha256(manifest), source: reference, privileges: ['compute-local'], dependencies: [] };
    const release = { ...unsigned, signature: await sign(publisher.privateKey, processorExtensionSigningBytes(unsigned)) };
    const report = await runProcessorConformance({ manifest, source, factory: createTemperatureBand }, vectors);
    assert.equal(report.outcome, 'passed');
    const payload = { schemaVersion: 1, profile: model.LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: 'catalog-owner', release,
      docs: { title: 'Temperature switch', instructions: docs, license: 'MIT' },
      provenance: { builderId: 'example:local-builder', builderVersion: '1.0.0', sourceRevision: '1'.repeat(64),
        sourceSha256: reference.sha256, buildSha256: '2'.repeat(64) },
      authorEvidence: { fixtureSha256: await model.catalogSha256(vectors), reportSha256: await model.catalogSha256(report), report } };
    return model.parseCatalogSubmission({ ...payload, signature: await sign(publisher.privateKey, model.catalogSubmissionSigningBytes(payload)) });
  };
  const attestation = async (s: model.CatalogSubmission, sequence = 1, decision: model.CatalogReviewDecision = 'approved') => {
    // Independently execute the exact reviewed fixed factory; do not reuse the author's report.
    const report = await runProcessorConformance({ manifest: s.release.manifest, source, factory: createTemperatureBand }, vectors);
    const payload = { schemaVersion: 1, profile: model.LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: 'catalog-owner',
      reviewerId: 'example:reviewer', packageId: s.release.packageId, version: s.release.version, sequence, reviewedAt: now, decision,
      submissionSha256: await model.catalogSubmissionSha256(s), releaseSha256: await model.catalogReleaseSha256(s.release),
      sourceSha256: s.release.source.sha256, docsSha256: await model.catalogSha256(s.docs), provenanceSha256: await model.catalogSha256(s.provenance),
      fixtureSha256: await model.catalogSha256(vectors), reportSha256: await model.catalogSha256(report), report };
    return model.parseCatalogReviewAttestation({ ...payload, signature: await sign(reviewer.privateKey, model.catalogReviewSigningBytes(payload)) });
  };
  return { author, review, manage, options, storage, values, submission, attestation, sign, publisher, reviewer, owner,
    setFloor(value: number) { floor = value; }, setNow(value: number) { now = value; }, setGranted(value: boolean) { granted = value; },
    revokePublisher() { publisherCurrent = false; }, revokeReviewer() { reviewerCurrent = false; },
    replaceReviewerKey(value: CryptoKey) { reviewerKey = value; }, replacePublisherKey(value: CryptoKey) { publisherKey = value; },
    setReviewerFloor(value: number) { reviewerFloor = value; } };
}
function take<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  assert.equal(result.ok, true, JSON.stringify(result)); return (result as { ok: true; value: T }).value;
}

test('genuine signed submission needs independent review and survives a fresh controller without executable authority', async () => {
  const s = await setup(), submission = await s.submission();
  const submitted = take(await s.author.submit(submission, source));
  assert.equal(submitted.packages[0]?.releases[0]?.status, 'submitted');
  const attestation = await s.attestation(submission);
  take(await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation));
  const inspected = take(await s.manage.inspect());
  assert.equal(inspected.packages[0]?.releases[0]?.status, 'approved');
  s.setFloor(inspected.revision); s.author.close(); s.review.close(); s.manage.close();
  const fresh = api!.createLocalPackageCatalog(s.options('owner'));
  const reloaded = take(await fresh.inspect());
  assert.equal(reloaded.packages[0]?.releases[0]?.status, 'approved');
  assert.deepEqual(take(await fresh.readSubmission(submission.release.packageId, submission.release.version)).source, source);
  const raw = [...s.values.values()][0]!;
  for (const forbidden of ['"expiresAt"', '"isCurrent"', '"factory"', '"privateKey"']) assert.ok(!raw.includes(forbidden));
  s.setGranted(false); assert.equal((await fresh.readSubmission(submission.release.packageId, submission.release.version)).ok, false);
});

test('author passing metadata and signatures cannot impersonate an independent reviewer', async () => {
  const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
  const attestation = await s.attestation(submission), { signature: unused, ...payload } = attestation; void unused;
  const forged = { ...payload, signature: await s.sign(s.publisher.privateKey, model.catalogReviewSigningBytes(payload)) };
  assert.equal((await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, forged)).ok, false);
  assert.equal((await s.author.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation)).ok, false);
  assert.equal(take(await s.manage.inspect()).packages[0]?.releases[0]?.status, 'submitted');
});

test('changed immutable versions and tampered or rolled back durable documents fail closed', async () => {
  const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
  const old = [...s.values.values()][0]!, key = [...s.values.keys()][0]!;
  assert.equal((await s.author.submit(await s.submission('1.0.0', 1, 'Different documentation'), source)).ok, false);
  const attestation = await s.attestation(submission);
  const approved = take(await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation));
  const current = s.values.get(key)!; s.setFloor(approved.revision);
  s.values.set(key, current.replace('Temperature switch', 'Tampered title'));
  assert.equal((await api!.createLocalPackageCatalog(s.options('owner')).inspect()).ok, false);
  s.values.set(key, old);
  const replay = await api!.createLocalPackageCatalog(s.options('owner')).inspect();
  assert.deepEqual(replay, { ok: false, reason: 'rollback' });
});

test('a source read awaiting approval cannot return bytes after another controller revokes the release', async () => {
  const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
  let release!: () => void, reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reader = api!.createLocalPackageCatalog({ ...s.options('owner'), authorize: async scope => {
    if (scope.action === 'read-submission') { reached(); await wait; }
    return { expiresAt: 61_000, isCurrent: () => true };
  } });
  const pending = reader.readSubmission(submission.release.packageId, submission.release.version); await ready;
  take(await s.manage.revoke(submission.release.packageId, submission.release.version)); release();
  assert.deepEqual(await pending, { ok: false, reason: 'conflict' });
});

test('current approved availability revalidates signatures after reviewer or publisher key rotation', async () => {
  for (const kind of ['reviewer', 'publisher'] as const) {
    const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
    const attestation = await s.attestation(submission);
    take(await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation));
    const replacement = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    if (kind === 'reviewer') s.replaceReviewerKey(replacement.publicKey); else s.replacePublisherKey(replacement.publicKey);
    const value = take(await s.manage.inspect());
    assert.equal(value.packages[0]?.releases[0]?.status, 'approved', 'historical review remains visible');
    assert.equal(value.packages[0]?.releases[0]?.available, false, 'old signatures cannot establish current approval');
  }
});

test('an initially empty inspection awaiting approval cannot hide another controller submission', async () => {
  const s = await setup(); let release!: () => void, reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const reader = api!.createLocalPackageCatalog({ ...s.options('owner'), authorize: async () => {
    reached(); await wait; return { expiresAt: 61_000, isCurrent: () => true };
  } });
  const pending = reader.inspect(); await ready;
  take(await s.author.submit(await s.submission(), source)); release();
  assert.deepEqual(await pending, { ok: false, reason: 'conflict' });
});

test('owner atomic filesystem port persists one exact revision and rejects competing or closed writers', async () => {
  const storageApi = await import('../../../examples/package-catalog/filesystem-storage.mjs').catch(() => undefined);
  assert.ok(storageApi, 'actual private filesystem catalog storage is required');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-catalog-storage-')));
  try {
    const first = storageApi.createCatalogFilesystemStorage(directory), second = storageApi.createCatalogFilesystemStorage(directory);
    const key = '101:package-catalog:catalog-owner', signal = new AbortController().signal;
    assert.equal(first.isCurrent(key, undefined), true);
    assert.equal(await first.compareAndSwap(key, undefined, 'first', { signal, isCurrent: () => true }), true);
    assert.equal(await second.compareAndSwap(key, undefined, 'second', { signal, isCurrent: () => true }), false);
    first.close(); assert.equal(await second.read(key), 'first');
    const guard = { signal, isCurrent() { second.close(); return true; } };
    assert.equal(await second.compareAndSwap(key, 'first', 'after-close', guard), false);
    const fresh = storageApi.createCatalogFilesystemStorage(directory); assert.equal(await fresh.read(key), 'first'); fresh.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reviewer revocation during awaited approval preserves the submitted document', async () => {
  const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
  const before = [...s.values.values()][0], attestation = await s.attestation(submission);
  const reviewer = api!.createLocalPackageCatalog({ ...s.options('reviewer'), authorize: async () => {
    await Promise.resolve(); s.revokeReviewer(); return { expiresAt: 61_000, isCurrent: () => true };
  } });
  assert.deepEqual(await reviewer.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation),
    { ok: false, reason: 'denied' });
  assert.equal([...s.values.values()][0], before);
});

test('a signer callback can cancel and reenter without storing a late submission', async () => {
  const s = await setup(), submission = await s.submission(); let nested: unknown;
  const author: ReturnType<NonNullable<typeof api>['createLocalPackageCatalog']> = api!.createLocalPackageCatalog({ ...s.options('author'), signOwnerSnapshot: async bytes => {
    nested = await author.inspect(); author.close(); return s.sign(s.owner.privateKey, bytes);
  } });
  assert.deepEqual(await author.submit(submission, source), { ok: false, reason: 'closed' });
  assert.deepEqual(nested, { ok: false, reason: 'busy' }); assert.equal(s.values.size, 0);
});

test('simultaneous owner controllers cannot overwrite a successful competing submission', async () => {
  const s = await setup(), first = await s.submission(); take(await s.author.submit(first, source));
  const [second, third] = await Promise.all([s.submission('1.1.0', 2), s.submission('1.2.0', 3)]);
  let arrived = 0, release!: () => void, ready!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { ready = resolve; });
  const options = { ...s.options('author'), authorize: async () => {
    if (++arrived === 2) ready(); await barrier; return { expiresAt: 61_000, isCurrent: () => true };
  } };
  const a = api!.createLocalPackageCatalog(options), b = api!.createLocalPackageCatalog(options);
  const results = Promise.all([a.submit(second, source), b.submit(third, source)]); await reached; release();
  const outcomes = await results;
  assert.equal(outcomes.filter(value => value.ok).length, 1);
  assert.deepEqual(outcomes.find(value => !value.ok), { ok: false, reason: 'conflict' });
  assert.equal(take(await s.manage.inspect()).packages[0]?.releases.length, 2);
});

test('explicit supersession, capacity and removal preserve immutable version history', async () => {
  const s = await setup(), first = await s.submission(), second = await s.submission('1.1.0', 2);
  for (const [index, submission] of [first, second].entries()) {
    take(await s.author.submit(submission, source)); const attestation = await s.attestation(submission, index + 1);
    take(await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation));
  }
  const before = [...s.values.values()][0];
  assert.deepEqual(await s.author.submit(await s.submission('1.2.0', 3), source), { ok: false, reason: 'capacity' });
  assert.equal([...s.values.values()][0], before);
  const value = take(await s.manage.supersede(first.release.packageId, first.release.version, second.release.version));
  assert.deepEqual(value.packages[0]?.releases.map(entry => [entry.status, entry.available]), [['superseded', false], ['approved', true]]);
  take(await s.manage.remove(first.release.packageId));
  assert.deepEqual(await s.author.submit(first, source), { ok: false, reason: 'revoked' });
  const removed = take(await s.manage.inspect()); assert.equal(removed.packages[0]?.knownVersions, 2); assert.equal(removed.packages[0]?.releases.length, 0);
});

test('invalid clock closes authority and an accessor approval cannot execute or commit', async () => {
  const s = await setup(); take(await s.manage.inspect()); s.setNow(NaN);
  assert.deepEqual(await s.manage.inspect(), { ok: false, reason: 'invalid-clock' });
  assert.deepEqual(await s.manage.inspect(), { ok: false, reason: 'closed' });
  const fresh = await setup(); let invoked = false;
  const grant = { expiresAt: 61_000, get isCurrent() { invoked = true; return () => true; } };
  const author = api!.createLocalPackageCatalog({ ...fresh.options('author'), authorize: () => grant });
  assert.equal((await author.submit(await fresh.submission(), source)).ok, false);
  assert.equal(invoked, false); assert.equal(fresh.values.size, 0);
});

test('late asynchronous storage completion observes cancellation after the bounded operation expires', async () => {
  const s = await setup(), submission = await s.submission(); let release!: () => void, reached!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reached = resolve; });
  const port = { ...s.storage, async compareAndSwap(...args: Parameters<typeof s.storage.compareAndSwap>) {
    reached(); await wait; return s.storage.compareAndSwap(...args);
  } };
  const author = api!.createLocalPackageCatalog({ ...s.options('author'), storage: port });
  const pending = author.submit(submission, source); await ready;
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(s.values.size, 0, 'a late port must consult the aborted commit guard');
});

test('an observed reviewer revocation floor cannot decrease within the same controller', async () => {
  const s = await setup(), submission = await s.submission(); take(await s.author.submit(submission, source));
  const attestation = await s.attestation(submission);
  take(await s.review.review(submission.release.packageId, submission.release.version, attestation.submissionSha256, attestation));
  s.setReviewerFloor(2); assert.equal(take(await s.manage.inspect()).packages[0]?.releases[0]?.available, false);
  s.setReviewerFloor(1); assert.equal(take(await s.manage.inspect()).packages[0]?.releases[0]?.available, false);
});
