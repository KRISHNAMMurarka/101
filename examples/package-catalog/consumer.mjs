import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPackageCatalog, createAssetReference, processorExtensionManifestSha256, processorExtensionSigningBytes,
  catalogSubmissionSigningBytes, catalogSubmissionSha256, catalogReviewSigningBytes, catalogReleaseSha256,
  catalogSha256, runProcessorConformance, LOCAL_PACKAGE_CATALOG_PROFILE } from '@101/connect';
import { createCatalogFilesystemStorage } from './filesystem-storage.mjs';

const OWNER = 'catalog-owner', PUBLISHER = 'example:publisher', REVIEWER = 'example:reviewer';
const vectors = { configuration: { onAt: 30, offAt: 28 }, invalidConfiguration: { onAt: 'bad', offAt: 28 },
  invalidInputs: { temperature: 'bad' }, cases: [{ inputs: { temperature: 30 }, outputs: { switch: true } },
    { inputs: { temperature: 29 } }, { inputs: { temperature: 28 }, outputs: { switch: false } }] };
const independentVectors = { ...vectors, cases: [...vectors.cases, { inputs: { temperature: -20 } }] };
const take = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const sign = async (key, bytes) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes)).toString('hex');
const importPublic = jwk => crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const importPrivate = jwk => jwk ? crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) : undefined;

/** Provisioning is host-owned ephemeral process input; catalog metadata never chooses a key or executable. */
export async function runPackageCatalogExample(directory, phase, provision) {
  const [publisherKey, reviewerKey, ownerKey, publisherSigner, reviewerSigner, ownerSigner] = await Promise.all([
    importPublic(provision.publisher.publicKey), importPublic(provision.reviewer.publicKey), importPublic(provision.owner.publicKey),
    importPrivate(provision.publisher.privateKey), importPrivate(provision.reviewer.privateKey), importPrivate(provision.owner.privateKey),
  ]);
  const source = new Uint8Array(readFileSync(new URL('../external-processor/processor.mjs', import.meta.url)));
  const manifest = JSON.parse(readFileSync(new URL('../external-processor/manifest.json', import.meta.url), 'utf8'));
  const storage = createCatalogFilesystemStorage(join(directory, 'store'));
  let granted = phase !== 'restart', reviewerCurrent = true, factoryCalls = 0, signerCalls = 0;
  const approvals = [], controllers = [];
  const options = role => ({ ownerId: OWNER, principalId: role === 'author' ? PUBLISHER : role === 'reviewer' ? REVIEWER : OWNER, role,
    storage, now: () => 1000,
    ownerTrust: () => ({ key: ownerKey, minimumRevision: provision.minimumRevision }),
    publisherTrust: id => id === PUBLISHER ? { key: publisherKey, minimumSequence: 1 } : undefined,
    reviewerTrust: id => id === REVIEWER && reviewerCurrent ? { key: reviewerKey, minimumSequence: 1 } : undefined,
    async signOwnerSnapshot(bytes) { signerCalls++; assert.ok(ownerSigner, 'this host phase has no signing credential'); return sign(ownerSigner, bytes); },
    authorize(scope) {
      approvals.push(scope.action);
      const identity = scope.ownerId === OWNER && scope.role === role &&
        scope.principalId === (role === 'author' ? PUBLISHER : role === 'reviewer' ? REVIEWER : OWNER);
      const writable = role === 'author' ? scope.action === 'submit' : role === 'reviewer' ? scope.action === 'review'
        : ['revoke', 'remove', 'supersede'].includes(scope.action);
      const readable = ['inspect', 'read-submission'].includes(scope.action);
      return granted && identity && (writable || readable) ? { expiresAt: 61_000, isCurrent: () => granted } : undefined;
    },
  });
  const create = role => { const value = createLocalPackageCatalog(options(role)); controllers.push(value); return value; };
  const owner = create('owner'), author = create('author'), reviewer = create('reviewer');
  const runIndependent = async (release, fixture) => {
    // Fixed reviewed host import. No submission field participates in module resolution.
    const { createTemperatureBand } = await import('../external-processor/processor.mjs');
    const report = await runProcessorConformance({ manifest: release.manifest, source, factory(configuration) {
      factoryCalls++; return createTemperatureBand(configuration);
    } }, fixture);
    assert.equal(report.outcome, 'passed'); return report;
  };
  try {
    if (phase === 'submit') {
      const reference = await createAssetReference('example:catalog-source', 'blob', source);
      assert.equal(reference.sha256, manifest.codeSha256, 'actual external producer source pin');
      const releasePayload = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: PUBLISHER,
        packageId: manifest.id, version: manifest.version, sequence: 1, abi: '101:processor/1', runtimeVersion: '0.1.0', manifest,
        manifestSha256: await processorExtensionManifestSha256(manifest), source: reference, privileges: ['compute-local'], dependencies: [] };
      const release = { ...releasePayload, signature: await sign(publisherSigner, processorExtensionSigningBytes(releasePayload)) };
      const report = await runIndependent(release, vectors);
      const payload = { schemaVersion: 1, profile: LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: OWNER, release,
        docs: { title: 'Temperature switch', instructions: 'Review Celsius thresholds. Request resource access separately when using this processor.', license: 'MIT' },
        provenance: { builderId: 'example:local-node', builderVersion: process.versions.node,
          sourceRevision: reference.sha256, sourceSha256: reference.sha256,
          buildSha256: await catalogSha256({ manifest, sourceSha256: reference.sha256 }) },
        authorEvidence: { fixtureSha256: await catalogSha256(vectors), reportSha256: await catalogSha256(report), report } };
      const submission = { ...payload, signature: await sign(publisherSigner, catalogSubmissionSigningBytes(payload)) };
      const callsBefore = factoryCalls;
      const snapshot = take(await author.submit(submission, source));
      assert.equal(take(await author.submit(submission, source)).revision, snapshot.revision);
      assert.equal(snapshot.packages[0].releases[0].status, 'submitted'); assert.equal(snapshot.packages[0].releases[0].available, false);
      assert.equal(factoryCalls, callsBefore, 'catalog submission invokes no package factory');
      assert.equal(signerCalls, 1, 'the committed owner snapshot is signed once');
      return { phase, revision: snapshot.revision, storageKey: author.key, authorTestsPassed: true,
        submittedWithoutApproval: true, inertSubmission: true, exactResubmissionIdempotent: true };
    }
    const snapshot = take(await owner.inspect()), entry = snapshot.packages[0].releases[0];
    if (phase === 'review') {
      const stored = take(await reviewer.readSubmission(snapshot.packages[0].packageId, entry.version)), submission = stored.submission;
      const report = await runIndependent(submission.release, independentVectors);
      const payload = { schemaVersion: 1, profile: LOCAL_PACKAGE_CATALOG_PROFILE, ownerId: OWNER, reviewerId: REVIEWER,
        packageId: submission.release.packageId, version: submission.release.version, sequence: 1, reviewedAt: 1000, decision: 'approved',
        submissionSha256: await catalogSubmissionSha256(submission), releaseSha256: await catalogReleaseSha256(submission.release),
        sourceSha256: submission.release.source.sha256, docsSha256: await catalogSha256(submission.docs),
        provenanceSha256: await catalogSha256(submission.provenance), fixtureSha256: await catalogSha256(independentVectors),
        reportSha256: await catalogSha256(report), report };
      assert.notEqual(payload.fixtureSha256, submission.authorEvidence.fixtureSha256, 'review expectations are separately authored');
      const attestation = { ...payload, signature: await sign(reviewerSigner, catalogReviewSigningBytes(payload)) };
      const callsBefore = factoryCalls;
      const reviewed = take(await reviewer.review(payload.packageId, payload.version, payload.submissionSha256, attestation));
      assert.equal(reviewed.packages[0].releases[0].status, 'approved'); assert.equal(reviewed.packages[0].releases[0].available, true);
      assert.equal(factoryCalls, callsBefore, 'catalog review consumes inert reviewer evidence');
      assert.equal(signerCalls, 1, 'the review snapshot has a current owner signature');
      return { phase, revision: reviewed.revision, independentlyExecuted: true, fixtureDistinctFromAuthor: true, approvedCurrentRecord: true };
    }
    if (phase === 'restart') throw new Error('restart must begin with denied fresh authority');
    assert.equal(phase, 'negatives');
    const stored = take(await owner.readSubmission(snapshot.packages[0].packageId, entry.version)), submission = stored.submission;
    const before = await storage.read(owner.key), file = join(directory, 'store', createHash('sha256').update(owner.key).digest('hex') + '.json');
    const { signature: unusedSubmissionSignature, ...unsignedSubmission } = submission; void unusedSubmissionSignature;
    const changed = { ...unsignedSubmission, docs: { ...submission.docs, instructions: 'Changed documentation under the same version' } };
    const signedChanged = { ...changed, signature: await sign(publisherSigner, catalogSubmissionSigningBytes(changed)) };
    assert.deepEqual(await author.submit(signedChanged, source), { ok: false, reason: 'duplicate-version' });
    assert.equal(await storage.read(owner.key), before);
    let attemptedExecution = 0;
    assert.equal((await author.submit({ ...submission, factory() { attemptedExecution++; } }, source)).ok, false);
    assert.equal(attemptedExecution, 0);
    const { signature: unusedReviewSignature, ...unsignedReview } = stored.attestation; void unusedReviewSignature;
    const forged = { ...unsignedReview, signature: await sign(publisherSigner, catalogReviewSigningBytes(unsignedReview)) };
    assert.deepEqual(await reviewer.review(unsignedReview.packageId, unsignedReview.version, unsignedReview.submissionSha256, forged),
      { ok: false, reason: 'integrity' });
    writeFileSync(file, before.replace('Temperature switch', 'Tampered title'), { mode: 0o600 });
    assert.equal((await owner.inspect()).ok, false);
    writeFileSync(file, provision.oldSnapshot, { mode: 0o600 });
    assert.deepEqual(await owner.inspect(), { ok: false, reason: 'rollback' });
    writeFileSync(file, before, { mode: 0o600 });
    reviewerCurrent = false; assert.equal(take(await owner.inspect()).packages[0].releases[0].available, false);
    assert.equal((await owner.readSubmission(submission.release.packageId, submission.release.version)).ok, false);
    reviewerCurrent = true;
    let release, reached;
    const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
    const reader = createLocalPackageCatalog({ ...options('owner'), authorize: async () => {
      reached(); await wait; return { expiresAt: 61_000, isCurrent: () => granted };
    } }); controllers.push(reader);
    const pending = reader.readSubmission(submission.release.packageId, submission.release.version); await ready;
    take(await owner.revoke(submission.release.packageId, submission.release.version)); release();
    assert.deepEqual(await pending, { ok: false, reason: 'conflict' });
    const removed = take(await owner.remove(submission.release.packageId));
    assert.equal(removed.packages[0].releases.length, 0); assert.equal(removed.packages[0].knownVersions, 1);
    assert.deepEqual(await author.submit(submission, source), { ok: false, reason: 'revoked' });
    assert.ok(!(await storage.read(owner.key)).includes(Buffer.from(source).toString('base64')), 'removal drops catalog source bytes');
    return { phase, revision: removed.revision, changedVersionConflict: true, forgedReviewerDenied: true,
      tamperDenied: true, provisionedFloorRollbackDenied: true, trustRevocationCurrent: true, staleReadDenied: true,
      executableMetadataRejected: true, removalDropsSourceKeepsTombstone: true };
  } finally { for (const controller of controllers) controller.close(); storage.close(); }
}

/** A fresh process receives public trust and an external floor, then needs fresh explicit read authority. */
export async function runPackageCatalogRestart(directory, provision) {
  const storage = createCatalogFilesystemStorage(join(directory, 'store'));
  const [ownerKey, publisherKey, reviewerKey] = await Promise.all([importPublic(provision.owner.publicKey),
    importPublic(provision.publisher.publicKey), importPublic(provision.reviewer.publicKey)]);
  let granted = false, requests = 0, signing = 0;
  const store = createLocalPackageCatalog({ ownerId: OWNER, principalId: OWNER, role: 'owner', storage, now: () => 1000,
    ownerTrust: () => ({ key: ownerKey, minimumRevision: provision.minimumRevision }),
    publisherTrust: id => id === PUBLISHER ? { key: publisherKey, minimumSequence: 1 } : undefined,
    reviewerTrust: id => id === REVIEWER ? { key: reviewerKey, minimumSequence: 1 } : undefined,
    signOwnerSnapshot() { signing++; throw Error('no restart signing credential'); },
    authorize(scope) { requests++; return granted && scope.ownerId === OWNER && scope.principalId === OWNER &&
      ['inspect', 'read-submission'].includes(scope.action) ? { expiresAt: 61_000, isCurrent: () => granted } : undefined; },
  });
  try {
    assert.deepEqual(await store.inspect(), { ok: false, reason: 'denied' });
    assert.equal(requests, 1); granted = true;
    const snapshot = take(await store.inspect()), item = snapshot.packages[0], entry = item.releases[0];
    assert.equal(entry.status, 'approved'); assert.equal(entry.available, true);
    const stored = take(await store.readSubmission(item.packageId, entry.version));
    assert.equal(stored.submission.release.source.sha256, entry.sourceSha256); assert.equal(signing, 0);
    const raw = await storage.read(store.key);
    for (const forbidden of ['"privateKey"', '"expiresAt"', '"isCurrent"', '"factory"']) assert.ok(!raw.includes(forbidden));
    return { phase: 'restart', revision: snapshot.revision, historicalReviewRestored: true, freshReadAuthorityRequired: true,
      noSigningCredentialSupplied: true, noSourceModuleImported: true, noGrantOrExecutableStateRestored: true };
  } finally { store.close(); storage.close(); }
}
